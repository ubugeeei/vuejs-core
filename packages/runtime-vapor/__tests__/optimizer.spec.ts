import { createApp, nextTick, ref } from '@vue/runtime-dom'
import { createVaporApp, createVaporSSRApp, vaporInteropPlugin } from '../src'
import { compile } from './_utils'
import { setupHydrationTest, testHydration } from './hydration/_helpers'

setupHydrationTest()

for (const optLevel of [0, 1, 2] as const) {
  describe(`IR optimizer level ${optLevel}`, () => {
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
      'preserves branches, slots and keyed lists (parent: %s, child: %s, hydration: %s)',
      async (parentVapor, childVapor, hydration) => {
        const fail = vi.fn(() => 'unreachable')
        const data = ref({
          label: 'a',
          clicks: 0,
          fail,
          items: [
            { id: 1, name: 'one' },
            { id: 2, name: 'two' },
          ],
        })
        const source = `<script setup>const data = _data; const components = _components</script>
        <template><main><section v-if="(2 + 3) * 4 === 20"><p>{{ 1 + 2 + 3 }}</p><components.Child :count="(2 + 3) * 4"><span>{{ data.label }}{{ 2 + 3 }}</span></components.Child><ul><li v-for="item in data.items" :key="item.id"><b>{{ 'n' + ':' }}</b>{{ item.name }}{{ 1 + 2 }}</li></ul><button @click.delegate="data.clicks++" :title="data.label">{{ data.clicks }} / {{ data.label }}</button></section><section v-else>{{ data.fail() }}</section><p v-if="2 > 3">{{ data.fail() }}</p><i>{{ data.label }}</i></main></template>`
        const childSource = `<script setup>const props = defineProps({ count: Number })</script><template><article>{{ typeof props.count }}:{{ props.count }}<slot/></article></template>`
        const compilerOptions = { optLevel }
        let container: HTMLDivElement
        let app
        if (hydration) {
          ;({ container, app } = await testHydration(
            source,
            {
              Child: { code: childSource, vapor: childVapor },
            },
            data,
            { isVaporApp: parentVapor, interop: true, compilerOptions },
          ))
        } else {
          container = document.createElement('div')
          document.body.appendChild(container)
          const Child = compile(
            childSource,
            data,
            {},
            { vapor: childVapor, compilerOptions },
          )
          const Parent = compile(
            source,
            data,
            { Child },
            { vapor: parentVapor, compilerOptions },
          )
          app = (parentVapor ? createVaporApp : createApp)(Parent).use(
            vaporInteropPlugin,
          )
          app.mount(container)
        }
        expect(container.textContent).toBe('6number:20a5n:one3n:two30 / aa')
        const paragraph = container.querySelector('p')!
        const article = container.querySelector('article')!
        const items = [...container.querySelectorAll('li')]
        const button = container.querySelector('button')!
        button.click()
        data.value.label = 'b'
        data.value.items.reverse()
        await nextTick()
        expect(container.textContent).toBe('6number:20b5n:two3n:one31 / bb')
        expect(container.querySelector('p')).toBe(paragraph)
        expect(container.querySelector('article')).toBe(article)
        expect([...container.querySelectorAll('li')]).toEqual(items.reverse())
        expect(container.querySelector('button')).toBe(button)
        expect(button.title).toBe('b')
        expect(fail).not.toHaveBeenCalled()
        app.unmount()
        expect(container.textContent).toBe('')
      },
    )

    test('keeps asset resolution before earlier sibling setup', () => {
      const data = ref({ replace: () => {} })
      const oldChild = compile(
        '<script setup>const data = _data</script><template><b>old</b></template>',
        data,
      )
      const newChild = compile(
        '<script setup>const data = _data</script><template><b>new</b></template>',
        data,
      )
      const Mutator = compile(
        '<script setup>_data.value.replace()</script><template><i>mutator</i></template>',
        data,
      )
      const Parent = compile(
        '<script setup>const data = _data</script><template><main><Mutator/><Child v-if="false"/><Child/></main></template>',
        data,
        {},
        { compilerOptions: { optLevel } },
      )
      const container = document.createElement('div')
      const app = createVaporApp(Parent)
      app.component('Mutator', Mutator)
      app.component('Child', oldChild)
      data.value.replace = () => {
        app._context.components.Child = newChild
      }
      app.mount(container)
      expect(container.textContent).toBe('mutatorold')
      app.unmount()
    })

    test('preserves static templates across hydration and later mounts', async () => {
      const source = `<script setup>const data = _data</script><template><section><div>{{ (2 + 3) * 4 }}</div></section></template>`
      const data = ref({})
      const Component = compile(
        source,
        data,
        {},
        { compilerOptions: { optLevel } },
      )
      const container = document.createElement('div')
      container.innerHTML = '<section class="server"><div>20</div></section>'
      const serverNode = container.firstChild
      const app = createVaporSSRApp(Component, { class: 'server' })
      app.mount(container)
      expect(container.firstChild).toBe(serverNode)
      expect(container.innerHTML).toBe(
        '<section class="server"><div>20</div></section>',
      )
      app.unmount()
      const first = document.createElement('div')
      const second = document.createElement('div')
      const a = createVaporApp(Component)
      const b = createVaporApp(Component)
      a.mount(first)
      b.mount(second)
      expect(first.innerHTML).toBe('<section><div>20</div></section>')
      expect(second.innerHTML).toBe(first.innerHTML)
      expect(first.firstChild).not.toBe(second.firstChild)
      a.unmount()
      b.unmount()
    })
  })
}
