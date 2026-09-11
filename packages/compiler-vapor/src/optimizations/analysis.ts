import {
  type BlockIRNode,
  type IRDynamicInfo,
  IRNodeTypes,
  IRSlotType,
  type IRSlots,
  type InsertionStateTypes,
  type OperationNode,
  isBlockOperation,
} from '../ir'

export interface BlockAnalysis {
  block: BlockIRNode
  operations: Set<OperationNode>
  boundaries: InsertionStateTypes[]
  dynamics: IRDynamicInfo[]
}

export function collectBlocks(root: BlockIRNode): BlockAnalysis[] {
  const blocks = new Map<BlockIRNode, BlockAnalysis>()
  visitBlock(root)
  return [...blocks.values()]

  function visitBlock(block: BlockIRNode) {
    if (blocks.has(block)) return
    const data: BlockAnalysis = {
      block,
      operations: new Set(block.operation),
      boundaries: [],
      dynamics: [],
    }
    blocks.set(block, data)
    for (const effect of block.effect) {
      for (const operation of effect.operations) data.operations.add(operation)
    }
    visitDynamic(block.dynamic, data)
    for (const operation of data.operations) {
      if (isBlockOperation(operation)) data.boundaries.push(operation)
      visitOperation(operation)
    }
  }

  function visitDynamic(dynamic: IRDynamicInfo, data: BlockAnalysis) {
    data.dynamics.push(dynamic)
    if (dynamic.operation) data.operations.add(dynamic.operation)
    for (const child of dynamic.children) visitDynamic(child, data)
  }

  function visitOperation(operation: OperationNode) {
    switch (operation.type) {
      case IRNodeTypes.IF:
        visitBlock(operation.positive)
        if (operation.negative) {
          if (operation.negative.type === IRNodeTypes.IF) {
            visitOperation(operation.negative)
          } else visitBlock(operation.negative)
        }
        break
      case IRNodeTypes.FOR:
        visitBlock(operation.render)
        break
      case IRNodeTypes.KEY:
        visitBlock(operation.block)
        break
      case IRNodeTypes.SLOT_OUTLET_NODE:
        if (operation.fallback) visitBlock(operation.fallback)
        break
      case IRNodeTypes.CREATE_COMPONENT_NODE:
        operation.slots.forEach(visitSlot)
        break
    }
  }

  function visitSlot(slot: IRSlots) {
    switch (slot.slotType) {
      case IRSlotType.STATIC:
        Object.values(slot.slots).forEach(visitBlock)
        break
      case IRSlotType.DYNAMIC:
      case IRSlotType.LOOP:
        visitBlock(slot.fn)
        break
      case IRSlotType.CONDITIONAL:
        visitSlot(slot.positive)
        if (slot.negative) visitSlot(slot.negative)
        break
    }
  }
}
