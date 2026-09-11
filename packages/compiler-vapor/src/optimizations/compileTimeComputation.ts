import { createSimpleExpression, unwrapTSNode } from '@vue/compiler-dom'
import type { Node } from '@babel/types'
import { escapeHtml } from '@vue/shared'
import {
  type BlockIRNode,
  DynamicFlag,
  type IRDynamicInfo,
  IRNodeTypes,
  IRSlotType,
  type IRSlots,
  type IRTemplate,
  type OperationNode,
  type RootIRNode,
  isBlockOperation,
} from '../ir'
import { getLiteralExpressionValue } from '../utils'

interface TemplateLocation {
  dynamic: IRDynamicInfo
  owner: IRDynamicInfo
  offset: number
  parentOffset: number
}

interface TemplateEdit {
  offset: number
  length: number
  content: string
  delta?: number
}

// The first computation rule consumes SET_TEXT operands. Other consumers need
// their own serialization rules: a numeric prop must remain a number, for example.
export function compileTimeComputation(ir: RootIRNode): void {
  const blocks = collectBlocks(ir.block)
  const locations = new Map<number, TemplateLocation>()
  const templates = new Map<IRDynamicInfo, TemplateEdit[]>()
  const allLocations: TemplateLocation[] = []
  const removed = new Set<OperationNode>()
  const candidates = new Set<number>()

  for (const block of blocks) locate(block.dynamic)

  for (const block of blocks) {
    for (const operation of block.operation) fold(operation, true)
    for (const effect of block.effect) {
      for (const operation of effect.operations) fold(operation, false)
    }
  }

  if (!removed.size) return

  // Operation boundaries are prefix lengths, so removing an earlier text write
  // must also move the boundary of a later component or structural block.
  for (const block of blocks) {
    const textChildren = new Set<number>()
    for (const op of block.operation) {
      if (removed.has(op) && op.type === IRNodeTypes.SET_TEXT && op.generated) {
        textChildren.add(op.element)
      }
    }
    for (const op of blockOperations(block)) {
      if (
        !removed.has(op) &&
        op.type === IRNodeTypes.SET_TEXT &&
        op.generated
      ) {
        textChildren.delete(op.element)
      }
    }
    for (const operation of block.operation) {
      if (
        operation.type === IRNodeTypes.GET_TEXT_CHILD &&
        textChildren.has(operation.parent)
      ) {
        removed.add(operation)
      }
    }
    const prefix = [0]
    for (const operation of block.operation) {
      prefix.push(prefix[prefix.length - 1] + (removed.has(operation) ? 0 : 1))
    }
    for (const operation of blockOperations(block)) {
      if (
        isBlockOperation(operation) &&
        operation.operationIndex !== undefined
      ) {
        operation.operationIndex = prefix[operation.operationIndex]
      }
    }
    block.operation = block.operation.filter(op => !removed.has(op))
  }

  // Several template instances may share one registry entry before folding.
  // Specialize each instance, then deduplicate using the complete template key.
  const entries: IRTemplate[] = []
  const indices = new Map<string, number>()
  const owners = new Map<number, IRDynamicInfo[]>()
  for (const owner of templates.keys()) {
    const index = owner.template!
    const group = owners.get(index)
    if (group) group.push(owner)
    else owners.set(index, [owner])
  }
  ir.template.entries.forEach((entry, index) => {
    const group = owners.get(index)
    if (!group) {
      intern(entry)
      return
    }
    for (const owner of group) {
      const edits = templates.get(owner)!.sort((a, b) => a.offset - b.offset)
      const chunks: string[] = []
      let cursor = 0
      let delta = 0
      for (const edit of edits) {
        chunks.push(entry.content.slice(cursor, edit.offset), edit.content)
        cursor = edit.offset + edit.length
        edit.delta = delta += edit.content.length - edit.length
      }
      chunks.push(entry.content.slice(cursor))
      owner.template = intern({ ...entry, content: chunks.join('') })
    }
  })
  ir.template.entries = entries

  for (const location of allLocations) {
    const { dynamic, owner, offset, parentOffset } = location
    const edits = templates.get(owner)!
    if (dynamic !== owner && dynamic.templateOffset !== undefined) {
      dynamic.templateOffset +=
        getShift(edits, offset) - getShift(edits, parentOffset)
    }
    if (dynamic.textContentOffset !== undefined) {
      dynamic.textContentOffset +=
        getShift(edits, offset + dynamic.textContentOffset) -
        getShift(edits, offset)
    }
  }

  // Keep references needed by props, events, insertions and returned roots.
  const references = new Set<number>()
  for (const block of blocks) {
    for (const id of block.returns) references.add(id)
    for (const op of blockOperations(block)) {
      if ('element' in op) references.add(op.element)
      if ('id' in op) references.add(op.id)
      if ('elements' in op) op.elements.forEach(id => references.add(id))
      if ('parent' in op && op.parent !== undefined) references.add(op.parent)
      if ('anchor' in op && op.anchor !== undefined) references.add(op.anchor)
    }
  }
  for (const id of candidates) {
    const dynamic = locations.get(id)!.dynamic
    if (!references.has(id)) dynamic.flags &= ~DynamicFlag.REFERENCED
  }
  for (const block of blocks) pruneReferences(block.dynamic)

  function locate(dynamic: IRDynamicInfo, parent?: TemplateLocation): void {
    let location: TemplateLocation | undefined
    if (dynamic.template !== undefined) {
      templates.set(dynamic, [])
      location = { dynamic, owner: dynamic, offset: 0, parentOffset: 0 }
    } else if (parent && dynamic.templateOffset !== undefined) {
      location = {
        dynamic,
        owner: parent.owner,
        offset: parent.offset + dynamic.templateOffset,
        parentOffset: parent.offset,
      }
    }
    if (location) {
      allLocations.push(location)
      if (dynamic.id !== undefined) locations.set(dynamic.id, location)
    }
    for (const child of dynamic.children) locate(child, location)
  }

  function fold(operation: OperationNode, inline: boolean) {
    if (operation.type !== IRNodeTypes.SET_TEXT) return
    let computed = false
    operation.values = operation.values.map(exp => {
      if (!exp.ast || getLiteralExpressionValue(exp) !== null) return exp
      const value = evaluateConstant(exp.ast)
      // HTML parsing normalizes CR/NUL and strips a leading LF in pre/textarea.
      if (value === undefined || /[\r\n\0]/.test(String(value))) return exp
      computed = true
      return createSimpleExpression(String(value), true, exp.loc)
    })
    if (!computed || !inline) return
    const values = operation.values.map(value =>
      getLiteralExpressionValue(value),
    )
    if (values.some(value => value === null)) return
    const text = values.join('')
    if (/[\r\n\0]/.test(text)) return
    const location = locations.get(operation.element)
    if (!location) return
    const { dynamic, owner, offset } = location
    let edit: TemplateEdit
    if (operation.generated) {
      if (dynamic.textContentOffset === undefined) return
      edit = {
        offset: offset + dynamic.textContentOffset,
        length: 1,
        content: escapeHtml(text),
      }
    } else if (dynamic === owner) {
      // Empty text must remain a node, and a leading '<' selects HTML parsing
      // in the template factory. Preserve the imperative write in both cases.
      if (!text || text[0] === '<') return
      edit = {
        offset: 0,
        length: ir.template.entries[owner.template!].content.length,
        content: text,
      }
    } else {
      // Removing an empty text node would change sibling and hydration indices.
      if (!text) return
      edit = { offset, length: 1, content: escapeHtml(text) }
    }
    templates.get(owner)!.push(edit)
    removed.add(operation)
    candidates.add(operation.element)
  }

  function intern(entry: IRTemplate): number {
    const key = JSON.stringify([
      entry.ns,
      entry.root,
      entry.static,
      entry.content,
    ])
    let index = indices.get(key)
    if (index === undefined) {
      indices.set(key, (index = entries.length))
      entries.push(entry)
    }
    return index
  }
}

function getShift(edits: TemplateEdit[], position: number): number {
  let low = 0
  let high = edits.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (edits[mid].offset < position) low = mid + 1
    else high = mid
  }
  return low ? edits[low - 1].delta! : 0
}

function pruneReferences(dynamic: IRDynamicInfo): void {
  for (const child of dynamic.children) pruneReferences(child)
  if (dynamic.hasDynamicChild) {
    dynamic.hasDynamicChild = dynamic.children.some(
      child =>
        child.flags & (DynamicFlag.REFERENCED | DynamicFlag.INSERT) ||
        child.template !== undefined ||
        child.operation !== undefined ||
        child.hasDynamicChild,
    )
  }
}

function blockOperations(block: BlockIRNode): Set<OperationNode> {
  const operations = new Set(block.operation)
  for (const effect of block.effect) {
    for (const operation of effect.operations) operations.add(operation)
  }
  visit(block.dynamic)
  return operations

  function visit(dynamic: IRDynamicInfo) {
    if (dynamic.operation) operations.add(dynamic.operation)
    for (const child of dynamic.children) visit(child)
  }
}

function collectBlocks(root: BlockIRNode): BlockIRNode[] {
  const blocks = new Set<BlockIRNode>()
  visitBlock(root)
  return [...blocks]

  function visitBlock(block: BlockIRNode) {
    if (blocks.has(block)) return
    blocks.add(block)
    for (const operation of blockOperations(block)) visitOperation(operation)
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

function evaluateConstant(node: Node): string | number | undefined {
  node = unwrapTSNode(node)
  switch (node.type) {
    case 'StringLiteral':
      return node.value
    case 'NumericLiteral':
      return Number.isFinite(node.value) ? node.value : undefined
    case 'ParenthesizedExpression':
      return evaluateConstant(node.expression)
    case 'UnaryExpression': {
      const value = evaluateConstant(node.argument)
      if (typeof value !== 'number') return
      switch (node.operator) {
        case '+':
          return value
        case '-':
          return -value
      }
      return
    }
    case 'BinaryExpression': {
      const left = evaluateConstant(node.left)
      const right = evaluateConstant(node.right)
      if (left === undefined || right === undefined) return
      if (
        node.operator === '+' &&
        (typeof left === 'string' || typeof right === 'string')
      ) {
        return String(left) + String(right)
      }
      if (typeof left !== 'number' || typeof right !== 'number') return
      let value: number
      switch (node.operator) {
        case '+':
          value = left + right
          break
        case '-':
          value = left - right
          break
        case '*':
          value = left * right
          break
        case '/':
          value = left / right
          break
        case '%':
          value = left % right
          break
        default:
          // Exponentiation is implementation-approximated across JS engines.
          return
      }
      if (Number.isFinite(value)) return value
    }
  }
}
