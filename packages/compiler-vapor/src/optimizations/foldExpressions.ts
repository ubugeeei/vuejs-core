import type { SimpleExpressionNode } from '@vue/compiler-dom'
import {
  IRDynamicPropsKind,
  IRNodeTypes,
  type IRProp,
  type IRProps,
  IRSlotType,
  type IRSlots,
} from '../ir'
import type { OptimizationOptions } from '../optimize'
import type { BlockAnalysis } from './analysis'
import { foldExpression } from './constantEvaluation'

export function foldExpressions(
  blocks: BlockAnalysis[],
  options: OptimizationOptions,
): Set<SimpleExpressionNode> {
  const computed = new Set<SimpleExpressionNode>()
  const replacements = new Map<SimpleExpressionNode, SimpleExpressionNode>()
  const fold = (expression: SimpleExpressionNode) => {
    let result = replacements.get(expression)
    if (!result) {
      replacements.set(
        expression,
        (result = foldExpression(expression, options)),
      )
      if (result !== expression) computed.add(result)
    }
    return result
  }
  const prop = (prop: IRProp) => {
    prop.key = fold(prop.key)
    if (!prop.handler) prop.values = prop.values.map(fold)
  }
  const props = (values: IRProps[]) => {
    for (const value of values) {
      if (Array.isArray(value)) value.forEach(prop)
      else if (value.kind === IRDynamicPropsKind.ATTRIBUTE) prop(value)
      else if (!value.handler) value.value = fold(value.value)
    }
  }
  const visitSlot = (slot: IRSlots): void => {
    switch (slot.slotType) {
      case IRSlotType.DYNAMIC:
        slot.name = fold(slot.name)
        break
      case IRSlotType.LOOP:
        slot.name = fold(slot.name)
        slot.loop.source = fold(slot.loop.source)
        break
      case IRSlotType.CONDITIONAL:
        slot.condition = fold(slot.condition)
        slot.positive.name = fold(slot.positive.name)
        if (slot.negative) visitSlot(slot.negative)
        break
    }
  }
  for (const { block, operations } of blocks) {
    for (const effect of block.effect)
      effect.expressions = effect.expressions.map(fold)
    for (const operation of operations) {
      switch (operation.type) {
        case IRNodeTypes.SET_TEXT:
          operation.values = operation.values.map(fold)
          break
        case IRNodeTypes.SET_PROP:
          prop(operation.prop)
          break
        case IRNodeTypes.SET_DYNAMIC_PROPS:
        case IRNodeTypes.CREATE_COMPONENT_NODE:
        case IRNodeTypes.SLOT_OUTLET_NODE:
          props(operation.props)
          if (operation.type === IRNodeTypes.CREATE_COMPONENT_NODE)
            operation.slots.forEach(visitSlot)
          break
        case IRNodeTypes.IF:
          operation.condition = fold(operation.condition)
          foldElseIf(operation)
          break
        case IRNodeTypes.FOR:
          operation.source = fold(operation.source)
          break
        case IRNodeTypes.KEY:
        case IRNodeTypes.SET_BLOCK_KEY:
        case IRNodeTypes.SET_HTML:
        case IRNodeTypes.SET_TEMPLATE_REF:
          operation.value = fold(operation.value)
          break
      }
    }
  }
  return computed

  function foldElseIf(operation: import('../ir').IfIRNode): void {
    if (operation.negative?.type === IRNodeTypes.IF) {
      operation.negative.condition = fold(operation.negative.condition)
      foldElseIf(operation.negative)
    }
  }
}
