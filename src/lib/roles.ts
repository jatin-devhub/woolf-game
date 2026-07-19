/**
 * Canonical MVP role distribution (must match supabase/schema.sql `_wg_role_counts`).
 * 3 players: 1 wolf, 1 police, 1 villager (no doctor — imperfect but playable).
 */
export type RoleCounts = {
  wolves: number
  police: number
  doctor: number
  villagers: number
}

export function roleCountsFor(playerCount: number): RoleCounts {
  if (playerCount < 3) {
    throw new Error('TOO_FEW_PLAYERS')
  }
  if (playerCount > 12) {
    throw new Error('TOO_MANY_PLAYERS')
  }

  let wolves: number
  const police = 1
  let doctor: number

  if (playerCount === 3) {
    wolves = 1
    doctor = 0
  } else if (playerCount <= 6) {
    wolves = 1
    doctor = 1
  } else if (playerCount <= 9) {
    wolves = 2
    doctor = 1
  } else {
    wolves = 3
    doctor = 1
  }

  const villagers = playerCount - wolves - police - doctor
  if (villagers < 0) {
    throw new Error('BAD_ROLE_MATH')
  }

  return { wolves, police, doctor, villagers }
}

export function majorityThreshold(voterCount: number): number {
  return Math.floor(voterCount / 2) + 1
}

/** True when living wolves >= living non-wolves (wolves win). */
export function wolvesWin(livingWolves: number, livingNonWolves: number): boolean {
  return livingWolves > 0 && livingWolves >= livingNonWolves
}

export function villageWin(livingWolves: number): boolean {
  return livingWolves === 0
}

/**
 * Tally votes: map targetId -> count. Returns winners (all with max count).
 * Empty votes → empty winners.
 */
export function tallyWinners(votes: Array<string | null | undefined>): string[] {
  const counts = new Map<string, number>()
  for (const v of votes) {
    if (!v) continue
    counts.set(v, (counts.get(v) || 0) + 1)
  }
  if (counts.size === 0) return []
  let max = 0
  for (const c of counts.values()) max = Math.max(max, c)
  return [...counts.entries()].filter(([, c]) => c === max).map(([id]) => id)
}

export function formatRoomCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6)
}

export function sanitizeDisplayName(raw: string, max = 24): string {
  const t = raw.trim().replace(/\s+/g, ' ')
  if (!t) throw new Error('NAME_REQUIRED')
  return t.slice(0, max)
}
