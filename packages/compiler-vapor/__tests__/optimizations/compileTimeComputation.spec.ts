import { type ParserOptions, parse } from '@vue/compiler-dom'
import { compile, getBaseTransformPreset } from '../../src/compile'
import { DynamicFlag, IRNodeTypes, isBlockOperation } from '../../src/ir'
import { transform } from '../../src/transform'
import { optimize } from '../../src/optimize'
import { generate } from '../../src/generate'

function lower(source: string, options: ParserOptions = {}) {
  const [nodeTransforms, directiveTransforms] = getBaseTransformPreset()
  return transform(parse(source, { prefixIdentifiers: true, ...options }), {
    prefixIdentifiers: true,
    nodeTransforms,
    directiveTransforms,
  })
}

describe('compile time computation', () => {
  test('keeps computation in the IR until optimization', () => {
    const ir = lower('<div>{{ 1 + 2 }}</div>')
    expect(ir.template.keys()).toEqual(['<div> '])
    expect(ir.block.operation).toMatchObject([
      { type: IRNodeTypes.GET_TEXT_CHILD },
      { type: IRNodeTypes.SET_TEXT, values: [{ content: '1 + 2' }] },
    ])
    expect(generate(ir, { prefixIdentifiers: true }).helpers).toContain(
      'setText',
    )
    optimize(ir)
    expect(ir.template.keys()).toEqual(['<div>3'])
    expect(ir.block.operation).toEqual([])
    expect(generate(ir, { prefixIdentifiers: true }).helpers).not.toContain(
      'setText',
    )
    expect(
      compile('<div>{{ 1 + 2 }}</div>', { prefixIdentifiers: true }).helpers,
    ).not.toContain('setText')
  })

  test('specializes shared templates without changing dynamic instances', () => {
    const ir = lower(
      '<div>{{ 1 + 2 }}</div><div>{{ 3 + 4 }}</div><div>{{ value }}</div><div>{{ 1 + 2 }}</div>',
    )
    expect(ir.template.keys()).toEqual(['<div> '])
    optimize(ir)
    expect(ir.template.keys()).toEqual(['<div>3', '<div>7', '<div> '])
    expect(ir.block.dynamic.children.map(child => child.template)).toEqual([
      0, 1, 2, 0,
    ])
    expect(ir.block.effect).toHaveLength(1)
    expect(ir.block.operation).toMatchObject([
      { type: IRNodeTypes.GET_TEXT_CHILD, parent: 2 },
    ])
  })

  test('updates multiple nested template ranges and preserves live references', () => {
    const ir = lower(
      `<main><section><b>{{ 'a' + '&' }}</b><i :title="value">{{ 2 + 3 }}</i></section>{{ 'x' + 'y' }}<span>{{ value }}</span></main>`,
    )
    const originalAST = JSON.stringify(ir.node)
    optimize(ir)
    expect(ir.template.keys()).toEqual([
      '<main><section><b>a&amp;</b><i>5</i></section>xy<span> ',
    ])
    const section = ir.block.dynamic.children[0].children[0]
    expect(section.children[0].flags & DynamicFlag.REFERENCED).toBe(0)
    expect(section.children[1].flags & DynamicFlag.REFERENCED).toBeTruthy()
    expect(JSON.stringify(ir.node)).toBe(originalAST)
    const optimizedIR = JSON.stringify(ir)
    optimize(ir)
    expect(JSON.stringify(ir)).toBe(optimizedIR)
  })

  test('remaps operation boundaries after deleting text operations', () => {
    const ir = lower(
      `<div><i>{{ 1 + 2 }}</i><b :id="'before' + ''"/><Comp/><span :id="'after' + ''"/></div>`,
    )
    const component = ir.block.dynamic.children[0].children[2].operation!
    expect(isBlockOperation(component)).toBe(true)
    if (!isBlockOperation(component)) return
    expect(component.operationIndex).toBe(3)
    const effectIndex = component.effectIndex
    optimize(ir)
    expect(component.operationIndex).toBe(1)
    expect(component.effectIndex).toBe(effectIndex)
    expect(ir.block.operation.map(op => op.type)).toEqual([
      IRNodeTypes.SET_PROP,
      IRNodeTypes.SET_PROP,
    ])
    const { code } = generate(ir, { prefixIdentifiers: true })
    expect(code.indexOf("'before'")).toBeLessThan(
      code.indexOf('_createAssetComponent('),
    )
    expect(code.indexOf("'after'")).toBeGreaterThan(
      code.indexOf('_createAssetComponent('),
    )
  })

  test('keeps template ranges valid for a subsequent computation pass', () => {
    const ir = lower(
      `<div><i>{{ 'long' + '&' }}</i>{{ value }}<b>{{ 'x' + 'y' }}</b>{{ other }}</div>`,
    )
    optimize(ir)
    const expression = lower('<div>{{ 2 + 3 }}</div>').block.operation[1]
    expect(expression.type).toBe(IRNodeTypes.SET_TEXT)
    if (expression.type !== IRNodeTypes.SET_TEXT) return
    // Simulate a later rule proving the remaining runtime expressions constant.
    for (const effect of ir.block.effect) {
      for (const operation of effect.operations) {
        if (operation.type === IRNodeTypes.SET_TEXT) {
          operation.values = expression.values
          ir.block.operation.push(operation)
        }
      }
    }
    ir.block.effect = []
    optimize(ir)
    expect(ir.template.keys()).toEqual(['<div><i>long&amp;</i>5<b>xy</b>5'])
    expect(generate(ir, { prefixIdentifiers: true }).helpers).not.toContain(
      'setText',
    )
  })

  test.each([
    '<div v-if="ok">{{ 1 + 2 }}</div><div v-else-if="other">{{ 2 + 2 }}</div><div v-else>{{ 3 + 2 }}</div>',
    '<div v-for="item in items">{{ 1 + 2 }}</div>',
    '<div :key="key">{{ 1 + 2 }}</div>',
    '<slot><div>{{ 1 + 2 }}</div></slot>',
    '<Comp><template #default><div>{{ 1 + 2 }}</div></template></Comp>',
    '<Comp><template #[name]><div>{{ 1 + 2 }}</div></template></Comp>',
    '<Comp><template v-for="name in names" #[name]><div>{{ 1 + 2 }}</div></template></Comp>',
    '<Comp><template v-if="ok" #default><div>{{ 1 + 2 }}</div></template><template v-else #default><div>{{ 2 + 2 }}</div></template></Comp>',
  ])('visits nested blocks in %s', source => {
    const ir = lower(source)
    const templates = ir.template.entries.map(entry => ({ ...entry }))
    optimize(ir)
    expect(ir.template.keys()).toContain('<div>3')
    expect(generate(ir, { prefixIdentifiers: true }).helpers).not.toContain(
      'setText',
    )
    expect(
      ir.template.entries.every(entry =>
        templates.some(
          original =>
            original.ns === entry.ns &&
            original.root === entry.root &&
            original.static === entry.static,
        ),
      ),
    ).toBe(true)
  })

  test('preserves namespaces when specializing templates', () => {
    const ir = lower(
      '<svg><text>{{ 1 + 2 }}</text></svg><math><mtext>{{ 3 + 4 }}</mtext></math>',
    )
    const namespaces = ir.template.entries.map(entry => entry.ns)
    optimize(ir)
    expect(ir.template.entries.map(entry => entry.ns)).toEqual(namespaces)
    expect(ir.template.keys()).toEqual(['<svg><text>3', '<math><mtext>7'])
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
    const { ir, helpers } = compileWithOptimization(
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
    const { code, helpers } = compileWithOptimization(
      `<div>{{ ${expression} }}</div>`,
    )
    expect(helpers).toContain('setText')
    expect(code).toContain(expression)
  })

  test('concatenates adjacent folded interpolations as text', () => {
    const { ir, helpers } = compileWithOptimization(
      '<div>{{ 1 + 2 }}{{ 3 + 4 }}</div>',
    )
    expect([...ir.template.keys()]).toEqual(['<div>37'])
    expect(helpers).not.toContain('setText')
  })

  test.each(['Comp', 'template v-if="ok"'])(
    'materializes markup-like folded text in %s',
    tag => {
      const { code, helpers } = compileWithOptimization(
        `<${tag}>{{ '<' }}{{ 'b' + '>' }}</${tag.split(' ')[0]}>`,
      )
      expect(code).toMatch(/_template\(" ?"\)/)
      expect(code).not.toContain('_template("<b>")')
      expect(helpers).toContain('setText')
      expect(helpers).not.toContain('toDisplayString')
    },
  )
})

function compileWithOptimization(source: string, options: ParserOptions = {}) {
  const ir = lower(source, options)
  optimize(ir)
  return { ir, ...generate(ir, { prefixIdentifiers: true }) }
}
