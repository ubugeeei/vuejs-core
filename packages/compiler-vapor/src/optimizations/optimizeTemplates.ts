import {
  DynamicFlag,
  type IRDynamicInfo,
  type IRTemplate,
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
        entry.static ||
        // Hydrated roots may carry fallthrough attrs. Caching their adopted DOM
        // would leak the first instance's attrs into later CSR clones.
        !!(!entry.root && owner.staticTemplateEligible && !mutable.has(owner))
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
}
