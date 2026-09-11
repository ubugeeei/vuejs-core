import { createApp, nextTick, ref } from '@vue/runtime-dom'
import { createVaporApp, vaporInteropPlugin } from '../src'
import { compile, makeRender } from './_utils'
import { setupHydrationTest, testHydration } from './hydration/_helpers'

setupHydrationTest()

describe('constant interpolation text', () => {
  const define = makeRender()

  test.each([
    ['pre', '\ntext'],
    ['textarea', '\ntext'],
    ['div', '\r\n\0'],
  ])('preserves parser-sensitive text in %s', (tag, text) => {
    const { host, app } = define(
      compile(
        `<template><${tag}>{{ ${JSON.stringify(text)} + '' }}</${tag}></template>`,
        ref({}),
      ),
    ).render()
    expect(host.firstChild!.textContent).toBe(text)
    if (tag === 'textarea') {
      expect((host.firstChild as HTMLTextAreaElement).value).toBe(text)
    }
    app.unmount()
  })

  test('preserves text boundaries, escaping and dynamic siblings', async () => {
    const data = ref('a')
    const { host, app } = define(
      compile(
        `<template><div>{{ 1 + 2 }}{{ 3 + 4 }}<span>{{ data }}</span>{{ '<b>' + '&' }}<template>{{ '<i>' + '&' }}</template><svg><text>{{ 2 * 3 }}</text></svg></div></template>`,
        data,
      ),
    ).render()
    const span = host.querySelector('span')!
    const tpl = host.querySelector('template')!
    expect(host.firstChild!.firstChild!.textContent).toBe('37')
    expect(span.nextSibling!.textContent).toBe('<b>&')
    expect(host.querySelector('b')).toBeNull()
    expect(tpl.childNodes).toHaveLength(1)
    expect(tpl.firstChild!.nodeType).toBe(Node.TEXT_NODE)
    expect(tpl.firstChild!.textContent).toBe('<i>&')
    expect(host.querySelector('text')!.textContent).toBe('6')
    data.value = 'b'
    await nextTick()
    expect(host.querySelector('span')).toBe(span)
    expect(span.textContent).toBe('b')
    expect(span.nextSibling!.textContent).toBe('<b>&')
    app.unmount()
  })

  test.each([
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ])(
    'hydrates folded slots (parent vapor: %s, child vapor: %s)',
    async (parentVapor, childVapor) => {
      const data = ref({ show: true, value: 'a' })
      const { container, app } = await testHydration(
        `<script setup>const data = _data; const components = _components</script>
         <template><div><components.Child v-if="data.show"><b>{{ 1 + 2 }}{{ data.value }}</b></components.Child><components.Child>{{ '' + '' }}</components.Child><components.Child>{{ '<i>' + '&' }}</components.Child><i>tail</i></div></template>`,
        {
          Child: {
            code: `<script setup>const data = _data</script><template><article>{{ 'head' + ':' }}<slot>fallback</slot></article></template>`,
            vapor: childVapor,
          },
        },
        data,
        { isVaporApp: parentVapor, interop: true },
      )
      expect(container.textContent).toBe('head:3ahead:head:<i>&tail')
      expect(container.querySelectorAll('i')).toHaveLength(1)
      const b = container.querySelector('b')!
      const tail = container.querySelector('i')!
      data.value.value = 'b'
      await nextTick()
      expect(container.querySelector('b')).toBe(b)
      expect(container.textContent).toBe('head:3bhead:head:<i>&tail')
      data.value.show = false
      await nextTick()
      expect(container.textContent).toBe('head:head:<i>&tail')
      expect(container.querySelector('i')).toBe(tail)
      data.value.show = true
      await nextTick()
      expect(container.textContent).toBe('head:3bhead:head:<i>&tail')
      expect(container.querySelector('b')).not.toBe(b)
      app.unmount()
      expect(container.textContent).toBe('')
    },
  )

  test.each([
    [true, true, false],
    [true, false, false],
    [false, true, false],
    [false, false, false],
    [true, true, true],
    [true, false, true],
    [false, true, true],
    [false, false, true],
  ])(
    'preserves folded template positions (parent vapor: %s, child vapor: %s, hydration: %s)',
    async (parentVapor, childVapor, hydration) => {
      const data = ref({ show: true, count: 0, label: 'a' })
      const source = `<script setup>const data = _data; const components = _components</script>
        <template><div><p v-if="data.show">{{ 'left' + '!' }}</p><p v-else>{{ 'right' + '?' }}</p><article><i>{{ 'long' + '&' }}</i><components.Child/>{{ '<' + 'b>' }}<button @click="data.count++" :title="data.label">{{ data.count }}</button></article><b>{{ 1 + 2 }}</b><b>{{ 3 + 4 }}</b><b>{{ data.label }}</b></div></template>`
      const childSource =
        '<script setup>const data = _data</script><template><em>child</em></template>'
      let container: HTMLDivElement
      let app
      if (hydration) {
        ;({ container, app } = await testHydration(
          source,
          { Child: { code: childSource, vapor: childVapor } },
          data,
          { isVaporApp: parentVapor, interop: true },
        ))
      } else {
        container = document.createElement('div')
        document.body.appendChild(container)
        const Child = compile(childSource, data, {}, { vapor: childVapor })
        const Parent = compile(source, data, { Child }, { vapor: parentVapor })
        app = (parentVapor ? createVaporApp : createApp)(Parent)
        app.use(vaporInteropPlugin)
        app.mount(container)
      }
      const button = container.querySelector('button')!
      const child = container.querySelector('em')!
      const values = [...container.querySelectorAll('b')]
      expect(values.map(node => node.textContent)).toEqual(['3', '7', 'a'])
      expect(container.textContent).toBe('left!long&child<b>037a')
      button.click()
      data.value.show = false
      data.value.label = 'b'
      await nextTick()
      expect(container.textContent).toBe('right?long&child<b>137b')
      expect(container.querySelector('button')).toBe(button)
      expect(button.title).toBe('b')
      expect(container.querySelector('em')).toBe(child)
      expect([...container.querySelectorAll('b')]).toEqual(values)
      app.unmount()
      expect(container.textContent).toBe('')
    },
  )

  test.each([true, false])(
    'keeps an empty text node before a component (child vapor: %s)',
    async childVapor => {
      const data = ref(0)
      const Child = compile(
        '<script setup>const data = _data</script><template><em>child</em></template>',
        data,
        {},
        { vapor: childVapor },
      )
      const Parent = compile(
        `<script setup>const data = _data; const components = _components</script><template><div>{{ '' + '' }}<components.Child/><span>{{ data }}</span></div></template>`,
        data,
        { Child },
      )
      const container = document.createElement('div')
      const app = createVaporApp(Parent).use(vaporInteropPlugin)
      app.mount(container)
      expect(container.firstChild!.firstChild!.nodeType).toBe(Node.TEXT_NODE)
      expect(container.textContent).toBe('child0')
      const span = container.querySelector('span')!
      data.value++
      await nextTick()
      expect(container.querySelector('span')).toBe(span)
      expect(container.textContent).toBe('child1')
      app.unmount()
    },
  )
})
