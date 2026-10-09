import { describe, expect, it } from 'vitest'
import { parseStrictJson } from './strict-json'

describe('strict JSON payload parsing', () => {
  it('parses valid nested payloads and preserves JSON values', () => {
    expect(parseStrictJson('{"name":"资料\\\"\\n","items":[0,true,null,{"x":-1.25e2}]}')).toEqual({
      name: '资料"\n', items: [0, true, null, { x: -125 }],
    })
  })

  it.each([
    '{"version":1,"version":2}',
    '{"x":1,"\\u0078":2}',
    '{"entries":[{"name":"a","name":"b"}]}',
  ])('rejects duplicate members, including escaped-equivalent keys: %s', (text) => {
    expect(() => parseStrictJson(text)).toThrow(/duplicate/i)
  })

  it.each([
    '{"trailing":1,}',
    '[1,]',
    '{"x":01}',
    '{"x":NaN}',
    '{"x":1} trailing',
    '"unterminated',
  ])('rejects malformed JSON: %s', (text) => {
    expect(() => parseStrictJson(text)).toThrow()
  })

  it('bounds nesting depth', () => {
    expect(() => parseStrictJson('[[[0]]]', 2)).toThrow(/nesting/i)
  })
})
