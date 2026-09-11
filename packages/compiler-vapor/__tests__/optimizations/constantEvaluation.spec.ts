import { createSimpleExpression } from '@vue/compiler-dom'
import { parseExpression } from '@babel/parser'
import { foldExpression } from '../../src/optimizations/constantEvaluation'

function fold(content: string): string {
  const expression = createSimpleExpression(content)
  expression.ast = parseExpression(`(${content})`)
  return foldExpression(expression, {}).content
}

describe('computed expression JavaScript semantics', () => {
  // Expected values are independent of the compiler evaluator. In particular,
  // neither JSON serialization nor string conversion distinguishes all of these.
  test.each([
    ['(2 - 3) * 0', -0],
    ['0 / (2 - 3)', -0],
    ['-4 % 2', -0],
    ['1 / ((2 - 3) * 0)', -Infinity],
    ['0 / (2 - 2)', NaN],
    ['1e308 * 2', Infinity],
    ['5e-324 / 2', 0],
    ['-5e-324 / 2', -0],
    ['9007199254740992 + 1', 9007199254740992],
    ['0.1 + 0.2', 0.30000000000000004],
    ['"" + ((2 - 3) * 0)', '0'],
    ['true ? undefined : fail()', undefined],
    ['false ? fail() : null', null],
    ['false ?? fail()', false],
    ['"" ?? fail()', ''],
    ['0 ?? fail()', 0],
    ['(-0) || (2 - 2)', 0],
    ['(-0) && fail()', -0],
    ['1n + 2n', BigInt(3)],
  ])('preserves the value and type of %s', (source, expected) => {
    for (const content of [source, fold(source)]) {
      expect(new Function(`"use strict"; return (${content})`)()).toBe(expected)
    }
  })

  test.each([
    ['true ? data.value : data.fail()', 'value', ['get:value']],
    ['false || data.method', 'method', ['get:method']],
    ['null ?? data.value', 'value', ['get:value']],
    ['delete (true ? data.value : data.fail())', true, ['get:value']],
    ['delete (false || data.value)', true, ['get:value']],
    ['delete (null ?? data.value)', true, ['get:value']],
    [
      '(true ? data.object : data.fail()) + data.right',
      7,
      [
        'get:object',
        'get:right',
        'coerce:left:default',
        'coerce:right:default',
      ],
    ],
    [
      'data.object + (true ? data.right : data.fail())',
      7,
      [
        'get:object',
        'get:right',
        'coerce:left:default',
        'coerce:right:default',
      ],
    ],
  ] as const)(
    'preserves identities and ordered side effects in %s',
    (source, expected, events) => {
      const value = Object.freeze({ marker: 'value' })
      const method = () => value
      const log: string[] = []
      const primitive = (name: string, value: number) => ({
        [Symbol.toPrimitive](hint: string) {
          log.push(`coerce:${name}:${hint}`)
          return value
        },
      })
      const target = {
        value,
        method,
        object: primitive('left', 3),
        right: primitive('right', 4),
        fail() {
          throw new Error('Unselected operand was evaluated')
        },
      }
      const data = new Proxy(target, {
        get(target, key, receiver) {
          log.push(`get:${String(key)}`)
          return Reflect.get(target, key, receiver)
        },
        deleteProperty(target, key) {
          log.push(`delete:${String(key)}`)
          return Reflect.deleteProperty(target, key)
        },
      })
      const result =
        expected === 'value' ? value : expected === 'method' ? method : expected
      for (const content of [source, fold(source)]) {
        log.length = 0
        expect(
          new Function('data', `"use strict"; return (${content})`)(data),
        ).toBe(result)
        expect(log).toEqual(events)
        expect(Object.getOwnPropertyDescriptor(target, 'value')!.value).toBe(
          value,
        )
      }
    },
  )

  test.each([
    'typeof (true ? missing : data.fail())',
    'typeof (false || missing)',
    'typeof (null ?? missing)',
  ])('still throws for an unresolvable selected reference in %s', source => {
    for (const content of [source, fold(source)]) {
      const fail = vi.fn()
      expect(() =>
        new Function('data', `return (${content})`)({ fail }),
      ).toThrow(ReferenceError)
      expect(fail).not.toHaveBeenCalled()
    }
  })

  test.each([
    'true ? data.value : data.fail()',
    'false || data.value',
    'null ?? data.value',
    'delete (true ? data.value : data.fail())',
    'data.left + (true ? data.value : data.fail())',
  ])('throws the original object before later effects in %s', source => {
    const thrown = Object.freeze({ marker: 'thrown' })
    for (const content of [source, fold(source)]) {
      const log: string[] = []
      const data = {
        get value(): never {
          log.push('value')
          throw thrown
        },
        get left() {
          log.push('left')
          return {
            valueOf() {
              log.push('coerce')
              return 1
            },
          }
        },
        fail: vi.fn(),
      }
      let caught: unknown
      try {
        new Function('data', `"use strict"; return (${content})`)(data)
      } catch (error) {
        caught = error
      }
      expect(caught).toBe(thrown)
      expect(log).toEqual(
        source.startsWith('data.left') ? ['left', 'value'] : ['value'],
      )
      expect(data.fail).not.toHaveBeenCalled()
    }
  })
})
