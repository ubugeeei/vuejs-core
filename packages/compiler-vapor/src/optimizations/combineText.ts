import { createSimpleExpression } from '@vue/compiler-dom'
import type { SetTextIRNode } from '../ir'
import { getLiteralExpressionValue } from '../utils'

export function combineText(operation: SetTextIRNode): void {
  let values: typeof operation.values | undefined
  let previous: string | null = null
  for (let i = 0; i < operation.values.length; i++) {
    const value = operation.values[i]
    const literal = getLiteralExpressionValue(value)
    if (literal !== null && previous !== null) {
      values ||= operation.values.slice(0, i)
      const first = values[values.length - 1]
      values[values.length - 1] = createSimpleExpression(
        previous + literal,
        true,
        first.loc,
      )
      previous += literal
    } else {
      if (values) values.push(value)
      previous = literal
    }
  }
  if (values) operation.values = values
}
