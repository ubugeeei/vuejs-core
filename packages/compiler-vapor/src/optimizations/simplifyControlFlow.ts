import { type BlockIRNode, IRNodeTypes, type IfIRNode } from '../ir'
import { newBlock } from '../transforms/utils'
import type { BlockAnalysis } from './analysis'
import { getConstantValue } from './constantEvaluation'

export function simplifyControlFlow(blocks: BlockAnalysis[]): boolean {
  let changed = false
  for (const { operations } of blocks) {
    for (const operation of operations) {
      if (operation.type === IRNodeTypes.IF) visitIf(operation)
    }
  }
  return changed

  function visitIf(operation: IfIRNode): void {
    const value = getConstantValue(operation.condition)
    if (value !== undefined) {
      // Retain the createIf boundary, source index, branch shapes and once flag.
      // They determine hydration cursors and KeepAlive / Transition identity.
      if (!value && hasContent(operation.positive)) {
        operation.positive = newBlock(operation.positive.node)
        changed = true
      }
      if (value && operation.negative) {
        const negative = operation.negative
        if (negative.type === IRNodeTypes.IF || hasContent(negative)) {
          operation.negative = newBlock(
            negative.type === IRNodeTypes.IF
              ? negative.positive.node
              : negative.node,
          )
          changed = true
        }
        return
      }
    }
    if (operation.negative?.type === IRNodeTypes.IF) visitIf(operation.negative)
  }
}

function hasContent(block: BlockIRNode): boolean {
  return !!(
    block.operation.length ||
    block.effect.length ||
    block.returns.length ||
    block.dynamic.children.length
  )
}
