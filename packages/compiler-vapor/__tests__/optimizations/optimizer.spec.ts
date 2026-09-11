import { SourceMapConsumer } from 'source-map-js'
import { createSimpleExpression, parse } from '@vue/compiler-dom'
import { parseExpression } from '@babel/parser'
import {
  foldExpression,
  getConstantValue,
} from '../../src/optimizations/constantEvaluation'
import { getBaseTransformPreset } from '../../src/compile'
import { transform } from '../../src/transform'
import { optimize } from '../../src/optimize'
import { generate } from '../../src/generate'
import { compile } from '../../src/compile'
import { IRNodeTypes } from '../../src/ir'
import { VaporIfFlags } from '@vue/shared'

function textOperation(source: string, optLevel: 0 | 1 | 2 = 1) {
  const { ast } = compile(source, { prefixIdentifiers: true, optLevel })
  const operation = ast.block.effect
    .flatMap(effect => effect.operations)
    .find(operation => operation.type === IRNodeTypes.SET_TEXT)!
  expect(operation.type).toBe(IRNodeTypes.SET_TEXT)
  if (operation.type !== IRNodeTypes.SET_TEXT) throw new Error('Expected text')
  return operation
}

describe('IR optimizer', () => {
  test('can disable optional IR optimization', () => {
    const source = '<div>{{ 1 + 2 }}</div>'
    const disabled = compile(source, { prefixIdentifiers: true, optLevel: 0 })
    const enabled = compile(source, { prefixIdentifiers: true, optLevel: 1 })
    expect(disabled.helpers).toContain('setText')
    expect(enabled.helpers).not.toContain('setText')
    expect(compile(source, { prefixIdentifiers: true }).code).toBe(enabled.code)
  })

  test('combines adjacent constant text without crossing dynamic values', () => {
    const operation = textOperation(
      '<div>{{ 1 + 2 }}{{ 2 + 3 }}{{ value }}{{ 4 + 5 }}{{ 5 + 6 }}</div>',
    )
    expect(operation.values.map(value => value.content)).toEqual([
      '35',
      'value',
      '911',
    ])
  })

  test('folds closed subexpressions only at the higher level', () => {
    const source = '<div>{{ value + (2 + 3) }}</div>'
    expect(textOperation(source, 1).values[0].content).toBe('value + (2 + 3)')
    expect(textOperation(source, 2).values[0].content).toBe('value + (5)')
  })

  test('keeps computed component props typed', () => {
    const { code } = compile(
      `<Comp :count="(2 + 3) * 4" :label="'a' + 'b'" />`,
      {
        prefixIdentifiers: true,
        optLevel: 2,
      },
    )
    expect(code).not.toContain('(2 + 3) * 4')
    expect(code).toMatch(/count: (?:\(\) => )?20/)
    expect(code).toContain('"ab"')
  })

  test('removes unreachable branch contents while keeping the branch boundary', () => {
    const { ast, code, helpers } = compile(
      '<div v-if="1 > 2">unreachable{{ effect() }}</div><section v-else>{{ value }}</section>',
      { prefixIdentifiers: true, optLevel: 2 },
    )
    expect(code).not.toContain('effect()')
    expect(ast.template.keys().join('')).not.toContain('unreachable')
    expect(helpers).toContain('createIf')
    expect(code).toContain('value')
  })
  test('reclassifies computed native templates without promoting list or custom-element templates', () => {
    const { ast } = compile(
      '<section><div>{{ 1 + 2 }}</div></section><footer/>',
      {
        prefixIdentifiers: true,
        optLevel: 2,
      },
    )
    expect(ast.template.entries).toEqual([
      expect.objectContaining({ content: '<section><div>3', static: true }),
      expect.objectContaining({ content: '<footer>', static: true }),
    ])
    for (const source of [
      '<div v-for="item of items">{{ 1 + 2 }}</div><footer/>',
      '<custom-element>{{ 1 + 2 }}</custom-element><footer/>',
      '<template>{{ 1 + 2 }}</template><footer/>',
      '<div :title="value">{{ 1 + 2 }}</div><footer/>',
    ]) {
      const { ast } = compile(source, {
        prefixIdentifiers: true,
        optLevel: 2,
        isCustomElement: tag => tag === 'custom-element',
      })
      expect(ast.template.entries[0].static).toBe(false)
    }
  })

  test.each([
    ['1 + 2 + 3', 6],
    ['(2 + 3) * 4', 20],
    ['0.1 + 0.2', 0.30000000000000004],
    ['-0', -0],
    ['1 < 2', true],
    ['1 === "1"', false],
    ['null === null', true],
    ['false && sideEffect()', false],
    ['true || sideEffect()', true],
    ['null ?? (2 + 3)', 5],
    ['false ?? sideEffect()', false],
    ['true ? 2 + 3 : sideEffect()', 5],
    ['typeof null', 'object'],
    ['!(2 - 2)', true],
    ['"a" + null', 'anull'],
    ['1 / 0', undefined],
    ['0 / 0', undefined],
    ['2 ** 3', undefined],
    ['1e308 * 2', undefined],
    ['1n + 2n', undefined],
    ['Math.random()', undefined],
    ['object.value', undefined],
    ['undefined', undefined],
    ['void sideEffect()', undefined],
    ['({ valueOf() { throw 1 } }) + 1', undefined],
  ])('computes only proven primitive values in %s', (content, expected) => {
    const expression = createSimpleExpression(content)
    expression.ast = parseExpression(`(${content})`)
    expect(getConstantValue(expression)).toBe(expected)
  })

  test.each([
    ['value + (2 + 3)', 'value + (5)'],
    ['(2 + 3) * value', '(5) * value'],
    ['(1 as number) + 2 + value', '3 + value'],
    ['getValue(2 + 3)', 'getValue(2 + 3)'],
    ['object[2 + 3]', 'object[2 + 3]'],
    ['() => 2 + 3', '() => 2 + 3'],
    ['value ** (1 / 0)', 'value ** (1 / 0)'],
  ])('preserves evaluation boundaries in %s', (content, expected) => {
    const expression = createSimpleExpression(content)
    expression.ast = parseExpression(`(${content})`, {
      plugins: ['typescript'],
    })
    const original = JSON.stringify(expression)
    expect(
      foldExpression(expression, { expressionPlugins: ['typescript'] }).content,
    ).toBe(expected)
    expect(JSON.stringify(expression)).toBe(original)
  })

  test('keeps optimization idempotent across nested effect boundaries', () => {
    const source =
      '<main><i>{{ (2 + 3) * 4 }}</i>{{ value }}<Comp :count="(2 + 3) * 4"><b v-if="2 > 1">{{ value + (2 + 3) }}</b><b v-else>unused</b></Comp>{{ value }}</main>'
    const [nodeTransforms, directiveTransforms] = getBaseTransformPreset()
    const ir = transform(parse(source, { prefixIdentifiers: true }), {
      prefixIdentifiers: true,
      nodeTransforms,
      directiveTransforms,
    })
    const ast = JSON.stringify(ir.node)
    optimize(ir, { optLevel: 2 })
    const first = JSON.stringify(ir)
    optimize(ir, { optLevel: 2 })
    expect(JSON.stringify(ir)).toBe(first)
    expect(JSON.stringify(ir.node)).toBe(ast)
    const code = generate(ir, { prefixIdentifiers: true }).code
    expect(code).not.toContain('unused')
    expect(code).not.toContain('2 + 3')
  })

  test.each([
    '(2 + 3) + value',
    '0.1 + 0.2 + value',
    '(2 +\n3) + value',
    '(1 + 2) + obj.x + obj.x + (3 + 4) + value',
  ])('preserves identifier source locations after folding %s', expression => {
    const source = `<div>{{ ${expression} }}</div>`
    const { code, map } = compile(source, {
      prefixIdentifiers: true,
      optLevel: 2,
      sourceMap: true,
      filename: 'Fixture.vue',
    })
    const position = (text: string, offset: number) => {
      const prefix = text.slice(0, offset).split('\n')
      return { line: prefix.length, column: prefix[prefix.length - 1].length }
    }
    const consumer = new SourceMapConsumer(map!)
    const generated = position(code, code.lastIndexOf('value'))
    expect(consumer.originalPositionFor(generated)).toMatchObject(
      position(source, source.indexOf('value')),
    )
  })
  test('preserves component resolution timing when pruning a dead use', () => {
    const source = '<main><Mutator/><Child v-if="false"/><Child/></main>'
    const { code, ast } = compile(source, {
      prefixIdentifiers: true,
      optLevel: 2,
    })
    expect(code).toContain('_resolveComponent("Child")')
    expect(code.indexOf('_resolveComponent("Child")')).toBeLessThan(
      code.indexOf('_createAssetComponent("Mutator"'),
    )
    optimize(ast, { optLevel: 2 })
    expect(generate(ast, { prefixIdentifiers: true }).code).toBe(code)
  })
})

describe('computed effect elimination', () => {
  test.each([1, 2] as const)(
    'embeds short-circuited text at level %s',
    optLevel => {
      const { ast, code, helpers } = compile(
        '<main><i>{{ false && fail() }}</i><Comp/><b>{{ true ? 20 : value }}</b><Comp/><u>{{ label }}</u></main>',
        { prefixIdentifiers: true, optLevel },
      )
      expect(ast.template.keys().join('')).toContain('<i>false</i>')
      expect(ast.template.keys().join('')).toContain('<b>20</b>')
      expect(code).not.toContain('fail')
      expect(code).not.toContain('_ctx.value')
      expect(code.match(/_renderEffect\(/g)).toHaveLength(1)
      expect(helpers).toContain('setText')
      const lastComponent = code.lastIndexOf('_createComponentWithFallback(')
      expect(lastComponent).toBeGreaterThanOrEqual(0)
      expect(lastComponent).toBeLessThan(code.indexOf('_renderEffect('))
    },
  )
  test.each([1, 2] as const)(
    'removes an entirely computed text effect at level %s',
    optLevel => {
      const { code, helpers } = compile('<div>{{ true ? 20 : fail() }}</div>', {
        prefixIdentifiers: true,
        optLevel,
      })
      expect(code).toContain('<div>20')
      expect(helpers).not.toContain('renderEffect')
      expect(helpers).not.toContain('setText')
      expect(helpers).not.toContain('txt')
    },
  )
})

describe('static branch scopes', () => {
  test('reuses the enclosing scope for branches made entirely static', () => {
    const { ast } = compile(
      '<main><div v-if="ok">{{ 2 + 3 }}</div><i v-else>{{ false && fail() }}</i></main>',
      { prefixIdentifiers: true, optLevel: 2 },
    )
    const branch = ast.block.dynamic.children[0].children[0].operation!
    expect(branch.type).toBe(IRNodeTypes.IF)
    if (branch.type !== IRNodeTypes.IF) return
    expect(branch.blockShape & VaporIfFlags.TRUE_NO_SCOPE).toBeTruthy()
    expect(branch.blockShape & VaporIfFlags.FALSE_NO_SCOPE).toBeTruthy()
    expect(branch.once).toBe(false)
  })
  test.each([
    '<div>{{ value }}</div>',
    '<Comp/>',
    '<div ref="target">{{ 2 + 3 }}</div>',
    '<div v-custom>{{ 2 + 3 }}</div>',
  ])('retains scopes for owned work in %s', child => {
    const { ast } = compile(`<template v-if="ok">${child}</template>`, {
      prefixIdentifiers: true,
      optLevel: 2,
    })
    const branch = ast.block.dynamic.children[0].operation!
    if (branch.type !== IRNodeTypes.IF) throw new Error('Expected branch')
    expect(branch.blockShape & VaporIfFlags.TRUE_NO_SCOPE).toBe(0)
  })
})

describe('constant expression branches', () => {
  test.each([
    ['true ? value : fail()', '(0, value)'],
    ['false ? fail() : value', '(0, value)'],
    ['true && value', '(0, value)'],
    ['false || value', '(0, value)'],
    ['null ?? value', '(0, value)'],
    ['typeof (true ? missing : value)', 'typeof ((0, missing))'],
    ['delete (true ? object.value : other)', 'delete ((0, object.value))'],
  ])(
    'removes unreachable operands while preserving GetValue in %s',
    (content, expected) => {
      const expression = createSimpleExpression(content)
      expression.ast = parseExpression(`(${content})`)
      expect(foldExpression(expression, {}).content).toBe(expected)
    },
  )
  test.each([
    'true ? value : fail()',
    'false || value',
    'typeof (true ? missing : value)',
  ])('preserves source locations in %s', expression => {
    const source = `<div>{{ ${expression} }}</div>`
    const { code, map } = compile(source, {
      prefixIdentifiers: true,
      optLevel: 2,
      sourceMap: true,
    })
    const name = expression.includes('missing') ? 'missing' : 'value'
    const prefix = code.slice(0, code.lastIndexOf(name)).split('\n')
    expect(
      new SourceMapConsumer(map!).originalPositionFor({
        line: prefix.length,
        column: prefix[prefix.length - 1].length,
      }),
    ).toMatchObject({ line: 1, column: source.indexOf(name) })
  })
})

test('preserves signed zero and parenthesized constant ranges across repeated optimization', () => {
  for (const content of [
    '(true ? (-0) : fail())',
    '/* result -0 */ ((2 - 3) * 0)',
    '(((2 + 3) * -4))',
  ]) {
    const expression = createSimpleExpression(content)
    expression.ast = parseExpression(`(${content})`)
    const folded = foldExpression(expression, {})
    expect(getConstantValue(folded)).toBe(getConstantValue(expression))
    expect(foldExpression(folded, {}).content).toBe(folded.content)
  }
})
