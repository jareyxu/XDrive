import { expect, test } from 'vitest'
import fixture from '../../../tests/testdata/crypto-encoding.json'
import { lp, u32be, u64be, utf8Strict } from './encoding'
import { chunkAAD, manifestAAD, thumbnailAAD } from './aad'
const hex = (bytes: Uint8Array) => [...bytes].map(value => value.toString(16).padStart(2, '0')).join('')
test.each(fixture.u32)('uint32 $decimal matches Go/Node bytes', value => expect(hex(u32be(Number(value.decimal)))).toBe(value.hex))
test.each(fixture.u64)('uint64 $decimal matches Go/Node bytes without Number coercion', value => expect(hex(u64be(BigInt(value.decimal)))).toBe(value.hex))
test.each(fixture.lp)('UTF-8 LP $hex preserves exact string bytes', value => expect(hex(lp(utf8Strict(value.value)))).toBe(value.hex))
test('number admission refuses lossy, fractional, negative and overflowing encodings', () => {
  expect(hex(u64be(Number.MAX_SAFE_INTEGER))).toBe('001fffffffffffff')
  for (const value of [Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, -1, 0.5]) expect(() => u64be(value)).toThrow(RangeError)
  for (const value of [-1n, 18446744073709551616n]) expect(() => u64be(value)).toThrow(RangeError)
  for (const value of [-1, 4294967296, NaN, Infinity, 0.5]) expect(() => u32be(value)).toThrow(RangeError)
})
test('unpaired UTF-16 and unknown object AAD versions fail closed', () => {
  for (const value of ['\ud800', '\udfff', 'ok\ud800suffix']) expect(() => utf8Strict(value)).toThrow(TypeError)
  for (const version of [0, 3, 255, 4294967295]) {
    const unsupported = version as 1 | 2
    expect(() => chunkAAD({ fileId: 'valid', chunkIndex: 0, chunkCount: 0, plaintextSize: 0 }, unsupported)).toThrow(TypeError)
    expect(() => manifestAAD('valid', unsupported)).toThrow(TypeError)
    expect(() => thumbnailAAD('valid', unsupported)).toThrow(TypeError)
  }
})
