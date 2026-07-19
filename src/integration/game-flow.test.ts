/**
 * Vitest wrapper around the multi-player RPC harness.
 * Skips cleanly if .env is missing (unit CI without backend).
 *
 * Run: npm run test:integration
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function loadEnv() {
  const path = resolve(process.cwd(), '.env')
  if (!existsSync(path)) return false
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (!m) continue
    const val = m[2].replace(/^["']|["']$/g, '')
    if (!process.env[m[1]]) process.env[m[1]] = val
  }
  return Boolean(process.env.VITE_SUPABASE_URL && process.env.VITE_SUPABASE_ANON_KEY)
}

const hasBackend = loadEnv()

async function rpc(name: string, body: Record<string, unknown>) {
  const url = process.env.VITE_SUPABASE_URL!
  const key = process.env.VITE_SUPABASE_ANON_KEY!
  const res = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data?.message || res.statusText)
  return data
}

describe.skipIf(!hasBackend)('live game flow (backend)', () => {
  it(
    'last ready advances to straw and get_room_state works (stage ambiguity regression)',
    async () => {
      const host = await rpc('create_room', {
        p_display_name: 'VitHost',
        p_use_timers: false,
      })
      const a = await rpc('join_room', {
        p_code: host.code,
        p_display_name: 'VitA',
      })
      const b = await rpc('join_room', {
        p_code: host.code,
        p_display_name: 'VitB',
      })
      await rpc('start_game', { p_room_id: host.room_id, p_token: host.token })
      // Quiet night via host advance (no kills)
      await rpc('host_advance', { p_room_id: host.room_id, p_token: host.token })

      let st = await rpc('get_room_state', {
        p_room_id: host.room_id,
        p_token: host.token,
      })
      expect(st.room.phase).toBe('DAY_ANNOUNCE')

      for (const tok of [host.token, a.token, b.token]) {
        await rpc('player_ready', { p_room_id: host.room_id, p_token: tok })
        // Must not throw "column reference stage is ambiguous"
        st = await rpc('get_room_state', {
          p_room_id: host.room_id,
          p_token: tok,
        })
        expect(st.room).toBeTruthy()
      }

      st = await rpc('tick_room', { p_room_id: host.room_id, p_token: host.token })
      expect(st.room.phase).toBe('DAY_STRAW_VOTE')

      // Every client can load voting phase
      for (const tok of [host.token, a.token, b.token]) {
        const s = await rpc('get_room_state', {
          p_room_id: host.room_id,
          p_token: tok,
        })
        expect(s.room.phase).toBe('DAY_STRAW_VOTE')
        // no living role leak
        for (const p of s.players) {
          if (p.is_alive) expect(p.role).toBeNull()
        }
      }
    },
    60_000,
  )

  it(
    'straw → defense ready → exile without SQL errors',
    async () => {
      const host = await rpc('create_room', {
        p_display_name: 'Vit2H',
        p_use_timers: false,
      })
      const a = await rpc('join_room', { p_code: host.code, p_display_name: 'Vit2A' })
      const b = await rpc('join_room', { p_code: host.code, p_display_name: 'Vit2B' })
      const tokens = [host.token, a.token, b.token] as string[]
      await rpc('start_game', { p_room_id: host.room_id, p_token: host.token })
      await rpc('host_advance', { p_room_id: host.room_id, p_token: host.token })

      for (const tok of tokens) {
        await rpc('player_ready', { p_room_id: host.room_id, p_token: tok })
      }
      let st = await rpc('get_room_state', {
        p_room_id: host.room_id,
        p_token: host.token,
      })
      expect(st.room.phase).toBe('DAY_STRAW_VOTE')

      const target = st.players.find((p: { is_alive: boolean }) => p.is_alive).id
      for (const tok of tokens) {
        await rpc('submit_day_vote', {
          p_room_id: host.room_id,
          p_token: tok,
          p_stage: 'straw',
          p_target_id: target,
        })
        st = await rpc('get_room_state', {
          p_room_id: host.room_id,
          p_token: tok,
        })
      }
      expect(st.room.phase).toBe('DAY_DEFENSE')
      expect(Array.isArray(st.room.straw_results)).toBe(true)

      for (const tok of tokens) {
        await rpc('player_ready', { p_room_id: host.room_id, p_token: tok })
        st = await rpc('get_room_state', {
          p_room_id: host.room_id,
          p_token: tok,
        })
      }
      expect(st.room.phase).toBe('DAY_EXILE_VOTE')
    },
    60_000,
  )
})
