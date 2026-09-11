import { VaporIfFlags } from '@vue/shared'
import {
  type BlockIRNode,
  DynamicFlag,
  type IRDynamicInfo,
  IRNodeTypes,
  type IRTemplate,
  type IfIRNode,
  type RootIRNode,
} from '../ir'
import type { BlockAnalysis } from './analysis'

export function optimizeTemplates(
  ir: RootIRNode,
  blocks: BlockAnalysis[],
): void {
  const owners = new Map<number, IRDynamicInfo[]>()
  const referenced = new Set<number>()
  for (const { operations } of blocks) {
    for (const operation of operations) {
      if ('element' in operation) referenced.add(operation.element)
      if ('id' in operation) referenced.add(operation.id)
      if ('elements' in operation)
        operation.elements.forEach(id => referenced.add(id))
      if ('parent' in operation && operation.parent !== undefined)
        referenced.add(operation.parent)
      if ('anchor' in operation && operation.anchor !== undefined)
        referenced.add(operation.anchor)
    }
  }
  const mutable = new Set<IRDynamicInfo>()
  for (const { dynamics } of blocks) {
    for (let i = dynamics.length - 1; i >= 0; i--) {
      const dynamic = dynamics[i]
      if (
        dynamic.operation ||
        dynamic.flags & DynamicFlag.INSERT ||
        (dynamic.id !== undefined && referenced.has(dynamic.id)) ||
        dynamic.children.some(
          child => mutable.has(child) || child.template !== undefined,
        )
      )
        mutable.add(dynamic)
      else dynamic.hasDynamicChild = false
    }
    for (const dynamic of dynamics) {
      if (dynamic.template === undefined) continue
      const group = owners.get(dynamic.template)
      if (group) group.push(dynamic)
      else owners.set(dynamic.template, [dynamic])
    }
  }
  const entries: IRTemplate[] = []
  const indices = new Map<string, number>()
  ir.template.entries.forEach((entry, index) => {
    const group = owners.get(index)
    if (!group) return
    for (const owner of group) {
      const isStatic =
        entry.static || !!(owner.staticTemplateEligible && !mutable.has(owner))
      const key = `${entry.ns}:${+entry.root}:${+isStatic}:${entry.content}`
      let replacement = indices.get(key)
      if (replacement === undefined) {
        replacement = entries.length
        entries.push(
          isStatic === entry.static ? entry : { ...entry, static: isStatic },
        )
        indices.set(key, replacement)
      }
      owner.template = replacement
    }
  })
  ir.template.entries = entries
  // Only root-block branches may reuse the enclosing scope, matching v-if
  // lowering. Nested branches remain owned by their enclosing branch scope.
  for (const operation of blocks[0].operations) {
    if (operation.type === IRNodeTypes.IF) planBranchScope(operation)
  }

  function planBranchScope(operation: IfIRNode): void {
    if (isStaticBlock(operation.positive))
      operation.blockShape |= VaporIfFlags.TRUE_NO_SCOPE
    const negative = operation.negative
    if (negative?.type === IRNodeTypes.IF) planBranchScope(negative)
    else if (negative && isStaticBlock(negative))
      operation.blockShape |= VaporIfFlags.FALSE_NO_SCOPE
  }

  function isStaticBlock(block: BlockIRNode): boolean {
    return (
      !block.operation.length &&
      !block.effect.length &&
      block.returns.length > 0 &&
      block.dynamic.children.length === block.returns.length &&
      block.dynamic.children.every(
        child =>
          child.id !== undefined &&
          block.returns.includes(child.id) &&
          child.template !== undefined &&
          entries[child.template].static &&
          !child.operation &&
          !child.hasDynamicChild &&
          !(child.flags & (DynamicFlag.INSERT | DynamicFlag.NON_TEMPLATE)),
      )
    )
  }
}
