import { type ExpressionEdit, mapExpressionEdits } from './expressionLocation'
import { NOOP, extend, isGloballyAllowed } from '@vue/shared'
import {
  type SimpleExpressionNode,
  createSimpleExpression,
  walkIdentifiers,
} from '@vue/compiler-dom'
import type { Identifier, Node } from '@babel/types'
import { parseExpression } from '@babel/parser'
import { genVarName, getParserOptions } from '../utils'
import type { OptimizationOptions } from '../optimize'
import type { BlockAnalysis } from './analysis'

export interface ExpressionCachePlan {
  declarations: DeclarationValue[]
  expressionReplacements: Map<SimpleExpressionNode, SimpleExpressionNode>
}

// Cache lifetimes follow the effect ranges emitted between insertion boundaries.
// Codegen may select a smaller range for v-for selectors; that range is analyzed
// at its use site so declarations never escape the effect that owns them.
export function planExpressionCaches(
  blocks: BlockAnalysis[],
  options: OptimizationOptions,
): void {
  for (const { block, boundaries, deferExpressionCache } of blocks) {
    // Keyed v-for selects effects during codegen. Avoid analyzing the full
    // range here only to discard it and analyze the selected range again.
    if (!block.effect.length || deferExpressionCache) continue
    const ends = new Set<number>([block.effect.length])
    for (const boundary of boundaries) {
      if (boundary.effectIndex) ends.add(boundary.effectIndex)
    }
    let start = 0
    for (const end of [...ends].sort((a, b) => a - b)) {
      const expressions = block.effect
        .slice(start, end)
        .flatMap(effect => effect.expressions)
      block.effect[start].expressionCache = {
        expressions,
        plan: createExpressionCachePlan(expressions, options),
      }
      start = end
    }
  }
}

export type DeclarationValue = {
  name: string
  isIdentifier?: boolean
  value: SimpleExpressionNode
  rawName?: string
  exps?: Set<SimpleExpressionNode>
  seenCount?: number
}
type SourceRange = {
  start: number
  end: number
}
type VariableUse = {
  name: string
  loc?: SourceRange
}
type ExpressionRecord = {
  variables: VariableUse[]
}
type ExpressionAnalysis = {
  seenVariable: Record<string, number>
  variableToExpMap: Map<string, Set<SimpleExpressionNode>>
  expressionRecords: Map<SimpleExpressionNode, ExpressionRecord>
  seenIdentifier: Set<string>
  updatedVariable: Set<string>
}
type SeenExpression = {
  count: number
  first: SimpleExpressionNode
}
type ContentReplacement = {
  start: number
  end: number
  content: string
}
type ReplacementPlan = Map<SimpleExpressionNode, ContentReplacement[]>

export function createExpressionCachePlan(
  expressions: SimpleExpressionNode[],
  options: OptimizationOptions,
): ExpressionCachePlan {
  const expressionReplacements = new Map<
    SimpleExpressionNode,
    SimpleExpressionNode
  >()
  // Simple identifiers cannot contain repeated subexpressions or writes.
  // Preserve declaration order without allocating AST usage records and ranges.
  if (expressions.every(exp => exp.ast === null && !exp.isStatic)) {
    const counts = new Map<string, number>()
    for (const exp of expressions)
      counts.set(exp.content, (counts.get(exp.content) || 0) + 1)
    const declarations: DeclarationValue[] = []
    for (const [name, count] of counts) {
      if (count > 1 && !isGloballyAllowed(name)) {
        declarations.push({
          name,
          isIdentifier: true,
          value: extend({ ast: null }, createSimpleExpression(name)),
        })
      }
    }
    return { declarations, expressionReplacements }
  }
  // analyze variables
  const {
    seenVariable,
    variableToExpMap,
    expressionRecords,
    seenIdentifier,
    updatedVariable,
  } = analyzeExpressions(expressions)
  const reservedNames = new Set<string>(seenIdentifier)

  // process repeated identifiers and member expressions
  // e.g., `foo[baz]` will be transformed into `foo_baz`
  const varDeclarations = processRepeatedVariables(
    options,
    seenVariable,
    variableToExpMap,
    expressionRecords,
    seenIdentifier,
    updatedVariable,
    reservedNames,
    expressionReplacements,
  )

  // process duplicate expressions after identifier and member expression handling.
  // e.g., `foo + bar` will be transformed into `foo_bar`
  const expDeclarations = processRepeatedExpressions(
    options,
    expressions,
    varDeclarations,
    updatedVariable,
    expressionRecords,
    reservedNames,
    expressionReplacements,
  )

  return {
    declarations: [...varDeclarations, ...expDeclarations],
    expressionReplacements,
  }
}

function analyzeExpressions(
  expressions: SimpleExpressionNode[],
): ExpressionAnalysis {
  const seenVariable: Record<string, number> = Object.create(null)
  const variableToExpMap = new Map<string, Set<SimpleExpressionNode>>()
  const expressionRecords = new Map<SimpleExpressionNode, ExpressionRecord>()
  const seenIdentifier = new Set<string>()
  const updatedVariable = new Set<string>()

  const getRecord = (exp: SimpleExpressionNode): ExpressionRecord => {
    let record = expressionRecords.get(exp)
    if (!record) {
      expressionRecords.set(exp, (record = { variables: [] }))
    }
    return record
  }

  const registerVariable = (
    name: string,
    exp: SimpleExpressionNode,
    isIdentifier: boolean,
    loc?: SourceRange,
    parentStack: Node[] = [],
  ) => {
    if (isIdentifier) seenIdentifier.add(name)
    seenVariable[name] = (seenVariable[name] || 0) + 1
    variableToExpMap.set(
      name,
      (variableToExpMap.get(name) || new Set()).add(exp),
    )

    getRecord(exp).variables.push({ name, loc })

    if (
      parentStack.some(
        p => p.type === 'UpdateExpression' || p.type === 'AssignmentExpression',
      )
    ) {
      updatedVariable.add(name)
    }
  }

  for (const exp of expressions) {
    if (!exp.ast) {
      exp.ast === null && registerVariable(exp.content, exp, true)
      continue
    }

    const seenParents = new Set<Node>()
    walkIdentifiers(exp.ast, (currentNode, parent, parentStack) => {
      if (parent && isMemberExpression(parent) && !seenParents.has(parent)) {
        seenParents.add(parent)
        let hasGlobalIdentifier = false
        const memberExp = extractMemberExpression(parent, id => {
          registerVariable(id.name, exp, true, {
            start: id.start!,
            end: id.end!,
          })
          if (isGloballyAllowed(id.name)) hasGlobalIdentifier = true
        })

        const parentOfMemberExp = parentStack[parentStack.length - 2]
        if (parentOfMemberExp && isCallExpression(parentOfMemberExp)) {
          return
        }

        // skip member expressions containing globally allowed identifiers
        // e.g. obj[Math.random()] - the call may have side effects
        if (hasGlobalIdentifier) return

        registerVariable(
          memberExp,
          exp,
          false,
          { start: parent.start!, end: parent.end! },
          parentStack,
        )
      } else if (!parentStack.some(isMemberExpression)) {
        registerVariable(
          currentNode.name,
          exp,
          true,
          { start: currentNode.start!, end: currentNode.end! },
          parentStack,
        )
      }
    })
  }

  return {
    seenVariable,
    seenIdentifier,
    variableToExpMap,
    expressionRecords,
    updatedVariable,
  }
}

function getProcessedExpression(
  exp: SimpleExpressionNode,
  expressionReplacements: Map<SimpleExpressionNode, SimpleExpressionNode>,
): SimpleExpressionNode {
  return expressionReplacements.get(exp) || exp
}

function setExpressionReplacement(
  expressionReplacements: Map<SimpleExpressionNode, SimpleExpressionNode>,
  exp: SimpleExpressionNode,
  content: string,
  ast: Node | null,
  edits: ExpressionEdit[],
): void {
  const original = getProcessedExpression(exp, expressionReplacements)
  const result = extend(
    { ast },
    createSimpleExpression(content, exp.isStatic, exp.loc, exp.constType),
  )
  mapExpressionEdits(original, result, edits)
  expressionReplacements.set(exp, result)
}

function processRepeatedVariables(
  options: OptimizationOptions,
  seenVariable: Record<string, number>,
  variableToExpMap: Map<string, Set<SimpleExpressionNode>>,
  expressionRecords: Map<SimpleExpressionNode, ExpressionRecord>,
  seenIdentifier: Set<string>,
  updatedVariable: Set<string>,
  reservedNames: Set<string>,
  expressionReplacements: Map<SimpleExpressionNode, SimpleExpressionNode>,
): DeclarationValue[] {
  const declarations: DeclarationValue[] = []
  const declaredNames = new Set<string>()
  const replacementPlan: ReplacementPlan = new Map()

  for (const [name, exps] of variableToExpMap) {
    if (updatedVariable.has(name)) continue
    // skip globally allowed identifiers - they are not reactive and
    // their method calls (e.g. Math.random()) may have side effects
    if (isGloballyAllowed(name)) continue
    if (seenVariable[name] > 1 && exps.size > 0) {
      const isIdentifier = seenIdentifier.has(name)
      const varName = isIdentifier
        ? name
        : getUniqueDeclarationName(genVarName(name), reservedNames)

      // replaces all non-identifiers with the new name. if node content
      // includes only one member expression, it will become an identifier,
      // e.g., foo[baz] -> foo_baz.
      // for identifiers, we don't need to replace the content - they will be
      // replaced during context.withId(..., ids)
      exps.forEach(node => {
        if (node.ast && varName !== name) {
          for (const variable of getExpressionVariables(
            expressionRecords,
            node,
          )) {
            if (variable.name === name && variable.loc) {
              queueContentReplacement(replacementPlan, node, {
                start: variable.loc.start - 1,
                end: variable.loc.end - 1,
                content: varName,
              })
            }
          }
        }
      })

      if (
        !declaredNames.has(varName) &&
        (!isIdentifier || shouldDeclareVariable(name, expressionRecords, exps))
      ) {
        declaredNames.add(varName)
        declarations.push({
          name: varName,
          isIdentifier,
          value: extend(
            { ast: isIdentifier ? null : parseExp(options, name) },
            createSimpleExpression(name),
          ),
          rawName: name,
          exps,
          seenCount: seenVariable[name],
        })
      }
    }
  }

  applyReplacementPlan(options, expressionReplacements, replacementPlan)

  return declarations
}

function shouldDeclareVariable(
  name: string,
  expressionRecords: Map<SimpleExpressionNode, ExpressionRecord>,
  exps: Set<SimpleExpressionNode>,
): boolean {
  const variableUsages: VariableUse[][] = []
  let allSingleVariable = true
  let hasRepeatedName = false
  let hasDifferentLength = false

  outer: for (const exp of exps) {
    const variables = getExpressionVariables(expressionRecords, exp)

    if (allSingleVariable && variables.length !== 1) {
      allSingleVariable = false
    }

    if (
      !hasDifferentLength &&
      variableUsages.length > 0 &&
      variables.length !== variableUsages[0].length
    ) {
      hasDifferentLength = true
    }

    let nameCount = 0
    for (const variable of variables) {
      if (variable.name === name && ++nameCount > 1) {
        hasRepeatedName = true
        break outer
      }
    }

    variableUsages.push(variables)
  }

  // assume name equals to `foo`
  // if each expression only references `foo`, declaration is needed
  // to avoid reactivity tracking
  // e.g., [[foo],[foo]]
  if (allSingleVariable) {
    return true
  }

  // if `foo` appears multiple times in one array, declaration is needed
  // e.g., [[foo,foo]]
  if (hasRepeatedName) {
    return true
  }

  const first = variableUsages[0]
  // if arrays have different lengths, declaration is needed
  // e.g., [[foo],[foo,bar]]
  if (hasDifferentLength) {
    // special case, no declaration needed if one array is a subset of the other
    // because they will be treated as repeated expressions
    // e.g., [[foo,bar],[foo,foo,bar]] -> const foo_bar = _ctx.foo + _ctx.bar
    for (const variables of variableUsages) {
      if (variables.length === first.length) {
        continue
      }

      const longer = variables.length > first.length ? variables : first
      const shorter = variables.length > first.length ? first : variables
      const shorterNames = new Set<string>()
      for (const variable of shorter) {
        shorterNames.add(variable.name)
      }

      let isSubset = true
      for (const variable of longer) {
        if (!shorterNames.has(variable.name)) {
          isSubset = false
          break
        }
      }
      if (isSubset) {
        return false
      }
    }
    return true
  }
  // if arrays are identical, no declaration needed
  // because they will be treated as repeated expressions
  // e.g., [[foo,bar],[foo,bar]] -> const foo_bar = _ctx.foo + _ctx.bar
  for (const variables of variableUsages) {
    for (let i = 0; i < variables.length; i++) {
      if (variables[i].name !== first[i].name) {
        return true
      }
    }
  }

  return false
}

function processRepeatedExpressions(
  options: OptimizationOptions,
  expressions: SimpleExpressionNode[],
  varDeclarations: DeclarationValue[],
  updatedVariable: Set<string>,
  expressionRecords: Map<SimpleExpressionNode, ExpressionRecord>,
  reservedNames: Set<string>,
  expressionReplacements: Map<SimpleExpressionNode, SimpleExpressionNode>,
): DeclarationValue[] {
  const declarations: DeclarationValue[] = []
  const seenExp = new Map<string, SeenExpression>()

  for (const exp of expressions) {
    const vars = expressionRecords.get(exp)?.variables
    if (!vars) continue

    const processed = getProcessedExpression(exp, expressionReplacements)
    if (canCacheExpression(processed, vars, updatedVariable)) {
      const seen = seenExp.get(processed.content)
      if (seen) {
        seen.count++
      } else {
        seenExp.set(processed.content, { count: 1, first: exp })
      }
    }
  }

  const repeatedExpressions = [...seenExp].sort(
    ([contentA], [contentB]) => contentB.length - contentA.length,
  )
  for (const [content, { count, first }] of repeatedExpressions) {
    if (count > 1) {
      // foo + baz -> foo_baz
      // if foo and baz have no other references, we don't need to declare separate variables
      // instead of:
      // const foo = _ctx.foo
      // const baz = _ctx.baz
      // const foo_baz = foo + baz
      // we can generate:
      // const foo_baz = _ctx.foo + _ctx.baz
      const removedDeclarations: Array<{ name: string; rawName: string }> = []
      for (let i = varDeclarations.length - 1; i >= 0; i--) {
        const item = varDeclarations[i]
        if (!item.exps || !item.seenCount) continue

        const shouldRemove = [...item.exps].every(
          node =>
            getProcessedExpression(node, expressionReplacements).content ===
              content && item.seenCount === count,
        )
        if (shouldRemove) {
          removedDeclarations.push({
            name: item.name,
            rawName: item.rawName!,
          })
          reservedNames.delete(item.name)
          varDeclarations.splice(i, 1)
        }
      }
      const value = extend(
        {},
        getProcessedExpression(first, expressionReplacements),
      )
      const restorePlan: ContentReplacement[] = []
      for (const { name, rawName } of removedDeclarations) {
        restorePlan.push(...findIdentifierReplacements(value, name, rawName))
      }
      if (restorePlan.length) {
        mapExpressionEdits(value, value, restorePlan)
        value.content = applyContentReplacements(value.content, restorePlan)
        if (value.ast) value.ast = parseExp(options, value.content)
      }
      const varName = getUniqueDeclarationName(
        genVarName(content),
        reservedNames,
      )
      declarations.push({
        name: varName,
        value,
      })

      // assume content equals to `foo + baz`
      for (const exp of expressions) {
        const processed = getProcessedExpression(exp, expressionReplacements)
        // foo + baz -> foo_baz
        if (processed.content === content) {
          setExpressionReplacement(expressionReplacements, exp, varName, null, [
            { start: 0, end: processed.content.length, content: varName },
          ])
        }
        // foo + foo + baz -> foo + foo_baz
        else if (processed.content.includes(content)) {
          const replacements = findContentReplacements(
            processed,
            content,
            varName,
          )
          if (replacements.length) {
            const replacedContent = applyContentReplacements(
              processed.content,
              replacements,
            )
            setExpressionReplacement(
              expressionReplacements,
              exp,
              replacedContent,
              parseExp(options, replacedContent),
              replacements,
            )
          }
        }
      }
    }
  }

  return declarations
}

function canCacheExpression(
  processed: SimpleExpressionNode,
  vars: VariableUse[],
  updatedVariable: Set<string>,
): boolean {
  if (!processed.ast || processed.ast.type === 'Identifier') {
    return false
  }

  for (const { name } of vars) {
    if (updatedVariable.has(name) || isGloballyAllowed(name)) {
      return false
    }
  }

  return true
}

function getExpressionVariables(
  expressionRecords: Map<SimpleExpressionNode, ExpressionRecord>,
  exp: SimpleExpressionNode,
): VariableUse[] {
  return expressionRecords.get(exp)?.variables || []
}

function queueContentReplacement(
  replacementPlan: ReplacementPlan,
  exp: SimpleExpressionNode,
  replacement: ContentReplacement,
): void {
  const replacements = replacementPlan.get(exp)
  if (replacements) {
    replacements.push(replacement)
  } else {
    replacementPlan.set(exp, [replacement])
  }
}

function applyReplacementPlan(
  options: OptimizationOptions,
  expressionReplacements: Map<SimpleExpressionNode, SimpleExpressionNode>,
  replacementPlan: ReplacementPlan,
): void {
  for (const [exp, replacements] of replacementPlan) {
    if (!replacements.length) continue

    const content = applyContentReplacements(
      getProcessedExpression(exp, expressionReplacements).content,
      replacements,
    )
    setExpressionReplacement(
      expressionReplacements,
      exp,
      content,
      parseExp(options, content),
      replacements,
    )
  }
}

function findContentReplacements(
  exp: SimpleExpressionNode,
  content: string,
  replacement: string,
): ContentReplacement[] {
  const identifiers = getIdentifierRanges(exp)
  if (!identifiers.length) return []

  const replacements: ContentReplacement[] = []
  let searchStart = 0
  let start = exp.content.indexOf(content, searchStart)
  while (start !== -1) {
    const end = start + content.length
    let canReplace = false
    for (const identifier of identifiers) {
      if (start >= identifier.end || end <= identifier.start) {
        continue
      }
      if (start > identifier.start || end < identifier.end) {
        canReplace = false
        break
      }
      canReplace = true
    }
    if (canReplace) {
      replacements.push({ start, end, content: replacement })
      searchStart = end
    } else {
      searchStart = start + 1
    }
    start = exp.content.indexOf(content, searchStart)
  }

  return replacements
}

function findIdentifierReplacements(
  exp: SimpleExpressionNode,
  name: string,
  replacement: string,
): ContentReplacement[] {
  const replacements: ContentReplacement[] = []
  for (const { start, end } of getIdentifierRanges(exp)) {
    if (exp.content.slice(start, end) === name) {
      replacements.push({ start, end, content: replacement })
    }
  }
  return replacements
}

function getIdentifierRanges(exp: SimpleExpressionNode): SourceRange[] {
  if (!exp.ast || typeof exp.ast !== 'object') return []

  const identifiers: SourceRange[] = []
  walkIdentifiers(
    exp.ast,
    id => {
      identifiers.push({ start: id.start! - 1, end: id.end! - 1 })
    },
    false,
  )
  return identifiers
}

function applyContentReplacements(
  content: string,
  replacements: ContentReplacement[],
): string {
  replacements
    .sort((a, b) => b.start - a.start)
    .forEach(({ start, end, content: replacement }) => {
      content = content.slice(0, start) + replacement + content.slice(end)
    })
  return content
}

function parseExp(options: OptimizationOptions, content: string): Node {
  return parseExpression(
    `(${content})`,
    getParserOptions(options.expressionPlugins),
  )
}

function getUniqueDeclarationName(
  baseName: string,
  reservedNames: Set<string>,
): string {
  const normalizedBase = baseName || 'exp'
  let name = normalizedBase
  let i = 1
  while (reservedNames.has(name)) {
    name = `${normalizedBase}_${i++}`
  }
  reservedNames.add(name)
  return name
}

function extractMemberExpression(
  exp: Node,
  onIdentifier: (id: Identifier) => void,
): string {
  if (!exp) return ''
  switch (exp.type) {
    case 'Identifier': // foo[bar]
      onIdentifier(exp)
      return exp.name
    case 'StringLiteral': // foo['bar']
      return exp.extra ? (exp.extra.raw as string) : exp.value
    case 'NumericLiteral': // foo[0]
      return exp.value.toString()
    case 'BinaryExpression': // foo[bar + 1]
      return `${extractMemberExpression(exp.left, onIdentifier)} ${exp.operator} ${extractMemberExpression(exp.right, onIdentifier)}`
    case 'CallExpression': // foo[bar(baz)]
      return `${extractMemberExpression(exp.callee, onIdentifier)}(${exp.arguments.map(arg => extractMemberExpression(arg, onIdentifier)).join(', ')})`
    case 'OptionalCallExpression': // foo[bar?.(baz)]
      return `${extractMemberExpression(exp.callee, onIdentifier)}?.(${exp.arguments.map(arg => extractMemberExpression(arg, onIdentifier)).join(', ')})`
    case 'MemberExpression': // foo[bar.baz]
    case 'OptionalMemberExpression': // foo?.bar
      const object = extractMemberExpression(exp.object, onIdentifier)
      const optional = exp.type === 'OptionalMemberExpression' && exp.optional
      const prop = exp.computed
        ? `${optional ? '?.' : ''}[${extractMemberExpression(exp.property, onIdentifier)}]`
        : `${optional ? '?.' : '.'}${extractMemberExpression(exp.property, NOOP)}`
      return `${object}${prop}`
    case 'TSNonNullExpression': // foo!.bar
      return `${extractMemberExpression(exp.expression, onIdentifier)}`
    default:
      return ''
  }
}

const isCallExpression = (node: Node) => {
  return (
    node.type === 'CallExpression' || node.type === 'OptionalCallExpression'
  )
}

const isMemberExpression = (node: Node) => {
  return (
    node.type === 'MemberExpression' ||
    node.type === 'OptionalMemberExpression' ||
    node.type === 'TSNonNullExpression'
  )
}
