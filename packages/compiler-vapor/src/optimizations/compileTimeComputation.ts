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
  type InsertionStateTypes,
  type OperationNode,
  type RootIRNode,
  type SetTextIRNode,
  isBlockOperation,
} from '../ir'
import { getLiteralExpressionValue } from '../utils'

interface TemplateEdit {
  offset: number
  length: number
  content: string
  delta?: number
}

interface TemplatePlan {
  dynamic: IRDynamicInfo
  edits: TemplateEdit[]
}

interface BlockData {
  block: BlockIRNode
  operations: Set<OperationNode>
  boundaries: InsertionStateTypes[]
  texts: Map<number, { operation: SetTextIRNode; text: string }>
  changed: boolean
}

// The first computation rule consumes SET_TEXT operands. Other consumers need
// their own serialization rules: a numeric prop must remain a number, for example.
export function compileTimeComputation(ir: RootIRNode): void {
  const blocks = collectBlocks(ir.block)
  let hasStaticText = false
  for (const { block, texts } of blocks) {
    for (const operation of block.operation) {
      if (operation.type !== IRNodeTypes.SET_TEXT) continue
      const text = computeText(operation)
      if (text !== undefined) {
        texts.set(operation.element, { operation, text })
        hasStaticText = true
      }
    }
    for (const effect of block.effect) {
      for (const operation of effect.operations) {
        if (operation.type === IRNodeTypes.SET_TEXT) computeText(operation)
      }
    }
  }
  // Most templates have no computable text. Avoid indexing templates and DOM
  // positions until a computation can actually remove a text operation.
  if (!hasStaticText) return

  const templates = new Map<number, TemplatePlan[]>()
  const plans = new Map<IRDynamicInfo, TemplatePlan>()
  const removed = new Set<OperationNode>()
  const candidates = new Set<number>()
  for (const data of blocks) planTemplate(data.block.dynamic, data)
  if (!removed.size) return

  const references = new Set<number>()
  for (const { block, operations, boundaries, changed } of blocks) {
    if (changed) {
      const textChildren = new Set<number>()
      for (const op of block.operation) {
        if (
          removed.has(op) &&
          op.type === IRNodeTypes.SET_TEXT &&
          op.generated
        ) {
          textChildren.add(op.element)
        }
      }
      for (const op of operations) {
        if (
          !removed.has(op) &&
          op.type === IRNodeTypes.SET_TEXT &&
          op.generated
        ) {
          textChildren.delete(op.element)
        }
      }
      for (const op of block.operation) {
        if (
          op.type === IRNodeTypes.GET_TEXT_CHILD &&
          textChildren.has(op.parent)
        ) {
          removed.add(op)
        }
      }
      // Boundaries are operation prefix lengths. Only blocks with boundaries
      // need the index map; ordinary static text blocks can compact directly.
      const prefix = boundaries.length ? [0] : undefined
      let length = 0
      for (const op of block.operation) {
        if (!removed.has(op)) block.operation[length++] = op
        if (prefix) prefix.push(length)
      }
      block.operation.length = length
      for (const op of boundaries) {
        if (op.operationIndex !== undefined) {
          op.operationIndex = prefix![op.operationIndex]
        }
      }
    }
    // Reuse the operation inventory for liveness instead of walking the tree
    // and constructing the same Set again for each cleanup step.
    for (const id of block.returns) references.add(id)
    for (const op of operations) {
      if (removed.has(op)) continue
      if ('element' in op) references.add(op.element)
      if ('id' in op) references.add(op.id)
      if ('elements' in op) op.elements.forEach(id => references.add(id))
      if ('parent' in op && op.parent !== undefined) references.add(op.parent)
      if ('anchor' in op && op.anchor !== undefined) references.add(op.anchor)
    }
  }

  // Shared templates can have different computed values at each use site.
  const entries: IRTemplate[] = []
  const indices = new Map<string, number>()
  ir.template.entries.forEach((entry, index) => {
    const group = templates.get(index)
    if (!group) {
      intern(entry)
      return
    }
    for (const { dynamic, edits } of group) {
      if (!edits.length) {
        dynamic.template = intern(entry)
        continue
      }
      edits.sort((a, b) => a.offset - b.offset)
      const chunks: string[] = []
      let cursor = 0
      let delta = 0
      for (const edit of edits) {
        chunks.push(entry.content.slice(cursor, edit.offset), edit.content)
        cursor = edit.offset + edit.length
        edit.delta = delta += edit.content.length - edit.length
      }
      chunks.push(entry.content.slice(cursor))
      dynamic.template = intern({ ...entry, content: chunks.join('') })
    }
  })
  ir.template.entries = entries
  for (const { block } of blocks) updateDynamic(block.dynamic)

  function planTemplate(
    dynamic: IRDynamicInfo,
    data: BlockData,
    plan?: TemplatePlan,
    parentOffset = 0,
  ): void {
    let offset = 0
    if (dynamic.template !== undefined) {
      plan = { dynamic, edits: [] }
      plans.set(dynamic, plan)
      const group = templates.get(dynamic.template)
      if (group) group.push(plan)
      else templates.set(dynamic.template, [plan])
    } else if (plan && dynamic.templateOffset !== undefined) {
      offset = parentOffset + dynamic.templateOffset
    } else {
      plan = undefined
    }
    const computed = dynamic.id !== undefined && data.texts.get(dynamic.id)
    if (plan && computed) {
      const { operation, text } = computed
      let edit: TemplateEdit | undefined
      if (operation.generated) {
        if (dynamic.textContentOffset !== undefined) {
          edit = {
            offset: offset + dynamic.textContentOffset,
            length: 1,
            content: escapeHtml(text),
          }
        }
      } else if (dynamic === plan.dynamic) {
        // Preserve empty text nodes and the text factory's leading '<' guard.
        if (text && text[0] !== '<') {
          edit = {
            offset: 0,
            length: ir.template.entries[dynamic.template!].content.length,
            content: text,
          }
        }
      } else if (text) {
        // Removing an empty child changes sibling and hydration positions.
        edit = { offset, length: 1, content: escapeHtml(text) }
      }
      if (edit) {
        plan.edits.push(edit)
        removed.add(operation)
        candidates.add(operation.element)
        data.changed = true
      }
    }
    for (const child of dynamic.children)
      planTemplate(child, data, plan, offset)
  }

  // Update positions and liveness together, without allocating a location
  // object for every node. Descendants use the original offset during traversal.
  function updateDynamic(
    dynamic: IRDynamicInfo,
    plan?: TemplatePlan,
    parentOffset = 0,
    parentShift = 0,
  ): void {
    let offset = 0
    let shift = 0
    if (dynamic.template !== undefined) {
      plan = plans.get(dynamic)
    } else if (plan && dynamic.templateOffset !== undefined) {
      offset = parentOffset + dynamic.templateOffset
      shift = getShift(plan.edits, offset)
      dynamic.templateOffset += shift - parentShift
    } else {
      plan = undefined
    }
    if (plan && dynamic.textContentOffset !== undefined) {
      dynamic.textContentOffset +=
        getShift(plan.edits, offset + dynamic.textContentOffset) - shift
    }
    if (
      dynamic.id !== undefined &&
      candidates.has(dynamic.id) &&
      !references.has(dynamic.id)
    ) {
      dynamic.flags &= ~DynamicFlag.REFERENCED
    }
    let hasDynamicChild = false
    for (const child of dynamic.children) {
      updateDynamic(child, plan, offset, shift)
      hasDynamicChild ||= !!(
        child.flags & (DynamicFlag.REFERENCED | DynamicFlag.INSERT) ||
        child.template !== undefined ||
        child.operation !== undefined ||
        child.hasDynamicChild
      )
    }
    if (dynamic.hasDynamicChild) dynamic.hasDynamicChild = hasDynamicChild
  }

  function intern(entry: IRTemplate): number {
    const key = `${entry.ns}:${+entry.root}:${+entry.static}:${entry.content}`
    let index = indices.get(key)
    if (index === undefined) {
      indices.set(key, (index = entries.length))
      entries.push(entry)
    }
    return index
  }
}

function computeText(operation: SetTextIRNode): string | undefined {
  let computed = false
  let text: string | undefined = ''
  for (let i = 0; i < operation.values.length; i++) {
    const exp = operation.values[i]
    let literal = getLiteralExpressionValue(exp)
    if (literal === null && exp.ast) {
      const value = evaluateConstant(exp.ast)
      // HTML parsing normalizes CR/NUL and strips a leading LF in pre/textarea.
      if (value !== undefined && !/[\r\n\0]/.test(String(value))) {
        if (!computed) operation.values = operation.values.slice()
        computed = true
        literal = String(value)
        operation.values[i] = createSimpleExpression(literal, true, exp.loc)
      }
    }
    if (literal === null) text = undefined
    else if (text !== undefined) text += literal
  }
  return computed && text !== undefined && !/[\r\n\0]/.test(text)
    ? text
    : undefined
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

function collectBlocks(root: BlockIRNode): BlockData[] {
  const blocks = new Map<BlockIRNode, BlockData>()
  visitBlock(root)
  return [...blocks.values()]

  function visitBlock(block: BlockIRNode) {
    if (blocks.has(block)) return
    const data: BlockData = {
      block,
      operations: new Set(block.operation),
      boundaries: [],
      texts: new Map(),
      changed: false,
    }
    blocks.set(block, data)
    for (const effect of block.effect) {
      for (const operation of effect.operations) data.operations.add(operation)
    }
    visitDynamic(block.dynamic, data.operations)
    for (const operation of data.operations) {
      if (isBlockOperation(operation)) data.boundaries.push(operation)
      visitOperation(operation)
    }
  }

  function visitDynamic(
    dynamic: IRDynamicInfo,
    operations: Set<OperationNode>,
  ) {
    if (dynamic.operation) operations.add(dynamic.operation)
    for (const child of dynamic.children) visitDynamic(child, operations)
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
