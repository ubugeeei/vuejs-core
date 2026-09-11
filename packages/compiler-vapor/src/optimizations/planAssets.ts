import { IRNodeTypes, type OperationNode, type RootIRNode } from '../ir'
import { type BlockAnalysis, collectBlocks } from './analysis'

export function planAssets(
  ir: RootIRNode,
  blocks?: BlockAnalysis[],
): Set<string> {
  const names = new Set<string>()
  if (!ir.component.size) return (ir.singleUseAssetComponents = names)
  const usages = new Map<string, { count: number; root: boolean }>()
  const seen = new Set<OperationNode>()
  const rootEffects = new Set(
    ir.block.effect.flatMap(effect => effect.operations),
  )
  for (const { block, operations } of blocks || collectBlocks(ir.block)) {
    for (const operation of operations) {
      if (
        operation.type !== IRNodeTypes.CREATE_COMPONENT_NODE ||
        !operation.asset ||
        seen.has(operation)
      )
        continue
      seen.add(operation)
      const usage = usages.get(operation.tag) || { count: 0, root: false }
      usage.count++
      usage.root ||= block === ir.block && !rootEffects.has(operation)
      usages.set(operation.tag, usage)
    }
  }
  for (const [name, usage] of usages) {
    if (usage.count === 1 && usage.root) names.add(name)
  }
  return (ir.singleUseAssetComponents = names)
}
