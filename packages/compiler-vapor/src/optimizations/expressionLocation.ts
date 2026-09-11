import {
  type Position,
  type SimpleExpressionNode,
  advancePositionWithClone,
} from '@vue/compiler-dom'

interface MappedExpression extends SimpleExpressionNode {
  sourceOffsets?: { source: string; offsets: number[] }
}

export interface ExpressionEdit {
  start: number
  end: number
  content: string
}

// Only source-map builds allocate mappings. Positions are UTF-16 boundaries,
// matching Babel's offsets and Vue's source locations.
export function mapExpressionEdits(
  original: SimpleExpressionNode,
  result: SimpleExpressionNode,
  edits: ExpressionEdit[],
  enabled = false,
): void {
  const previous = (original as MappedExpression).sourceOffsets
  if (!enabled && !previous) return
  const offsets: number[] = []
  const at = (offset: number) => (previous ? previous.offsets[offset] : offset)
  let cursor = 0
  for (const edit of [...edits].sort((a, b) => a.start - b.start)) {
    for (; cursor < edit.start; cursor++) offsets.push(at(cursor))
    for (let i = 0; i < edit.content.length; i++) offsets.push(at(edit.start))
    cursor = edit.end
  }
  for (; cursor <= original.content.length; cursor++) offsets.push(at(cursor))
  ;(result as MappedExpression).sourceOffsets = {
    source: previous?.source || original.content,
    offsets,
  }
}

export function getExpressionPosition(
  expression: SimpleExpressionNode,
  source: string,
  offset: number,
): Position {
  const mapping = (expression as MappedExpression).sourceOffsets
  return advancePositionWithClone(
    expression.loc.start,
    mapping ? mapping.source : source,
    mapping ? mapping.offsets[offset] : offset,
  )
}
