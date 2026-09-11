import { DynamicFlag, type IRDynamicInfo } from '../ir'
import type { BlockAnalysis } from './analysis'

// Children are analyzed before parents. Each subtree and sibling range is
// counted once, rather than recursively re-counted from every access site.
export function planDomAccess(blocks: BlockAnalysis[]): void {
  for (const { dynamics } of blocks) {
    for (let i = dynamics.length - 1; i >= 0; i--) {
      const dynamic = dynamics[i]
      let offset = 0
      const indices = dynamic.children.map((child, index) => {
        if (child.flags & DynamicFlag.NON_TEMPLATE) offset--
        return index + offset
      })
      let next: number | undefined
      for (let j = dynamic.children.length - 1; j >= 0; j--) {
        const child = dynamic.children[j]
        child.domAccess!.adjacent =
          next !== undefined && next - indices[j] === 1
        if (child.flags & DynamicFlag.INSERT && child.anchor === undefined)
          continue
        if (child.flags & DynamicFlag.REFERENCED || child.hasDynamicChild)
          next = indices[j]
      }
      dynamic.domAccess = {
        inline:
          dynamic.hasDynamicChild === true &&
          countParentAccessUsages(dynamic) === 1,
      }
    }
  }
}

/**
 * Only inline a placeholder when materializing it would not save a parent
 * lookup. If its child tree needs the parent more than once, keep p* so the
 * generated code does not duplicate _child/_nthChild work.
 */
export function canInlinePlaceholder(dynamic: IRDynamicInfo): boolean {
  return (
    dynamic.domAccess?.inline ??
    (dynamic.hasDynamicChild === true && countParentAccessUsages(dynamic) === 1)
  )
}

/**
 * A following access can reuse the current placeholder cursor only when it is
 * the next DOM sibling. Gapped siblings need _nthChild(parent, index) instead.
 * Kept in lockstep with genChildren's traversal rules.
 */
export function hasAdjacentFollowingAccessChild(
  children: IRDynamicInfo[],
  index: number,
  elementIndex: number,
  offset: number,
): boolean {
  const adjacent = children[index].domAccess?.adjacent
  if (adjacent !== undefined) return adjacent
  let futureOffset = offset
  for (let i = index + 1; i < children.length; i++) {
    const child = children[i]
    if (child.flags & DynamicFlag.NON_TEMPLATE) {
      futureOffset--
    }
    // appends produce no access and occupy no element slot; anchored inserts
    // locate their `<!>` placeholder and always carry REFERENCED
    if (child.flags & DynamicFlag.INSERT && child.anchor === undefined) {
      continue
    }
    if (!!(child.flags & DynamicFlag.REFERENCED) || child.hasDynamicChild) {
      return i + futureOffset - elementIndex === 1
    }
  }

  return false
}

/**
 * Mirrors genChildren's traversal closely enough to count how many emitted
 * access paths would start from this placeholder's parent. This is the guard
 * that keeps inline placeholders from duplicating parent lookups.
 */
function countParentAccessUsages(dynamic: IRDynamicInfo): number {
  let usages = 0
  let offset = 0
  let prev: [elementIndex: number, reusable: boolean] | undefined

  for (const [index, child] of dynamic.children.entries()) {
    if (child.flags & DynamicFlag.NON_TEMPLATE) {
      offset--
    }

    if (
      child.flags & DynamicFlag.INSERT &&
      child.template != null &&
      child.anchor === undefined
    ) {
      // trailing template-inserts append without locating anything; anchored
      // ones fall through to the generic path, which resolves their id to
      // `child.anchor` exactly like genChildren does
      continue
    }

    const id =
      child.flags & DynamicFlag.REFERENCED
        ? child.flags & DynamicFlag.INSERT
          ? child.anchor
          : child.id
        : undefined

    if (id === undefined && !child.hasDynamicChild) {
      continue
    }

    const elementIndex = index + offset
    const usesParent = !prev || elementIndex - prev[0] !== 1
    const inlinePlaceholder =
      id === undefined &&
      canInlinePlaceholder(child) &&
      child.template == null &&
      child.operation === undefined &&
      !(child.flags & (DynamicFlag.INSERT | DynamicFlag.NON_TEMPLATE))

    if (inlinePlaceholder) {
      if (prev && prev[1]) {
        if (usesParent) usages++
        prev = [elementIndex, true]
        continue
      }

      if (
        !hasAdjacentFollowingAccessChild(
          dynamic.children,
          index,
          elementIndex,
          offset,
        )
      ) {
        if (usesParent) usages++
        continue
      }
    }

    if (usesParent) usages++
    prev = [elementIndex, id === undefined]
  }

  return usages
}
