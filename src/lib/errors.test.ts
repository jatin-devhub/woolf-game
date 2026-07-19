import { describe, expect, it } from 'vitest'
import { friendlyError } from './errors'

describe('friendlyError', () => {
  it('maps known codes', () => {
    expect(friendlyError('NEED_3_PLAYERS')).toMatch(/3 players/i)
    expect(friendlyError('ROOM_NOT_FOUND')).toMatch(/not found/i)
    expect(friendlyError('INVALID_TOKEN')).toMatch(/Session/i)
  })

  it('finds codes embedded in longer messages', () => {
    expect(friendlyError('P0001: HOST_ONLY')).toMatch(/host/i)
  })

  it('passes through unknown messages', () => {
    expect(friendlyError('weird backend thing')).toBe('weird backend thing')
  })
})
