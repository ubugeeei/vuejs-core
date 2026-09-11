import type { CodegenContext } from '../generate'
import { DynamicFlag, type IRDynamicInfo, type IRTemplate } from '../ir'
import { TemplateFlags } from '@vue/shared'
import { genDirectivesForElement } from './directive'
import { genOperationWithInsertionState } from './operation'
import {
  canInlinePlaceholder,
  hasAdjacentFollowingAccessChild,
} from '../optimizations/planDomAccess'
import {
  type CodeFragment,
  type CodeFragments,
  IMPORT_EXPR_RE,
  NEWLINE,
  buildCodeFragment,
  genCall,
} from './utils'

export function genTemplates(
  templates: IRTemplate[],
  context: CodegenContext,
): string {
  const result: string[] = []
  templates.forEach(({ content, ns, root, static: isStatic }, i) => {
    let args = JSON.stringify(content).replace(
      // replace import expressions with string concatenation
      IMPORT_EXPR_RE,
      `" + $1 + "`,
    )

    const flags =
      (root ? TemplateFlags.ROOT : 0) | (isStatic ? TemplateFlags.STATIC : 0)
    if (flags || ns) {
      args += `, ${flags}`
    }

    if (ns) {
      args += `, ${ns}`
    }

    result.push(
      `const ${context.tName(i)} = ${context.helper('template')}(${args})\n`,
    )
  })
  return result.join('')
}

type FlushBeforeDynamic = (
  dynamic: IRDynamicInfo,
  push: (...items: CodeFragment[]) => number,
) => void

export function genSelf(
  dynamic: IRDynamicInfo,
  context: CodegenContext,
  flushBeforeDynamic?: FlushBeforeDynamic,
): CodeFragment[] {
  const [frag, push] = buildCodeFragment()
  const { id, template, operation, hasDynamicChild } = dynamic

  if (id !== undefined && template !== undefined) {
    push(NEWLINE, `const n${id} = ${context.tName(template)}()`)
    push(...genDirectivesForElement(id, context))
  }

  if (operation) {
    push(...genOperationWithInsertionState(operation, context))
  }

  if (hasDynamicChild) {
    push(...genChildren(dynamic, context, push, `n${id}`, flushBeforeDynamic))
  }

  return frag
}

export function genChildren(
  dynamic: IRDynamicInfo,
  context: CodegenContext,
  pushBlock: (...items: CodeFragment[]) => number,
  from: CodeFragments = `n${dynamic.id}`,
  flushBeforeDynamic?: FlushBeforeDynamic,
): CodeFragment[] {
  const [frag, push] = buildCodeFragment()
  const { children } = dynamic

  let offset = 0
  /**
   * `reusable` means the previous access target is a p* cursor that can be
   * reassigned by the next lookup. Referenced n* variables must stay stable.
   */
  let prev:
    | [variable: string, elementIndex: number, reusable: boolean]
    | undefined

  for (const [index, child] of children.entries()) {
    if (child.flags & DynamicFlag.NON_TEMPLATE) {
      offset--
    }

    if (child.flags & DynamicFlag.INSERT && child.template != null) {
      // template node due to invalid nesting; anchored inserts locate their
      // `<!>` placeholder first so INSERT_NODE can insert before it
      if (child.anchor !== undefined) {
        const elementIndex = index + offset
        const variable = `n${child.anchor}`
        pushBlock(
          NEWLINE,
          `const ${variable} = `,
          ...genAccessPath(context, from, elementIndex, prev),
        )
        prev = [variable, elementIndex, false]
      }
      flushBeforeDynamic && flushBeforeDynamic(child, push)
      push(...genSelf(child, context, flushBeforeDynamic))
      continue
    }

    const id =
      child.flags & DynamicFlag.REFERENCED
        ? child.flags & DynamicFlag.INSERT
          ? child.anchor
          : child.id
        : undefined
    // A child created by its own operation (component, block, createElement-
    // backed element) owns its subtree through genSelf; only children that
    // sit in the parent template are descended into from here.
    const ownsSubtree = child.operation !== undefined

    if (id === undefined && (!child.hasDynamicChild || ownsSubtree)) {
      flushBeforeDynamic && flushBeforeDynamic(child, push)
      push(...genSelf(child, context, flushBeforeDynamic))
      continue
    }

    const elementIndex = index + offset
    const inlinePlaceholder =
      id === undefined &&
      canInlinePlaceholder(child) &&
      child.template == null &&
      child.operation === undefined &&
      !(child.flags & (DynamicFlag.INSERT | DynamicFlag.NON_TEMPLATE))
    const accessPath = genAccessPath(context, from, elementIndex, prev)

    if (inlinePlaceholder) {
      if (prev && prev[2]) {
        push(
          ...genChildren(
            child,
            context,
            pushBlock,
            ['(', prev[0], ' = ', ...accessPath, ')'],
            flushBeforeDynamic,
          ),
        )
        prev = [prev[0], elementIndex, true]
        continue
      }

      if (
        !hasAdjacentFollowingAccessChild(children, index, elementIndex, offset)
      ) {
        push(
          ...genChildren(
            child,
            context,
            pushBlock,
            accessPath,
            flushBeforeDynamic,
          ),
        )
        continue
      }
    }

    let variable: string
    if (id === undefined && prev && prev[2]) {
      variable = prev[0]
      pushBlock(NEWLINE, `${variable} = `, ...accessPath)
    } else {
      // p for "placeholder" variables that are meant for possible reuse by
      // other access paths
      variable =
        id === undefined ? context.pName(context.block.tempId++) : `n${id}`
      pushBlock(
        NEWLINE,
        id === undefined ? `let ${variable} = ` : `const ${variable} = `,
        ...accessPath,
      )
    }

    if (id === child.anchor && (!child.hasDynamicChild || ownsSubtree)) {
      flushBeforeDynamic && flushBeforeDynamic(child, push)
      push(...genSelf(child, context, flushBeforeDynamic))
    }

    if (id !== undefined) {
      push(...genDirectivesForElement(id, context))
    }

    prev = [variable, elementIndex, id === undefined]
    if (!ownsSubtree) {
      push(
        ...genChildren(child, context, pushBlock, variable, flushBeforeDynamic),
      )
    }
  }

  return frag
}

/**
 * Build one DOM lookup path while preserving the fast sibling walk:
 * adjacent nodes use _next(prev), otherwise fall back to _nthChild(parent).
 */
function genAccessPath(
  { helper }: CodegenContext,
  from: CodeFragments,
  elementIndex: number,
  prev: [variable: string, elementIndex: number, reusable: boolean] | undefined,
): CodeFragment[] {
  if (prev) {
    return elementIndex - prev[1] === 1
      ? genCall(helper('next'), prev[0])
      : genCall(helper('nthChild'), from, String(elementIndex))
  }

  if (elementIndex === 0) {
    return genCall(helper('child'), from)
  }

  // adjacent to the first child: chain off it instead of an indexed lookup
  if (elementIndex === 1) {
    const firstChild = genCall(helper('child'), from)
    return genCall(helper('next'), firstChild)
  }
  return genCall(helper('nthChild'), from, String(elementIndex))
}
