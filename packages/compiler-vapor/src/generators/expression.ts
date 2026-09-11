import { getExpressionPosition } from '../optimizations/expressionLocation'
import { genPropsAccessExp, isGloballyAllowed, isString } from '@vue/shared'
import {
  BindingTypes,
  NewlineType,
  type SimpleExpressionNode,
  type SourceLocation,
  advancePositionWithClone,
  createSimpleExpression,
  isInDestructureAssignment,
  isStaticProperty,
  walkIdentifiers,
} from '@vue/compiler-dom'
import type {
  AssignmentExpression,
  Identifier,
  Node,
  UpdateExpression,
} from '@babel/types'
import type { CodegenContext } from '../generate'
import { getParserOptions, isConstantExpression } from '../utils'
import { parseExpression } from '@babel/parser'
import { type CodeFragment, NEWLINE, buildCodeFragment } from './utils'
import {
  type DeclarationValue,
  type ExpressionCachePlan,
  createExpressionCachePlan,
} from '../optimizations/cacheExpressions'

export function genExpression(
  node: SimpleExpressionNode,
  context: CodegenContext,
  assignment?: string,
): CodeFragment[] {
  node = context.getExpressionReplacement(node)
  const { content, ast, isStatic, loc } = node
  const { options } = context
  const { inline } = options

  if (isStatic) {
    return [[JSON.stringify(content), NewlineType.None, loc]]
  }

  if (
    !node.content.trim() ||
    // there was a parsing error
    ast === false ||
    isConstantExpression(node)
  ) {
    return [[content, NewlineType.None, loc], assignment && ` = ${assignment}`]
  }

  // the expression is a simple identifier
  if (ast === null) {
    return genIdentifier(content, context, loc, assignment)
  }

  const ids: Identifier[] = []
  const parentStackMap = new Map<Identifier, Node[]>()
  const parentStack: Node[] = []
  walkIdentifiers(
    ast!,
    id => {
      ids.push(id)
      parentStackMap.set(id, parentStack.slice())
    },
    false,
    parentStack,
  )

  let hasMemberExpression = false
  if (ids.length) {
    const [frag, push] = buildCodeFragment()
    let lastEnd = 0
    ids
      .sort((a, b) => a.start! - b.start!)
      .forEach(id => {
        // range is offset by -1 due to the wrapping parens when parsed
        const idStart = id.start! - 1
        const idEnd = id.end! - 1
        const source = content.slice(idStart, idEnd)
        const parentStack = parentStackMap.get(id)!
        const parent = parentStack[parentStack.length - 1]
        let start = idStart
        let end = idEnd

        if (
          inline &&
          options.bindingMetadata &&
          options.bindingMetadata[source] === BindingTypes.SETUP_LET &&
          parent &&
          parent.type === 'UpdateExpression' &&
          parent.argument === id
        ) {
          start = parent.start! - 1
          end = parent.end! - 1
        }

        if (start < lastEnd) return

        const leadingText = content.slice(lastEnd, start)
        if (leadingText.length) push([leadingText, NewlineType.Unknown])

        hasMemberExpression ||=
          parent &&
          (parent.type === 'MemberExpression' ||
            parent.type === 'OptionalMemberExpression')

        push(
          ...genIdentifier(
            source,
            context,
            {
              start: getExpressionPosition(node, source, start),
              end: getExpressionPosition(node, source, end),
              source,
            },
            hasMemberExpression ? undefined : assignment,
            id,
            parent,
            parentStack,
            node,
          ),
        )

        lastEnd = end
      })

    if (lastEnd < content.length) {
      push([content.slice(lastEnd), NewlineType.Unknown])
    }
    if (assignment && hasMemberExpression) {
      push(` = ${assignment}`)
    }
    return frag
  } else {
    return [[content, NewlineType.Unknown, loc]]
  }
}

function genIdentifier(
  raw: string,
  context: CodegenContext,
  loc?: SourceLocation,
  assignment?: string,
  id?: Identifier,
  parent?: Node,
  parentStack?: Node[],
  sourceNode?: SimpleExpressionNode,
): CodeFragment[] {
  const { options, helper, identifiers } = context
  const { inline, bindingMetadata } = options
  let name: string | undefined = raw

  const idMap = identifiers[raw]
  if (idMap && idMap.length) {
    const replacement = idMap[0]
    if (isString(replacement)) {
      if (parent && parent.type === 'ObjectProperty' && parent.shorthand) {
        return [[`${name}: ${replacement}`, NewlineType.None, loc]]
      } else {
        return [[replacement, NewlineType.None, loc]]
      }
    } else {
      // replacement is an expression - process it again
      return genExpression(replacement, context, assignment)
    }
  }

  let prefix: string | undefined
  const type = bindingMetadata && bindingMetadata[raw]
  // ({ x } = y)
  const isDestructureAssignment =
    parent && isInDestructureAssignment(parent, parentStack || [])
  // x = y
  const isAssignmentLVal =
    parent && parent.type === 'AssignmentExpression' && parent.left === id
  // x++
  const isUpdateArg =
    parent && parent.type === 'UpdateExpression' && parent.argument === id

  if (
    isStaticProperty(parent) &&
    parent.shorthand &&
    !(inline && type === BindingTypes.SETUP_LET && isDestructureAssignment)
  ) {
    // property shorthand like { foo }, we need to add the key since
    // we rewrite the value
    prefix = `${raw}: `
  }

  if (inline) {
    switch (type) {
      case BindingTypes.SETUP_LET:
        if (isAssignmentLVal) {
          const { right, operator } = parent as AssignmentExpression
          const source = sourceNode!
          const sourceContent = source.content
          const rightStart = right.start! - 1
          const rightEnd = right.end! - 1
          const rightContent = sourceContent.slice(rightStart, rightEnd)
          const rightExp = createSimpleExpression(rightContent, false, {
            start: advancePositionWithClone(
              source.loc.start,
              sourceContent,
              rightStart,
            ),
            end: advancePositionWithClone(
              source.loc.start,
              sourceContent,
              rightEnd,
            ),
            source: rightContent,
          })
          rightExp.ast = parseExpression(
            `(${rightContent})`,
            getParserOptions(options.expressionPlugins),
          )
          return [
            prefix,
            `${helper('isRef')}(${raw}) ? ${raw}.value ${operator} `,
            ...genExpression(rightExp, context),
            ` : `,
            [raw, NewlineType.None, loc, name],
          ]
        } else if (isUpdateArg) {
          const { prefix: isPrefix, operator } = parent as UpdateExpression
          const updatePrefix = isPrefix ? operator : ``
          const updatePostfix = isPrefix ? `` : operator
          raw = `${helper('isRef')}(${raw}) ? ${updatePrefix}${raw}.value${updatePostfix} : ${updatePrefix}${raw}${updatePostfix}`
        } else if (!isDestructureAssignment) {
          name = raw = assignment
            ? `${helper('isRef')}(${raw}) ? (${raw}.value = ${assignment}) : (${raw} = ${assignment})`
            : unref()
        }
        break
      case BindingTypes.SETUP_REF:
        name = raw = withAssignment(`${raw}.value`)
        break
      case BindingTypes.SETUP_MAYBE_REF:
        // const binding that may or may not be ref
        // if it's not a ref, then assignments don't make sense -
        // so we ignore the non-ref assignment case and generate code
        // that assumes the value to be a ref for more efficiency
        raw =
          isAssignmentLVal || isUpdateArg || isDestructureAssignment
            ? (name = `${raw}.value`)
            : assignment
              ? `${helper('isRef')}(${raw}) ? (${raw}.value = ${assignment}) : null`
              : unref()
        break
      case BindingTypes.PROPS:
        raw = genPropsAccessExp(raw)
        break
      case BindingTypes.PROPS_ALIASED:
        raw = genPropsAccessExp(bindingMetadata.__propsAliases![raw])
        break
      default:
        raw = withAssignment(raw)
    }
  } else {
    if (canPrefix(raw)) {
      if (type === BindingTypes.PROPS_ALIASED) {
        raw = `$props['${bindingMetadata.__propsAliases![raw]}']`
      } else {
        raw = `${type === BindingTypes.PROPS ? '$props' : '_ctx'}.${raw}`
      }
    }
    raw = withAssignment(raw)
  }
  return [prefix, [raw, NewlineType.None, loc, name]]

  function withAssignment(s: string) {
    return assignment ? `${s} = ${assignment}` : s
  }
  function unref() {
    return `${helper('unref')}(${raw})`
  }
}

function canPrefix(name: string) {
  // skip whitelisted globals
  if (isGloballyAllowed(name)) {
    return false
  }
  if (
    // special case for webpack compilation
    name === 'require' ||
    name === '$props' ||
    name === '$emit' ||
    name === '$attrs' ||
    name === '$slots'
  )
    return false
  return true
}

type ProcessedExpressionResult = {
  ids: Record<string, string>
  frag: CodeFragment[]
  varNames: string[]
  expressionReplacements: Map<SimpleExpressionNode, SimpleExpressionNode>
}
export function processExpressions(
  context: CodegenContext,
  expressions: SimpleExpressionNode[],
  shouldDeclare: boolean,
  planned?: ExpressionCachePlan,
): ProcessedExpressionResult {
  const plan =
    planned || createExpressionCachePlan(expressions, context.options)
  return {
    ...genDeclarations(plan.declarations, context, shouldDeclare),
    expressionReplacements: plan.expressionReplacements,
  }
}

function genDeclarations(
  declarations: DeclarationValue[],
  context: CodegenContext,
  shouldDeclare: boolean,
) {
  const [frag, push] = buildCodeFragment()
  const ids: Record<string, string> = Object.create(null)
  const varNames = new Set<string>()

  // process identifiers first as expressions may rely on them
  declarations.forEach(({ name, isIdentifier, value }) => {
    if (isIdentifier) {
      const varName = (ids[name] = context.getUniqueLocalName(
        `_${name}`,
        varNames,
      ))
      if (shouldDeclare) {
        push(`const `)
      }
      push(`${varName} = `, ...genExpression(value, context), NEWLINE)
    }
  })

  // process expressions
  declarations.forEach(({ name, isIdentifier, value }) => {
    if (!isIdentifier) {
      const varName = context.getUniqueLocalName(`_${name}`, varNames)
      if (shouldDeclare) {
        push(`const `)
      }
      push(
        `${varName} = `,
        ...context.withId(() => genExpression(value, context), ids),
        NEWLINE,
      )
      ids[name] = varName
    }
  })

  return { ids, frag, varNames: [...varNames] }
}
