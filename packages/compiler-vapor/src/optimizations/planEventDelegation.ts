import { IRNodeTypes, type OperationNode, type SetEventIRNode } from '../ir'
import type { BlockAnalysis } from './analysis'

// Eligibility remains the explicit .delegate contract established by v-on.
// Plan attachment once per block instead of searching all listeners per event.
export function planEventDelegation(blocks: BlockAnalysis[]): void {
  for (const { block } of blocks) {
    let groups: Map<string, SetEventIRNode[]> | undefined
    for (const operation of block.operation) {
      if (operation.type !== IRNodeTypes.SET_EVENT || !operation.delegate)
        continue
      groups ||= new Map()
      const key = `${operation.element}:${operation.key.content}`
      const group = groups.get(key)
      if (group) group.push(operation)
      else groups.set(key, [operation])
    }
    if (!groups) continue
    for (const group of groups.values()) {
      for (const operation of group)
        operation.delegateDirect = group.length === 1
    }
  }
}

export function isSingleDelegatedEvent(
  operation: SetEventIRNode,
  operations: OperationNode[],
): boolean {
  return !operations.some(
    other =>
      other.type === IRNodeTypes.SET_EVENT &&
      other !== operation &&
      other.delegate &&
      other.element === operation.element &&
      other.key.content === operation.key.content,
  )
}
