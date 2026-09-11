import { createApp, nextTick, ref } from '@vue/runtime-dom'
import { createVaporApp, createVaporSSRApp, vaporInteropPlugin } from '../src'
import { compile } from './_utils'
import { setupHydrationTest, testHydration } from './hydration/_helpers'

setupHydrationTest()

function descendants(container: Node): Node[] {
  const walker = document.createTreeWalker(
    container,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
  )
  const nodes: Node[] = []
  while (walker.nextNode()) nodes.push(walker.currentNode)
  return nodes
}

function expectSameNodes(actual: Node[], expected: Node[]): void {
  expect(actual).toHaveLength(expected.length)
  actual.forEach((node, index) => expect(node).toBe(expected[index]))
}

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
        let serverNodes: Node[] = []
        if (hydration) {
          ;({ container, app } = await testHydration(
            source,
            {
              Child: { code: childSource, vapor: childVapor },
            },
            data,
            {
              isVaporApp: parentVapor,
              interop: true,
              compilerOptions,
              beforeHydrate: container => {
                serverNodes = descendants(container)
              },
            },
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
        if (hydration) {
          const nodes = descendants(container)
          const adopted = new Set(serverNodes)
          // VDOM may add an empty text anchor after a Vapor component.
          for (const node of nodes.filter(node => !adopted.has(node))) {
            expect(node.nodeType).toBe(Node.TEXT_NODE)
            expect(node.textContent).toBe('')
          }
          expectSameNodes(
            nodes.filter(node => adopted.has(node)),
            serverNodes,
          )
        }
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
        expectSameNodes([...container.querySelectorAll('li')], items.reverse())
        expect(container.querySelector('button')).toBe(button)
        expect(button.title).toBe('b')
        expect(fail).not.toHaveBeenCalled()
        app.unmount()
        expect(container.textContent).toBe('')
      },
    )

    test('toggles computed static branches without losing neighbouring effects or list ownership', async () => {
      const data = ref({ show: true, value: 'a', items: [1, 2] })
      const Component = compile(
        `<script setup>const data = _data</script><template><main><div v-if="data.show">{{ true ? 20 : data.fail() }}</div><i v-else>{{ 2 + 3 }}</i><ul><li v-for="item in data.items" :key="item"><b v-if="data.show">{{ true ? 20 : data.fail() }}</b><em v-else>{{ 2 + 3 }}</em>{{ item }}{{ data.value }}</li></ul><strong>{{ data.value }}</strong></main></template>`,
        data,
        {},
        { compilerOptions: { optLevel } },
      )
      const container = document.createElement('div')
      const app = createVaporApp(Component)
      app.mount(container)
      const rows = [...container.querySelectorAll('li')]
      expect(container.textContent).toBe('20201a202aa')
      data.value.show = false
      data.value.value = 'b'
      data.value.items.reverse()
      await nextTick()
      expect(container.textContent).toBe('552b51bb')
      expectSameNodes([...container.querySelectorAll('li')], rows.reverse())
      data.value.show = true
      await nextTick()
      expect(container.textContent).toBe('20202b201bb')
      app.unmount()
      data.value.value = 'c'
      await nextTick()
      expect(container.innerHTML).toBe('')
    })

    test.each([
      [true, true],
      [true, false],
      [false, true],
      [false, false],
    ])(
      'hydrates and switches computed slot branches (parent %s, child %s)',
      async (parentVapor, childVapor) => {
        const data = ref({
          show: true,
          value: 'a',
          fail: vi.fn(() => 'unreachable'),
        })
        const { container, app } = await testHydration(
          `<script setup>const data = _data; const components = _components</script><template><main><components.Child><b v-if="data.show">{{ true ? 20 : data.fail() }}</b><i v-else>{{ 2 + 3 }}</i></components.Child><u>{{ true ? data.value : data.fail() }}</u></main></template>`,
          {
            Child: {
              code: '<template><article><slot>fallback</slot></article></template>',
              vapor: childVapor,
            },
          },
          data,
          {
            isVaporApp: parentVapor,
            interop: true,
            compilerOptions: { optLevel },
          },
        )
        const article = container.querySelector('article')
        expect(container.textContent).toBe('20a')
        for (const show of [false, true, false]) {
          data.value.show = show
          data.value.value = show ? 'a' : 'b'
          await nextTick()
          expect(container.textContent).toBe(show ? '20a' : '5b')
          expect(container.querySelector('article')).toBe(article)
        }
        expect(data.value.fail).not.toHaveBeenCalled()
        app.unmount()
        expect(container.innerHTML).toBe('')
      },
    )

    test('preserves getter reads and deletion semantics in a selected expression', () => {
      const getter = vi.fn(() => 2)
      const target = Object.defineProperty({}, 'value', {
        get: getter,
        configurable: true,
      })
      const Component = compile(
        '<script setup>const data = _data</script><template><div>{{ delete (true ? data.value : data.fail()) }}</div></template>',
        ref(target),
        {},
        { compilerOptions: { optLevel } },
      )
      const container = document.createElement('div')
      const app = createVaporApp(Component)
      app.mount(container)
      expect(container.textContent).toBe('true')
      expect(Object.getOwnPropertyDescriptor(target, 'value')!.get).toBe(getter)
      expect(getter).toHaveBeenCalledTimes(1)
      app.unmount()
    })

    test.each([true, false])(
      'preserves computed prop values and identities (child vapor: %s)',
      childVapor => {
        const capture = vi.fn()
        const method = vi.fn()
        const object = Object.freeze({ marker: 'identity' })
        const fail = vi.fn(() => {
          throw new Error('Unreachable prop')
        })
        const data = ref({ capture, method, object, fail })
        const compilerOptions = { optLevel }
        const Child = compile(
          `<script setup>
        import { onMounted } from 'vue'
        const props = defineProps(['negativeZero', 'nan', 'infinity', 'nil', 'missing', 'truth', 'text', 'object', 'method'])
        onMounted(() => _data.value.capture(props.negativeZero, props.nan, props.infinity, props.nil, props.missing, props.truth, props.text, props.object, props.method))
        </script><template><article/></template>`,
          data,
          {},
          { vapor: childVapor, compilerOptions },
        )
        const Parent = compile(
          `<script setup>const data = _data; const Child = _components.Child</script><template><main><Child :negative-zero="(2 - 3) * 0" :nan="0 / 0" :infinity="1 / ((2 - 3) * 0)" :nil="false ? data.fail() : null" :missing="true ? undefined : data.fail()" :truth="1 === 1" :text="'a' + 'b'" :object="true ? data.object : data.fail()" :method="false || data.method"/></main></template>`,
          data,
          { Child },
          { compilerOptions },
        )
        const container = document.createElement('div')
        const app = createVaporApp(Parent).use(vaporInteropPlugin)
        app.mount(container)
        expect(capture).toHaveBeenCalledTimes(1)
        const expected = [
          -0,
          NaN,
          -Infinity,
          null,
          undefined,
          true,
          'ab',
          object,
          method,
        ]
        expect(capture.mock.calls[0]).toHaveLength(expected.length)
        expected.forEach((value, index) =>
          expect(capture.mock.calls[0][index]).toBe(value),
        )
        expect(method).not.toHaveBeenCalled()
        expect(fail).not.toHaveBeenCalled()
        app.unmount()
      },
    )

    test('keeps live effect evaluation on the correct side of component setup', () => {
      const log: string[] = []
      let value = 'a'
      const data = ref({
        read(label: string) {
          log.push(`${label}:${value}`)
          return value
        },
        mutate() {
          log.push('setup')
          value = 'b'
        },
        fail() {
          throw new Error('Unreachable expression')
        },
      })
      const Mutator = compile(
        '<script setup>_data.value.mutate()</script><template><em>child</em></template>',
        data,
      )
      const Parent = compile(
        `<script setup>const data = _data; const Mutator = _components.Mutator</script><template><main><i>{{ false && data.fail() }}</i><p>{{ data.read('before') }}</p><Mutator/><b>{{ true ? 20 : data.fail() }}</b><u>{{ data.read('after') }}</u></main></template>`,
        data,
        { Mutator },
        { compilerOptions: { optLevel } },
      )
      const container = document.createElement('div')
      const app = createVaporApp(Parent)
      app.mount(container)
      expect(log).toEqual(['before:a', 'setup', 'after:b'])
      expect(container.querySelector('p')!.textContent).toBe('a')
      expect(container.querySelector('u')!.textContent).toBe('b')
      app.unmount()
      expect(log).toEqual(['before:a', 'setup', 'after:b'])
    })

    test('preserves delegated handler order, multiplicity and receiver after replacement', async () => {
      const log: string[] = []
      const data = ref({
        show: true,
        first(event: MouseEvent) {
          expect(this).toBe(data.value)
          expect(event.target).toBe(event.currentTarget)
          log.push('first')
        },
        second() {
          expect(this).toBe(data.value)
          log.push('second')
        },
        parent() {
          log.push('parent')
        },
      })
      const Component = compile(
        `<script setup>const data = _data</script><template><main @click.delegate="data.parent"><button v-if="data.show" @click.delegate.foo="data.first" @click.delegate.bar="data.second">{{ 2 + 3 }}</button><i v-else>{{ 3 + 4 }}</i></main></template>`,
        data,
        {},
        { compilerOptions: { optLevel } },
      )
      const container = document.createElement('div')
      document.body.appendChild(container)
      const app = createVaporApp(Component)
      app.mount(container)
      const first = container.querySelector('button')!
      first.click()
      expect(log).toEqual(['first', 'second', 'parent'])
      data.value.show = false
      await nextTick()
      data.value.show = true
      await nextTick()
      const second = container.querySelector('button')!
      expect(second).not.toBe(first)
      log.length = 0
      second.click()
      expect(log).toEqual(['first', 'second', 'parent'])
      app.unmount()
      log.length = 0
      first.click()
      second.click()
      expect(log).toEqual([])
    })

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

    test.each([
      [true, true],
      [true, false],
      [false, true],
      [false, false],
    ])(
      'retains keyed component instances and disposes removed work (parent %s, child %s)',
      async (parentVapor, childVapor) => {
        const allocate = vi.fn((id: number) => Symbol(id))
        const read = vi.fn()
        const dispose = vi.fn()
        const unmounted = vi.fn()
        const data = ref({
          items: [
            { id: 1, name: 'one' },
            { id: 2, name: 'two' },
          ],
          label: 'a',
          allocate,
          read,
          dispose,
          unmounted,
        })
        const { container, app } = await testHydration(
          `<script setup>const data = _data; const components = _components</script><template><main><components.Child v-for="item in data.items" :key="item.id" :row="item"><b>{{ true ? data.label : data.fail() }}{{ 2 + 3 }}</b></components.Child><i>{{ 3 + 4 }}</i></main></template>`,
          {
            Child: {
              vapor: childVapor,
              code: `<script setup>
          import { watchEffect, onScopeDispose, onUnmounted } from 'vue'
          const props = defineProps(['row'])
          const data = _data
          const token = data.value.allocate(props.row.id)
          watchEffect(() => data.value.read(token, props.row.name))
          onScopeDispose(() => data.value.dispose(token))
          onUnmounted(() => data.value.unmounted(token))
          </script><template><article :data-id="props.row.id"><input :value="props.row.name"/><span>{{ props.row.name }}{{ 1 + 2 }}</span><slot/></article></template>`,
            },
          },
          data,
          {
            isVaporApp: parentVapor,
            interop: true,
            compilerOptions: { optLevel },
            beforeHydrate: () => {
              // SSR runs setup too; only client ownership is observed below.
              allocate.mockClear()
              read.mockClear()
              dispose.mockClear()
              unmounted.mockClear()
            },
          },
        )
        expect(allocate.mock.calls).toEqual([[1], [2]])
        const [one, two] = allocate.mock.results.map(result => result.value)
        expect(read.mock.calls).toEqual([
          [one, 'one'],
          [two, 'two'],
        ])
        const [first, second] = [...container.querySelectorAll('article')]
        const input = first.querySelector('input')!
        input.value = 'user edit'
        data.value.items.reverse()
        await nextTick()
        expectSameNodes(
          [...container.querySelectorAll('article')],
          [second, first],
        )
        expect(first.querySelector('input')).toBe(input)
        expect(input.value).toBe('user edit')
        expect(allocate).toHaveBeenCalledTimes(2)
        expect(read).toHaveBeenCalledTimes(2)
        expect(dispose).not.toHaveBeenCalled()
        expect(unmounted).not.toHaveBeenCalled()

        const removed = data.value.items.pop()!
        await nextTick()
        expect(dispose).toHaveBeenCalledExactlyOnceWith(one)
        expect(unmounted).toHaveBeenCalledExactlyOnceWith(one)
        expect(first.parentNode).toBeNull()
        const detached = first.innerHTML
        removed.name = 'removed'
        data.value.label = 'b'
        await nextTick()
        expect(read).toHaveBeenCalledTimes(2)
        expect(first.innerHTML).toBe(detached)
        expect(second.querySelector('b')!.textContent).toBe('b5')

        data.value.items.unshift(removed)
        await nextTick()
        expect(allocate.mock.calls).toEqual([[1], [2], [1]])
        const replacement = container.querySelector('article')!
        expect(replacement).not.toBe(first)
        expect(container.querySelectorAll('article')[1]).toBe(second)
        expect(replacement.querySelector('input')!.value).toBe('removed')
        const newOne = allocate.mock.results[2].value
        expect(newOne).not.toBe(one)
        expect(read.mock.calls).toEqual([
          [one, 'one'],
          [two, 'two'],
          [newOne, 'removed'],
        ])
        app.unmount()
        await nextTick()
        expect(dispose.mock.calls.map(([token]) => token)).toEqual([
          one,
          newOne,
          two,
        ])
        expect(unmounted.mock.calls.map(([token]) => token)).toEqual([
          one,
          newOne,
          two,
        ])
        const last = replacement.innerHTML
        data.value.items[0].name = 'after unmount'
        data.value.items[1].name = 'also after unmount'
        data.value.label = 'c'
        await nextTick()
        expect(read).toHaveBeenCalledTimes(3)
        expect(dispose).toHaveBeenCalledTimes(3)
        expect(unmounted).toHaveBeenCalledTimes(3)
        expect(replacement.innerHTML).toBe(last)
        expect(first.innerHTML).toBe(detached)
        expect(container.innerHTML).toBe('')
      },
    )

    test('disposes branch refs, directive effects and cleanup exactly once', async () => {
      const capture = vi.fn()
      const read = vi.fn()
      const dispose = vi.fn()
      const teardown = vi.fn()
      const fail = vi.fn(() => {
        throw new Error('unreachable')
      })
      const data = ref({
        show: true,
        value: 'a',
        capture,
        read,
        dispose,
        teardown,
        fail,
      })
      const Component = compile(
        `<script setup>
        import { watchEffect, onScopeDispose } from 'vue'
        const data = _data
        const capture = data.value.capture
        const vProbe = (el, value) => {
          watchEffect(() => {
            const current = value()
            data.value.read(el, current)
            el.setAttribute('data-probe', current)
          })
          onScopeDispose(() => data.value.dispose(el))
          return () => data.value.teardown(el)
        }
        </script><template><main><section v-if="data.show"><b>{{ 2 + 3 }}</b><p :ref="capture" v-probe="data.value">{{ true ? data.value : data.fail() }}</p></section><i v-else>{{ 3 + 4 }}</i><u>{{ data.value }}</u></main></template>`,
        data,
        {},
        { compilerOptions: { optLevel } },
      )
      const container = document.createElement('div')
      const app = createVaporApp(Component)
      app.mount(container)
      const first = container.querySelector('p')!
      expect(capture).toHaveBeenCalledTimes(1)
      expect(capture.mock.calls[0][0]).toBe(first)
      expect(read.mock.calls).toEqual([[first, 'a']])
      expect(first.outerHTML).toBe('<p data-probe="a">a</p>')

      data.value.value = 'b'
      await nextTick()
      expect(container.querySelector('p')).toBe(first)
      expect(read).toHaveBeenCalledTimes(2)
      expect(read.mock.calls[1]).toEqual([first, 'b'])
      expect(first.outerHTML).toBe('<p data-probe="b">b</p>')
      expect(capture).toHaveBeenCalledTimes(2)
      expect(capture.mock.calls[1][0]).toBe(first)
      expect(dispose).not.toHaveBeenCalled()
      expect(teardown).not.toHaveBeenCalled()

      data.value.show = false
      await nextTick()
      expect(first.parentNode!.parentNode).toBeNull()
      expect(capture).toHaveBeenCalledTimes(3)
      expect(capture.mock.calls[2][0]).toBeNull()
      expect(dispose).toHaveBeenCalledExactlyOnceWith(first)
      expect(teardown).toHaveBeenCalledExactlyOnceWith(first)
      data.value.value = 'c'
      await nextTick()
      expect(read).toHaveBeenCalledTimes(2)
      expect(first.outerHTML).toBe('<p data-probe="b">b</p>')
      expect(container.querySelector('u')!.textContent).toBe('c')

      data.value.show = true
      await nextTick()
      const second = container.querySelector('p')!
      expect(second).not.toBe(first)
      expect(capture).toHaveBeenCalledTimes(4)
      expect(capture.mock.calls[3][0]).toBe(second)
      expect(read).toHaveBeenCalledTimes(3)
      expect(read.mock.calls[2]).toEqual([second, 'c'])
      expect(second.outerHTML).toBe('<p data-probe="c">c</p>')
      app.unmount()
      expect(capture).toHaveBeenCalledTimes(5)
      expect(capture.mock.calls[4][0]).toBeNull()
      expect(dispose).toHaveBeenCalledTimes(2)
      expect(dispose.mock.calls[1][0]).toBe(second)
      expect(teardown).toHaveBeenCalledTimes(2)
      expect(teardown.mock.calls[1][0]).toBe(second)
      data.value.value = 'd'
      data.value.show = false
      await nextTick()
      expect(read).toHaveBeenCalledTimes(3)
      expect(first.outerHTML).toBe('<p data-probe="b">b</p>')
      expect(second.outerHTML).toBe('<p data-probe="c">c</p>')
      expect(container.innerHTML).toBe('')
      expect(fail).not.toHaveBeenCalled()
    })

    test.each(['{{ (2 + 3) * 4 }}', '20'])(
      'preserves static templates across hydration and later mounts: %s',
      async text => {
        const source = `<script setup>const data = _data</script><template><section><div>${text}</div></section></template>`
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
      },
    )
  })
}
