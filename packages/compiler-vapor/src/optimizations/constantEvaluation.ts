import { mapExpressionEdits } from './expressionLocation'
import {
  type SimpleExpressionNode,
  createSimpleExpression,
  unwrapTSNode,
} from '@vue/compiler-dom'
import type { Node } from '@babel/types'
import { parseExpression } from '@babel/parser'
import type { OptimizationOptions } from '../optimize'

export type ConstantValue = string | number | boolean | null

export function getConstantValue(
  expression: SimpleExpressionNode,
): ConstantValue | undefined {
  if (expression.isStatic) return expression.content
  if (expression.ast) return evaluateConstant(expression.ast)
  if (expression.content === 'true') return true
  if (expression.content === 'false') return false
  if (expression.content === 'null') return null
}

// Closed primitive expressions only. Unknown identifiers, calls, objects and
// member reads are never executed or treated as constants.
export function evaluateConstant(
  node: Node,
  cache?: Map<Node, ConstantValue | undefined>,
): ConstantValue | undefined {
  if (cache?.has(node)) return cache.get(node)
  const value = evaluateNode(node, cache)
  cache?.set(node, value)
  return value
}

function evaluateNode(
  node: Node,
  cache?: Map<Node, ConstantValue | undefined>,
): ConstantValue | undefined {
  node = unwrapTSNode(node)
  switch (node.type) {
    case 'BooleanLiteral':
      return node.value
    case 'NullLiteral':
      return null
    case 'StringLiteral':
      return node.value
    case 'NumericLiteral':
      return Number.isFinite(node.value) ? node.value : undefined
    case 'ParenthesizedExpression':
      return evaluateConstant(node.expression, cache)
    case 'UnaryExpression': {
      const value = evaluateConstant(node.argument, cache)
      if (value === undefined) return
      if (node.operator === '!') return !value
      if (node.operator === 'typeof') return typeof value
      if (typeof value !== 'number') return
      switch (node.operator) {
        case '+':
          return value
        case '-':
          return -value
      }
      return
    }
    case 'LogicalExpression': {
      const left = evaluateConstant(node.left, cache)
      if (left === undefined) return
      if (node.operator === '&&')
        return left ? evaluateConstant(node.right, cache) : left
      if (node.operator === '||')
        return left ? left : evaluateConstant(node.right, cache)
      return left === null ? evaluateConstant(node.right, cache) : left
    }
    case 'ConditionalExpression': {
      const test = evaluateConstant(node.test, cache)
      if (test === undefined) return
      return evaluateConstant(test ? node.consequent : node.alternate, cache)
    }
    case 'BinaryExpression': {
      const left = evaluateConstant(node.left, cache)
      const right = evaluateConstant(node.right, cache)
      if (left === undefined || right === undefined) return
      if (node.operator === '===') return left === right
      if (node.operator === '!==') return left !== right
      if (
        (typeof left === 'number' && typeof right === 'number') ||
        (typeof left === 'string' && typeof right === 'string')
      ) {
        switch (node.operator) {
          case '<':
            return left < right
          case '<=':
            return left <= right
          case '>':
            return left > right
          case '>=':
            return left >= right
        }
      }
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

function serializeConstant(value: ConstantValue): string {
  return Object.is(value, -0) ? '-0' : JSON.stringify(value)
}

export function foldExpression(
  expression: SimpleExpressionNode,
  options: OptimizationOptions,
): SimpleExpressionNode {
  if (expression.isStatic || !expression.ast) return expression
  const cache = new Map<Node, ConstantValue | undefined>()
  const edits: { start: number; end: number; content: string }[] = []
  visit(expression.ast)
  if (!edits.length) return expression
  let content = expression.content
  for (let i = edits.length - 1; i >= 0; i--) {
    const edit = edits[i]
    content =
      content.slice(0, edit.start) + edit.content + content.slice(edit.end)
  }
  if (content === expression.content) return expression
  const result = createSimpleExpression(
    content,
    false,
    expression.loc,
    expression.constType,
  )
  mapExpressionEdits(expression, result, edits, options.sourceMap)
  result.ast = parseExpression(`(${content})`, {
    plugins: options.expressionPlugins,
  })
  return result

  function visit(node: Node): void {
    const value = evaluateConstant(node, cache)
    if (value !== undefined) {
      if (node.start != null && node.end != null) {
        const content = serializeConstant(value)
        const start = node.start - 1
        const end = node.end - 1
        // Keep literal spelling unless computation changes the expression.
        if (
          !node.type.endsWith('Literal') &&
          expression.content.slice(start, end) !== content
        ) {
          edits.push({ start, end, content })
        }
      }
      return
    }
    switch (node.type) {
      case 'BinaryExpression':
      case 'LogicalExpression':
        visit(node.left)
        visit(node.right)
        break
      case 'UnaryExpression':
        visit(node.argument)
        break
      case 'ConditionalExpression':
        visit(node.test)
        visit(node.consequent)
        visit(node.alternate)
        break
      default: {
        const unwrapped = unwrapTSNode(node)
        if (unwrapped !== node) visit(unwrapped)
        else if (node.type === 'ParenthesizedExpression') visit(node.expression)
      }
    }
  }
}
