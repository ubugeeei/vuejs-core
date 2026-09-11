import type { ParserOptions, SimpleExpressionNode } from '@vue/compiler-dom'
import type { RootIRNode } from './ir'
import { collectBlocks } from './optimizations/analysis'
import { planExpressionCaches } from './optimizations/cacheExpressions'
import { compileTimeComputation } from './optimizations/compileTimeComputation'
import { combineText } from './optimizations/combineText'
import { foldExpressions } from './optimizations/foldExpressions'
import { simplifyControlFlow } from './optimizations/simplifyControlFlow'
import { optimizeTemplates } from './optimizations/optimizeTemplates'
import { planDomAccess } from './optimizations/planDomAccess'
import { planAssets } from './optimizations/planAssets'
import { planEventDelegation } from './optimizations/planEventDelegation'

export interface OptimizationOptions {
  /**
   * 0: skip optional IR optimization (existing lowering/codegen optimizations remain).
   * 1: compute and combine constant text; plan DOM accesses, assets, events and caches (default).
   * 2: additionally fold primitive expressions, prune dead branches and optimize templates.
   */
  optLevel?: 0 | 1 | 2
  expressionPlugins?: ParserOptions['expressionPlugins']
  sourceMap?: boolean
}

export function optimize(
  ir: RootIRNode,
  options: OptimizationOptions = {},
): void {
  const level = options.optLevel ?? 1
  if (level === 0) return
  const { block } = ir
  // Fully lowered static roots have no optional work or asset usages to plan.
  if (
    !block.operation.length &&
    !block.effect.length &&
    block.dynamic.children.every(
      child => !child.hasDynamicChild && !child.operation,
    )
  ) {
    ir.singleUseAssetComponents ||= new Set()
    return
  }
  let blocks = collectBlocks(ir.block)
  // Preserve resolution timing even if dead branches remove component uses.
  if (!ir.singleUseAssetComponents) planAssets(ir, blocks)
  let computed: Set<SimpleExpressionNode> | undefined
  if (level > 1) {
    computed = foldExpressions(blocks, options)
    if (simplifyControlFlow(blocks)) blocks = collectBlocks(ir.block)
  }
  compileTimeComputation(ir, blocks, computed)
  combineText(blocks)
  if (level > 1) optimizeTemplates(ir, blocks)
  planDomAccess(blocks)
  planEventDelegation(blocks)
  planExpressionCaches(blocks, options)
}
