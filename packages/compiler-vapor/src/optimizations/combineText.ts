import { createSimpleExpression } from '@vue/compiler-dom'
import { IRNodeTypes } from '../ir'
import { getLiteralExpressionValue } from '../utils'
import type { BlockAnalysis } from './analysis'

export function combineText(blocks: BlockAnalysis[]): void {
  for (const { operations } of blocks) {
    for (const operation of operations) {
      if (
        operation.type !== IRNodeTypes.SET_TEXT ||
        operation.values.length < 2
      )
        continue
      const values: typeof operation.values = []
      let text: string | undefined
      let first: (typeof values)[number] | undefined
      const flush = () => {
        if (first) values.push(createSimpleExpression(text!, true, first.loc))
        first = undefined
        text = undefined
      }
      for (const value of operation.values) {
        const literal = getLiteralExpressionValue(value)
        if (literal === null) {
          flush()
          values.push(value)
        } else {
          first ||= value
          text = (text || '') + literal
        }
      }
      flush()
      if (values.length < operation.values.length) operation.values = values
    }
  }
}
