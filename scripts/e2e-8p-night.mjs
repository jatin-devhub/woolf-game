#!/usr/bin/env node
/**
 * Frontend + backend E2E: 8 players through night.
 *
 * Spins 8 isolated browser contexts against a running Vite app + live Supabase
 * (same VITE_* as the app). Reproduces the office stuck-night case:
 *   both wolves vote → still Night until doctor + police act → Morning.
 *
 *   # terminal A: local supabase + schema applied, then:
 *   VITE_SUPABASE_URL=http://127.0.0.1:54321 VITE_SUPABASE_ANON_KEY=... npm run dev -- --host 127.0.0.1 --port 5173
 *   # terminal B:
 *   npm run e2e:8p
 */
import { chromium } from 'playwright'
import {
  assert,
  getConfig,
  log,
  rpc,
  state,
} from './lib/game-client.mjs'

const BASE = process.env.E2E_BASE_URL || 'http://127.0.0.1:5173'
const NAMES = ['HostJatin', 'Alice', 'Bob', 'Cara', 'Dee', 'Eve', 'Frank', 'Gina']

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitFor(fn, { timeout = 20000, interval = 250, label = 'condition' } = {}) {
  const start = Date.now()
  let lastErr
  while (Date.now() - start < timeout) {
    try {
      const v = await fn()
      if (v) return v
    } catch (e) {
      lastErr = e
    }
    await sleep(interval)
  }
  throw new Error(`timeout waiting for ${label}${lastErr ? `: ${lastErr.message}` : ''}`)
}

async function dismissRoleIfPresent(page) {
  // Role card → action: "Got it" or "Continue — take your action"
  for (let i = 0; i < 3; i++) {
    const cont = page.getByRole('button', { name: /Continue — take your action|Got it/i })
    if (await cont.isVisible().catch(() => false)) {
      await cont.click()
      await sleep(300)
    } else {
      break
    }
  }
}

async function phaseText(page) {
  // Prefer action chrome over last_announcement text ("Night falls…" can linger into morning)
  const body = await page.locator('body').innerText()
  if (/I'm ready|Casualties/i.test(body) && !/Confirm kill vote|Protect|Investigate/i.test(body)) {
    if (/Straw vote/i.test(body)) return 'DAY_STRAW_VOTE'
    if (/Defense/i.test(body)) return 'DAY_DEFENSE'
    if (/Exile/i.test(body)) return 'DAY_EXILE'
    return 'DAY_ANNOUNCE'
  }
  if (/Confirm kill vote|Pack votes|Skip protect|Skip investigate|Sleep tight/i.test(body)) {
    return 'NIGHT'
  }
  if (/Morning/i.test(body)) return 'DAY_ANNOUNCE'
  if (/Straw vote/i.test(body)) return 'DAY_STRAW_VOTE'
  if (/Defense/i.test(body)) return 'DAY_DEFENSE'
  if (/Exile vote|Exile revote/i.test(body)) return 'DAY_EXILE'
  if (/Game over|Play again/i.test(body)) return 'ENDED'
  if (/Start game|Need \d+ more/i.test(body)) return 'LOBBY'
  return 'UNKNOWN'
}

async function clickPlayerNamed(page, name) {
  // Prefer eligible chips labeled "Tap to select"
  const preferred = page
    .locator('button:enabled')
    .filter({ hasText: new RegExp(name) })
    .filter({ hasText: /Tap to select|Selected/i })
  if ((await preferred.count()) > 0) {
    await preferred.first().click()
    return
  }
  const btn = page.locator('button:enabled').filter({ hasText: new RegExp(`\\b${name}\\b`) })
  await waitFor(async () => (await btn.count()) > 0, {
    label: `clickable player ${name}`,
    timeout: 10000,
  })
  await btn.first().click()
}

async function nightActionDone(page) {
  const t = await page.locator('body').innerText()
  // Last actor may jump straight to Morning (no "waiting for others")
  return (
    /Submitted|Skipped|You.?re done|waiting for other/i.test(t) ||
    /Morning|I'm ready|Game over|Casualties|quiet/i.test(t)
  )
}

async function submitNight(page, label) {
  const btn = page.getByRole('button', { name: label })
  await waitFor(async () => (await btn.isEnabled().catch(() => false)), {
    label: `enabled ${typeof label === 'string' ? label : label.toString()}`,
    timeout: 10000,
  })
  await btn.click()
  await waitFor(async () => nightActionDone(page), {
    label: 'submitted feedback or morning',
    timeout: 10000,
  })
}

async function main() {
  // Prove backend is reachable with same env the app will use
  const cfg = getConfig()
  log(`backend ${cfg.url}`)
  log(`frontend ${BASE}`)

  // Health-check frontend
  const health = await fetch(BASE).catch((e) => {
    throw new Error(`Frontend not reachable at ${BASE}. Start: npm run dev — ${e.message}`)
  })
  if (!health.ok) throw new Error(`Frontend HTTP ${health.status}`)

  const browser = await chromium.launch({
    headless: process.env.E2E_HEADED !== '1',
  })

  /** @type {{ name: string, context: import('playwright').BrowserContext, page: import('playwright').Page }[]} */
  const seats = []
  try {
    for (const name of NAMES) {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        // each seat = fresh storage (join tokens)
      })
      const page = await context.newPage()
      page.on('pageerror', (err) => console.error(`[${name} pageerror]`, err.message))
      await page.goto(BASE, { waitUntil: 'networkidle' })
      seats.push({ name, context, page })
    }

    // ---- Host creates room ----
    const host = seats[0]
    await host.page.getByRole('button', { name: 'Create room' }).click()
    await host.page.getByPlaceholder('e.g. Jatin').fill(host.name)
    await host.page.getByRole('button', { name: 'Create' }).click()
    await waitFor(
      async () => {
        const t = await host.page.locator('body').innerText()
        return /Leave room|Need \d+ more to start|Start game/i.test(t)
      },
      { label: 'host lobby' },
    )

    // Room code is large mono text under "Room"
    const code = await waitFor(
      async () => {
        const el = host.page.locator('.font-mono').first()
        const t = (await el.textContent())?.trim()
        return t && t.length >= 4 ? t : null
      },
      { label: 'room code' },
    )
    log(`room code ${code}`)

    // ---- 7 joiners ----
    for (const seat of seats.slice(1)) {
      await seat.page.getByRole('button', { name: 'Join with code' }).click()
      await seat.page.getByPlaceholder('e.g. Jatin').fill(seat.name)
      await seat.page.getByPlaceholder('ABC123').fill(code)
      await seat.page.getByRole('button', { name: 'Join' }).click()
      await waitFor(
        async () => {
          const t = await seat.page.locator('body').innerText()
          return /Waiting for host|Leave room|Players \(/i.test(t)
        },
        { label: `${seat.name} in lobby` },
      )
    }

    // Host sees 8 players (case-insensitive; UI may uppercase labels)
    await waitFor(
      async () => /Players?\s*\(8\/12\)/i.test(await host.page.locator('body').innerText()),
      { label: '8 players listed' },
    )

    // ---- Start ----
    const startBtn = host.page.getByRole('button', { name: 'Start game' })
    await waitFor(async () => startBtn.isEnabled(), { label: 'start enabled' })
    await startBtn.click()

    // Everyone gets a role card or night UI
    for (const seat of seats) {
      await waitFor(
        async () => {
          const t = await seat.page.locator('body').innerText()
          return /Your role|Night|Werewolf|Doctor|Police|Villager/i.test(t)
        },
        { label: `${seat.name} entered game` },
      )
      await dismissRoleIfPresent(seat.page)
    }

    // Discover roles via backend token from localStorage (same session as UI)
    const roleByName = {}
    const tokenByName = {}
    for (const seat of seats) {
      const session = await seat.page.evaluate(() => {
        const raw = localStorage.getItem('wolf-game-session-v1')
        return raw ? JSON.parse(raw) : null
      })
      assert(session?.token && session?.roomId, `${seat.name} has session token in localStorage`)
      tokenByName[seat.name] = session
      const st = await state(session.roomId, session.token)
      roleByName[seat.name] = st.you.role
      assert(st.room.phase === 'NIGHT', `${seat.name} sees NIGHT`)
      assert(st.room.player_count === 8, '8 players server-side')
    }
    log(`roles: ${JSON.stringify(roleByName)}`)

    const wolves = seats.filter((s) => roleByName[s.name] === 'werewolf')
    const doctors = seats.filter((s) => roleByName[s.name] === 'doctor')
    const police = seats.filter((s) => roleByName[s.name] === 'police')
    const villagers = seats.filter((s) => roleByName[s.name] === 'villager')
    assert(wolves.length === 2, `2 wolves, got ${wolves.length}`)
    assert(doctors.length === 1, '1 doctor')
    assert(police.length === 1, '1 police')
    assert(villagers.length === 4, '4 villagers')

    // Host may be in full-screen action mode (if they are wolf/doctor/police) — open host tools if needed
    await dismissRoleIfPresent(host.page)
    async function ensureHostBoardVisible() {
      await dismissRoleIfPresent(host.page)
      let body = await host.page.locator('body').innerText()
      if (/Host board/i.test(body)) return body
      const toggle = host.page.getByRole('button', { name: /Host tools/i })
      if (await toggle.isVisible().catch(() => false)) {
        await toggle.click()
        await sleep(300)
      }
      body = await host.page.locator('body').innerText()
      return body
    }
    {
      const hostBody = await ensureHostBoardVisible()
      // Villager host sees board on main screen; night-role host under Host tools
      assert(
        /Host board|Wolves:|Action required|Lock /i.test(hostBody),
        'host has night UI or host board',
      )
    }

    // ---- UI: both wolves pick a villager and confirm ----
    // Prefer a villager who is not host-only edge cases; any non-wolf works
    const killTarget =
      villagers.find((v) => v.name !== host.name)?.name || villagers[0].name
    for (const w of wolves) {
      await dismissRoleIfPresent(w.page)
      await waitFor(
        async () =>
          /Lock kill vote|Pack votes|Choose who the pack kills|Action required/i.test(
            await w.page.locator('body').innerText(),
          ),
        { label: `${w.name} wolf night UI`, timeout: 15000 },
      )
      // Prefer target from enabled chips if preferred name not clickable
      try {
        await clickPlayerNamed(w.page, killTarget)
      } catch (e) {
        log(`${w.name} named click failed (${e.message}), trying Tap to select`)
        // Action UI subtitles: "Tap to select" / "Selected"
        const chips = w.page.locator('button:enabled').filter({ hasText: /Tap to select|Selected/i })
        const count = await chips.count()
        if (count === 0) {
          const body = await w.page.locator('body').innerText()
          throw new Error(`${w.name} has no enabled target chips. UI:\n${body.slice(0, 700)}`)
        }
        await chips.first().click()
      }
      await submitNight(w.page, /Lock kill vote/)
      log(`${w.name} (wolf) submitted kill vote`)
    }

    // Backend: still NIGHT (the stuck scenario)
    const hostSess = tokenByName[host.name]
    let mid = await rpc('tick_room', {
      p_room_id: hostSess.roomId,
      p_token: hostSess.token,
    })
    assert(mid.room.phase === 'NIGHT', `after 2 wolf UI votes still NIGHT, got ${mid.room.phase}`)
    assert(mid.you.host_status?.night?.wolves_voted === 2, 'host_status wolves 2/2')
    const blocking = mid.you.host_status?.night?.blocking || []
    assert(
      blocking.includes('doctor') || blocking.includes('police'),
      `blocking specials after wolves: ${JSON.stringify(blocking)}`,
    )
    log(`STUCK reproduced in UI+API: phase=NIGHT blocking=${blocking.join(',')}`)

    // Refresh host page poll — host board should say waiting on doctor/police
    await sleep(2000)
    const hostAfterWolves = await ensureHostBoardVisible()
    // Backend already asserted 2/2; UI board if host opened tools or is waiting
    if (/Host board|Wolves:/i.test(hostAfterWolves)) {
      assert(/Wolves:\s*2\/2|2\/2/i.test(hostAfterWolves), 'host UI shows 2/2 wolves')
      assert(/MUST ACT|Nudge|doctor|police/i.test(hostAfterWolves), 'host UI shows specials waiting')
    } else {
      log('host still on own action screen (ok); board checked via API')
    }

    // Villagers should NOT have kill/protect buttons
    for (const v of villagers) {
      await dismissRoleIfPresent(v.page)
      const t = await v.page.locator('body').innerText()
      assert(!/Confirm kill vote/i.test(t), `${v.name} no kill button`)
      assert(/Sleep tight|Night roles are acting|Night/i.test(t), `${v.name} night wait copy`)
    }

    // ---- Doctor acts via UI ----
    const doc = doctors[0]
    await dismissRoleIfPresent(doc.page)
    {
      // Full-screen action UI: "Lock protect" (no skip)
      await waitFor(
        async () => {
          await dismissRoleIfPresent(doc.page)
          const t = await doc.page.locator('body').innerText()
          return /Action required|Lock protect|Choose who to protect/i.test(t)
        },
        { label: `${doc.name} doctor action screen` },
      )
      try {
        await clickPlayerNamed(doc.page, doc.name)
      } catch {
        const chips = doc.page.locator('button:enabled').filter({ hasText: /Alive|select|Selected/i })
        await chips.first().click()
      }
      await submitNight(doc.page, /Lock protect/)
      log(`${doc.name} (doctor) protected`)
    }

    // Still night until police
    mid = await rpc('tick_room', {
      p_room_id: hostSess.roomId,
      p_token: hostSess.token,
    })
    assert(mid.room.phase === 'NIGHT', 'still night after doctor only')

    // ---- Police acts via UI ----
    const cop = police[0]
    await dismissRoleIfPresent(cop.page)
    {
      await waitFor(
        async () => {
          await dismissRoleIfPresent(cop.page)
          const t = await cop.page.locator('body').innerText()
          return /Action required|Lock investigation|Choose who to investigate/i.test(t)
        },
        { label: `${cop.name} police action screen` },
      )

      const chips = cop.page.locator('button:not([disabled])').filter({ hasText: /Alive|select|Selected/i })
      await waitFor(async () => (await chips.count()) > 0, { label: 'police has targets' })
      await chips.first().click()
      await submitNight(cop.page, /Lock investigation/)
      log(`${cop.name} (police) investigated via UI`)
    }

    // ---- Morning ----
    mid = await waitFor(
      async () => {
        const st = await rpc('tick_room', {
          p_room_id: hostSess.roomId,
          p_token: hostSess.token,
        })
        return ['DAY_ANNOUNCE', 'ENDED'].includes(st.room.phase) ? st : null
      },
      { label: 'morning after all night UI actions', timeout: 15000 },
    )
    log(`resolved → ${mid.room.phase}`)

    // All seats eventually show Morning / Game over (poll ~1.5s)
    for (const seat of seats) {
      await waitFor(
        async () => {
          await dismissRoleIfPresent(seat.page)
          const body = await seat.page.locator('body').innerText()
          const ph = await phaseText(seat.page)
          if (ph === 'DAY_ANNOUNCE' || ph === 'ENDED') return true
          // Loose UI signals (phase badge "Morning", ready CTA, death card)
          if (/I'm ready|Casualties|Game over|Play again/i.test(body)) return true
          if (/\bMorning\b/i.test(body) && !/Confirm kill vote|Skip protect|Skip investigate/i.test(body)) {
            return true
          }
          return false
        },
        { label: `${seat.name} UI morning`, timeout: 25000 },
      )
      log(`${seat.name} UI reached morning/end`)
    }

    // Police private peek present server-side
    const copSess = tokenByName[cop.name]
    const copState = await state(copSess.roomId, copSess.token)
    assert(copState.you.last_peek, 'police last_peek set')
    log(`police peek: ${copState.you.last_peek.target_name} = ${copState.you.last_peek.result}`)

    // Doctor can use Skip path in a second quick room? covered by smoke; here we proved Protect works.

    console.log('\nE2E 8p night PASS')
    console.log('  - Frontend: 8 contexts create/join/start/role dismiss')
    console.log('  - Wolves UI vote → still NIGHT (stuck reproduced)')
    console.log('  - Doctor UI protect works')
    console.log('  - Police UI investigate works')
    console.log('  - Backend resolves to morning; all UIs catch up')
  } finally {
    await browser.close()
  }
}

main().catch((e) => {
  console.error('\nE2E 8p night FAIL:', e.message || e)
  process.exit(1)
})
