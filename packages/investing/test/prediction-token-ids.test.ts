/**
 * @fileoverview clobTokenIds arrives from Gamma (and sits in D1) as a JSON
 * string. Indexing that string gave "[" and price history never synced.
 */
import { describe, it, expect } from 'vitest'
import { firstClobTokenId, isValidTokenId, parseClobTokenIds } from '../src/prediction/utils/token-ids'

const YES = '71321045679252212594626385532706912750332728571942532289631379312455583992563'
const NO = '52114319501245915516055106046884209969926127482827954674443846427813813222426'

describe('parseClobTokenIds', () => {
  it('parses the JSON string Gamma returns', () => {
    expect(parseClobTokenIds(`["${YES}", "${NO}"]`)).toEqual([YES, NO])
  })

  it('passes an array through, dropping non-strings and empties', () => {
    expect(parseClobTokenIds([YES, '', 7, null, NO])).toEqual([YES, NO])
  })

  it('parses a double-encoded string', () => {
    expect(parseClobTokenIds(JSON.stringify(JSON.stringify([YES, NO])))).toEqual([YES, NO])
  })

  it('returns [] for a quoted string that is not JSON', () => {
    expect(parseClobTokenIds('"unterminated')).toEqual([])
  })

  it('splits a comma list', () => {
    expect(parseClobTokenIds(`${YES}, ${NO}`)).toEqual([YES, NO])
  })

  it.each([[null], [undefined], [''], ['   '], ['[not json'], [42], [{}]])('returns [] for %p', (value) => {
    expect(parseClobTokenIds(value)).toEqual([])
  })
})

describe('isValidTokenId', () => {
  it('accepts long URL-safe ids', () => {
    expect(isValidTokenId(YES)).toBe(true)
    expect(isValidTokenId('abc_DEF-123')).toBe(true)
  })

  it.each([['['], ['short'], ['has space in it'], ['semi;colon;;;'], [123456789012], [null]])('rejects %p', (value) => {
    expect(isValidTokenId(value)).toBe(false)
  })
})

describe('firstClobTokenId', () => {
  it('returns the Yes token from the JSON string', () => {
    expect(firstClobTokenId(`["${YES}","${NO}"]`)).toBe(YES)
  })

  it('returns the Yes token from an array', () => {
    expect(firstClobTokenId([YES, NO])).toBe(YES)
  })

  it('is null when there is no usable token', () => {
    expect(firstClobTokenId('[]')).toBeNull()
    expect(firstClobTokenId('["bad id"]')).toBeNull()
    expect(firstClobTokenId(undefined)).toBeNull()
  })

  it('never returns the "[" the old string indexing produced', () => {
    const raw = `["${YES}"]`
    expect(raw[0]).toBe('[')
    expect(firstClobTokenId(raw)).not.toBe('[')
  })
})
