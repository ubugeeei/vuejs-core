import { NodeTypes } from '@vue/compiler-dom'
import {
  IRNodeTypes,
  transformChildren,
  transformElement,
  transformText,
  transformVBind,
  transformVIf,
  transformVOn,
  transformVSlot,
} from '../../src'

import { makeCompile } from './_utils'

const compileWithTextTransform = makeCompile({
  nodeTransforms: [
    transformVIf,
    transformElement,
    transformVSlot,
    transformChildren,
    transformText,
  ],
  directiveTransforms: {
    bind: transformVBind,
    on: transformVOn,
  },
})

describe('compiler: text transform', () => {
  it('no consecutive text', () => {
    const { code, ir, helpers } = compileWithTextTransform(
      '{{ "hello world" }}',
    )
    expect(code).toMatchSnapshot()
    expect(helpers).contains.all.keys('setText', 'template')
    expect(ir.block.operation).toMatchObject([
      {
        type: IRNodeTypes.SET_TEXT,
        element: 0,
        values: [
          {
            type: NodeTypes.SIMPLE_EXPRESSION,
            content: '"hello world"',
            isStatic: false,
          },
        ],
      },
    ])
  })

  it('consecutive text', () => {
    const { code, ir, helpers } = compileWithTextTransform('{{ msg }}')
    expect(code).toMatchSnapshot()
    expect(helpers).contains.all.keys('setText', 'template')
    expect(ir.block.operation).toMatchObject([])
    expect(ir.block.effect.length).toBe(1)
  })

  it('escapes raw static text when generating the template string', () => {
    const { ir } = compileWithTextTransform('<code>&lt;script&gt;</code>')
    expect([...ir.template.keys()]).toContain('<code>&lt;script&gt;')
    expect([...ir.template.keys()]).not.toContain('<code><script>')
  })

  it('escapes raw static text for plain template createElement path', () => {
    const { code } = compileWithTextTransform(
      '<template>&lt;b&gt;foo&lt;/b&gt;</template>',
    )
    expect(code).toMatchSnapshot()
    expect(code).toContain('const t0 = _template("")')
    expect(code).toContain('_setText(n0, "<b>foo</b>")')
    expect(code).not.toContain('_template("<b>foo</b>")')
  })

  it('escapes raw static text for custom element createElement path', () => {
    const { code } = compileWithTextTransform(
      '<my-el>&lt;b&gt;foo&lt;/b&gt;</my-el>',
      {
        isCustomElement: tag => tag === 'my-el',
      },
    )
    expect(code).toMatchSnapshot()
    expect(code).toContain('const t0 = _template("")')
    expect(code).toContain('_setText(n0, "<b>foo</b>")')
    expect(code).not.toContain('_template("<b>foo</b>")')
  })

  it('materializes literal interpolation text for mixed plain template children', () => {
    const { code } = compileWithTextTransform(
      '<template><span></span>{{ "<b>foo</b>" }}</template>',
    )
    expect(code).toMatchSnapshot()
    expect(code).toContain('const t1 = _template("")')
    expect(code).toContain('_setText(n1, "<b>foo</b>")')
    expect(code).not.toContain('_template("<b>foo</b>")')
  })

  it('should not escape quotes in root-level text nodes', () => {
    // Root-level text goes through createTextNode() which doesn't need escaping
    const { ir } = compileWithTextTransform(`Howdy y'all`)
    expect([...ir.template.keys()]).toContain(`Howdy y'all`)
    expect([...ir.template.keys()]).not.toContain(`Howdy y&#39;all`)
  })

  it('should not escape double quotes in root-level text nodes', () => {
    const { ir } = compileWithTextTransform(`Say "hello"`)
    expect([...ir.template.keys()]).toContain(`Say "hello"`)
    expect([...ir.template.keys()]).not.toContain(`Say &quot;hello&quot;`)
  })

  it('should not escape quotes in template v-if text', () => {
    // Text inside <template> tag also goes through createTextNode()
    const { code } = compileWithTextTransform(
      `<template v-if="ok">Howdy y'all</template>`,
    )
    expect(code).toContain(`Howdy y'all`)
    expect(code).not.toContain(`Howdy y&#39;all`)
  })

  it('should not escape quotes in component slot text', () => {
    // Text inside component (slot content) also goes through createTextNode()
    const { ir } = compileWithTextTransform(`<Comp>Howdy y'all</Comp>`)
    expect([...ir.template.keys()]).toContain(`Howdy y'all`)
    expect([...ir.template.keys()]).not.toContain(`Howdy y&#39;all`)
  })

  test('constant text', () => {
    const { code } = compileWithTextTransform(
      `
        <div>
          {{ (2) }}
          {{ \`foo\${1}\` }}
          {{ 1 }}
          {{ 1n }}
          {{ '1' }}
        </div>`,
    )
    expect(code).toMatchSnapshot()
  })

  test('slot literal interpolation', () => {
    const { code } = compileWithTextTransform(`<Comp>{{ "Hello" }}</Comp>`)
    expect(code).toMatchSnapshot()
  })

  test.each([
    ['1 + 2', '3'],
    ["'hello' + ' world'", 'hello world'],
    ["1 + 2 + '3'", '33'],
    ["'1' + 2 + 3", '123'],
    ['-(2 + 3) * 4 / 2', '-10'],
    ['8 - 5 % 2', '7'],
    ['-0 + -0', '0'],
    ["'' + ''", ''],
    ["'<b>' + '&'", '&lt;b&gt;&amp;'],
    ['(1 as number) + 2', '3'],
  ])('folds literal text expression %s', (expression, text) => {
    const { ir, helpers } = compileWithTextTransform(
      `<div>{{ ${expression} }}</div>`,
      { expressionPlugins: ['typescript'] },
    )
    expect([...ir.template.keys()]).toEqual([`<div>${text}`])
    expect(helpers).not.toContain('txt')
    expect(helpers).not.toContain('setText')
    expect(helpers).not.toContain('toDisplayString')
    expect(helpers).not.toContain('renderEffect')
  })

  test.each([
    'value + 1',
    'value.current + 1',
    'getValue() + 1',
    '1n + 2',
    '1 / 0',
    '0 / 0',
    '1e308 * 2',
    '2 ** 3',
    "'\\r' + 'x'",
    "'\\n' + 'x'",
    "'\\0' + 'x'",
  ])('preserves runtime evaluation of %s', expression => {
    const { code, helpers } = compileWithTextTransform(
      `<div>{{ ${expression} }}</div>`,
    )
    expect(helpers).toContain('setText')
    expect(code).toContain(expression)
  })

  test('concatenates adjacent folded interpolations as text', () => {
    const { ir, helpers } = compileWithTextTransform(
      '<div>{{ 1 + 2 }}{{ 3 + 4 }}</div>',
    )
    expect([...ir.template.keys()]).toEqual(['<div>37'])
    expect(helpers).not.toContain('setText')
  })

  test.each(['Comp', 'template v-if="ok"'])(
    'materializes markup-like folded text in %s',
    tag => {
      const { code, helpers } = compileWithTextTransform(
        `<${tag}>{{ '<' }}{{ 'b' + '>' }}</${tag.split(' ')[0]}>`,
      )
      expect(code).toContain('_template("")')
      expect(code).not.toContain('_template("<b>")')
      expect(helpers).toContain('setText')
      expect(helpers).not.toContain('toDisplayString')
    },
  )
})
