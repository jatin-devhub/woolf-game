import { describe, expect, it } from 'vitest'
import {
  formatRoomCode,
  majorityThreshold,
  roleCountsFor,
  sanitizeDisplayName,
  tallyWinners,
  villageWin,
  wolvesWin,
} from './roles'

describe('roleCountsFor', () => {
  it('matches the documented 3–12 table', () => {
    expect(roleCountsFor(3)).toEqual({ wolves: 1, police: 1, doctor: 0, villagers: 1 })
    expect(roleCountsFor(4)).toEqual({ wolves: 1, police: 1, doctor: 1, villagers: 1 })
    expect(roleCountsFor(5)).toEqual({ wolves: 1, police: 1, doctor: 1, villagers: 2 })
    expect(roleCountsFor(6)).toEqual({ wolves: 1, police: 1, doctor: 1, villagers: 3 })
    expect(roleCountsFor(7)).toEqual({ wolves: 2, police: 1, doctor: 1, villagers: 3 })
    expect(roleCountsFor(9)).toEqual({ wolves: 2, police: 1, doctor: 1, villagers: 5 })
    expect(roleCountsFor(10)).toEqual({ wolves: 3, police: 1, doctor: 1, villagers: 5 })
    expect(roleCountsFor(12)).toEqual({ wolves: 3, police: 1, doctor: 1, villagers: 7 })
  })

  it('always sums to N', () => {
    for (let n = 3; n <= 12; n++) {
      const r = roleCountsFor(n)
      expect(r.wolves + r.police + r.doctor + r.villagers).toBe(n)
    }
  })

  it('rejects invalid counts', () => {
    expect(() => roleCountsFor(2)).toThrow('TOO_FEW_PLAYERS')
    expect(() => roleCountsFor(13)).toThrow('TOO_MANY_PLAYERS')
  })
})

describe('win conditions', () => {
  it('village wins when no wolves left', () => {
    expect(villageWin(0)).toBe(true)
    expect(villageWin(1)).toBe(false)
  })

  it('wolves win on parity or better', () => {
    expect(wolvesWin(1, 1)).toBe(true)
    expect(wolvesWin(2, 2)).toBe(true)
    expect(wolvesWin(1, 2)).toBe(false)
    expect(wolvesWin(0, 3)).toBe(false)
  })
})

describe('tallyWinners', () => {
  it('returns single majority target', () => {
    expect(tallyWinners(['a', 'a', 'b'])).toEqual(['a'])
  })

  it('returns all tied targets', () => {
    expect(tallyWinners(['a', 'b']).sort()).toEqual(['a', 'b'])
  })

  it('ignores null votes', () => {
    expect(tallyWinners([null, undefined, 'x'])).toEqual(['x'])
  })

  it('returns empty when no votes', () => {
    expect(tallyWinners([])).toEqual([])
    expect(tallyWinners([null, null])).toEqual([])
  })

  it('models exile double-tie mass kill set', () => {
    // first ballot tie → revote set
    const first = tallyWinners(['a', 'b', 'a', 'b'])
    expect(first.sort()).toEqual(['a', 'b'])
    // second ballot still tie → eliminate all in set
    const second = tallyWinners(['a', 'b'])
    expect(second.sort()).toEqual(['a', 'b'])
  })
})

describe('helpers', () => {
  it('majorityThreshold', () => {
    expect(majorityThreshold(3)).toBe(2)
    expect(majorityThreshold(4)).toBe(3)
    expect(majorityThreshold(1)).toBe(1)
  })

  it('formatRoomCode', () => {
    expect(formatRoomCode(' ab-c1 ')).toBe('ABC1')
    expect(formatRoomCode('toolongcode')).toBe('TOOLON')
  })

  it('sanitizeDisplayName', () => {
    expect(sanitizeDisplayName('  Jatin  ')).toBe('Jatin')
    expect(sanitizeDisplayName('a'.repeat(30)).length).toBe(24)
    expect(() => sanitizeDisplayName('   ')).toThrow('NAME_REQUIRED')
  })
})
