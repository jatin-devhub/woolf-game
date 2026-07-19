/**
 * Multi-player RPC harness for integration / smoke tests.
 * Talks to whatever VITE_SUPABASE_* points at (cloud or local).
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

export function loadEnv() {
  const path = resolve(root, '.env')
  if (!existsSync(path)) return
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (!m) continue
    let val = m[2].replace(/^["']|["']$/g, '')
    if (!process.env[m[1]]) process.env[m[1]] = val
  }
}

loadEnv()

export function getConfig() {
  const url = process.env.VITE_SUPABASE_URL
  const key = process.env.VITE_SUPABASE_ANON_KEY
  if (!url || !key) {
    throw new Error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY')
  }
  return { url, key }
}

export async function rpc(name, body) {
  const { url, key } = getConfig()
  const res = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let data
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  if (!res.ok) {
    const msg = data?.message || data?.error || text || res.statusText
    const err = new Error(`${name}: ${msg}`)
    err.code = data?.code
    err.status = res.status
    err.raw = data
    throw err
  }
  return data
}

export function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

/** Create host + N-1 joiners. Returns { roomId, code, players: Session[] } */
export async function openLobby(names, useTimers = false) {
  assert(names.length >= 1, 'need at least one name')
  const host = await rpc('create_room', {
    p_display_name: names[0],
    p_use_timers: useTimers,
  })
  const players = [
    {
      name: host.display_name,
      playerId: host.player_id,
      token: host.token,
      isHost: true,
    },
  ]
  for (let i = 1; i < names.length; i++) {
    const j = await rpc('join_room', {
      p_code: host.code,
      p_display_name: names[i],
    })
    players.push({
      name: j.display_name,
      playerId: j.player_id,
      token: j.token,
      isHost: false,
    })
  }
  return { roomId: host.room_id, code: host.code, players }
}

export async function state(roomId, token) {
  return rpc('get_room_state', { p_room_id: roomId, p_token: token })
}

export async function tick(roomId, token) {
  return rpc('tick_room', { p_room_id: roomId, p_token: token })
}

export async function start(roomId, hostToken) {
  return rpc('start_game', { p_room_id: roomId, p_token: hostToken })
}

export async function advance(roomId, hostToken) {
  return rpc('host_advance', { p_room_id: roomId, p_token: hostToken })
}

export async function ready(roomId, token) {
  return rpc('player_ready', { p_room_id: roomId, p_token: token })
}

export async function nightAction(roomId, token, actionType, targetId) {
  return rpc('submit_night_action', {
    p_room_id: roomId,
    p_token: token,
    p_action_type: actionType,
    p_target_id: targetId,
  })
}

export async function dayVote(roomId, token, stage, targetId) {
  return rpc('submit_day_vote', {
    p_room_id: roomId,
    p_token: token,
    p_stage: stage,
    p_target_id: targetId,
  })
}

export async function playAgain(roomId, hostToken) {
  return rpc('play_again', { p_room_id: roomId, p_token: hostToken })
}

/** Snapshot every seat's private view */
export async function allStates(roomId, players) {
  const out = []
  for (const p of players) {
    out.push({ ...p, state: await state(roomId, p.token) })
  }
  return out
}

export function byRole(snapshots) {
  const map = {}
  for (const s of snapshots) {
    const role = s.state.you.role
    if (!map[role]) map[role] = []
    map[role].push(s)
  }
  return map
}

export function livingPlayers(st) {
  return st.players.filter((p) => p.is_alive)
}

export function assertNoRoleLeak(st) {
  for (const p of st.players) {
    if (p.is_alive && st.room.phase !== 'ENDED' && st.room.phase !== 'LOBBY') {
      assert(
        p.role == null,
        `role leaked for living player ${p.display_name} in phase ${st.room.phase}`,
      )
    }
  }
}

/** All living seats tap ready; then poll until phase changes or timeout */
export async function allLivingReady(roomId, players, expectedPhase) {
  const host = players.find((p) => p.isHost) || players[0]
  let st = await state(roomId, host.token)
  const livingIds = new Set(livingPlayers(st).map((p) => p.id))

  for (const p of players) {
    if (!livingIds.has(p.playerId)) continue
    await ready(roomId, p.token)
    // After each ready, state must still be fetchable (regression: stage ambiguous)
    st = await state(roomId, p.token)
    assert(st.room, `get_room_state failed after ready by ${p.name}`)
  }

  st = await tick(roomId, host.token)
  if (expectedPhase) {
    assert(
      st.room.phase === expectedPhase,
      `expected phase ${expectedPhase} after all ready, got ${st.room.phase}`,
    )
  }
  return st
}

/** Living players all cast day vote for the same target */
export async function allLivingVote(roomId, players, stage, targetId) {
  const host = players.find((p) => p.isHost) || players[0]
  let st = await state(roomId, host.token)
  const livingIds = new Set(livingPlayers(st).map((p) => p.id))
  for (const p of players) {
    if (!livingIds.has(p.playerId)) continue
    await dayVote(roomId, p.token, stage, targetId)
    st = await state(roomId, p.token)
    assert(st.room, `get_room_state failed after vote by ${p.name}`)
  }
  return tick(roomId, host.token)
}

/** Quiet night: no actions, host force-resolves */
export async function resolveQuietNight(roomId, hostToken) {
  let st = await state(roomId, hostToken)
  assert(st.room.phase === 'NIGHT', `expected NIGHT, got ${st.room.phase}`)
  await advance(roomId, hostToken)
  st = await state(roomId, hostToken)
  assert(
    st.room.phase === 'DAY_ANNOUNCE' || st.room.phase === 'ENDED',
    `after quiet night expected DAY_ANNOUNCE/ENDED, got ${st.room.phase}`,
  )
  return st
}

export function log(msg) {
  console.log(`  ${msg}`)
}
