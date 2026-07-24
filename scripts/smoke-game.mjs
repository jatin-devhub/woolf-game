#!/usr/bin/env node
/**
 * Comprehensive multi-player game simulations against live Supabase (.env).
 * These are the tests that should catch phase/SQL regressions before players do.
 *
 *   npm run smoke
 *   npm run smoke -- --scenario ready_path
 */
import {
  advance,
  allLivingReady,
  allLivingVote,
  allStates,
  assert,
  assertNoRoleLeak,
  byRole,
  dayVote,
  getConfig,
  livingPlayers,
  log,
  nightAction,
  openLobby,
  playAgain,
  resolveQuietNight,
  rpc,
  start,
  state,
  tick,
} from './lib/game-client.mjs'

const scenarios = []

function scenario(name, fn) {
  scenarios.push({ name, fn })
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

scenario('lobby_create_join_privacy_start', async () => {
  const lobby = await openLobby(['Host', 'Alice', 'Bob'])
  let st = await state(lobby.roomId, lobby.players[0].token)
  assert(st.room.phase === 'LOBBY', 'lobby phase')
  assert(st.room.player_count === 3, '3 players')
  assert(st.room.code === lobby.code, 'code matches')

  // Late-ish join still works
  const extra = await rpc('join_room', {
    p_code: lobby.code,
    p_display_name: 'Cara',
  })
  lobby.players.push({
    name: extra.display_name,
    playerId: extra.player_id,
    token: extra.token,
    isHost: false,
  })

  await start(lobby.roomId, lobby.players[0].token)
  st = await state(lobby.roomId, lobby.players[0].token)
  assert(st.room.phase === 'NIGHT', 'starts at night')
  assert(st.you.role, 'host has private role')
  assertNoRoleLeak(st)

  // Reject join after start
  let rejected = false
  try {
    await rpc('join_room', { p_code: lobby.code, p_display_name: 'Late' })
  } catch (e) {
    rejected = /GAME_ALREADY_STARTED|already started/i.test(e.message)
  }
  assert(rejected, 'late join must fail')
  log(`roles assigned, late join blocked, privacy ok`)
})

/**
 * THE regression for "column reference stage is ambiguous":
 * last player ready advances phase into voting, then get_room_state must work.
 */
scenario('ready_path_announce_to_straw', async () => {
  const lobby = await openLobby(['R1', 'R2', 'R3'])
  await start(lobby.roomId, lobby.players[0].token)
  await resolveQuietNight(lobby.roomId, lobby.players[0].token)

  let st = await state(lobby.roomId, lobby.players[0].token)
  assert(st.room.phase === 'DAY_ANNOUNCE', 'morning after quiet night')

  // Ready one-by-one; every intermediate get_room_state must succeed
  st = await allLivingReady(lobby.roomId, lobby.players, 'DAY_STRAW_VOTE')
  assert(st.room.phase === 'DAY_STRAW_VOTE', 'straw after ready')
  // Poll again as each player (would fail on ambiguous stage)
  for (const p of lobby.players) {
    const s = await state(lobby.roomId, p.token)
    assert(s.room.phase === 'DAY_STRAW_VOTE', `${p.name} sees straw`)
    assertNoRoleLeak(s)
  }
  log('ready → straw OK (stage ambiguity regression)')
})

scenario('ready_path_defense_to_exile', async () => {
  const lobby = await openLobby(['D1', 'D2', 'D3'])
  await start(lobby.roomId, lobby.players[0].token)
  await resolveQuietNight(lobby.roomId, lobby.players[0].token)
  await allLivingReady(lobby.roomId, lobby.players, 'DAY_STRAW_VOTE')

  let st = await state(lobby.roomId, lobby.players[0].token)
  const target = livingPlayers(st)[0].id
  st = await allLivingVote(lobby.roomId, lobby.players, 'straw', target)
  assert(st.room.phase === 'DAY_DEFENSE', `defense expected, got ${st.room.phase}`)
  assert(Array.isArray(st.room.straw_results), 'straw results published')
  assert(
    st.room.straw_results.some((r) => r.count > 0 && Array.isArray(r.voters)),
    'straw shows voters',
  )

  st = await allLivingReady(lobby.roomId, lobby.players, 'DAY_EXILE_VOTE')
  for (const p of lobby.players) {
    const s = await state(lobby.roomId, p.token)
    assert(s.room.phase === 'DAY_EXILE_VOTE', `${p.name} sees exile after defense ready`)
  }
  log('straw → defense ready → exile OK')
})

scenario('full_day_exile_and_next_night', async () => {
  // 4 players so one exile does not always end the game
  const lobby = await openLobby(['F1', 'F2', 'F3', 'F4'])
  await start(lobby.roomId, lobby.players[0].token)
  await resolveQuietNight(lobby.roomId, lobby.players[0].token)
  await allLivingReady(lobby.roomId, lobby.players, 'DAY_STRAW_VOTE')

  let st = await state(lobby.roomId, lobby.players[0].token)
  const exileTarget = livingPlayers(st).find((p) => p.id !== st.you.player_id).id
  await allLivingVote(lobby.roomId, lobby.players, 'straw', exileTarget)
  await allLivingReady(lobby.roomId, lobby.players, 'DAY_EXILE_VOTE')
  st = await allLivingVote(lobby.roomId, lobby.players, 'exile', exileTarget)

  assert(
    ['DAY_EXECUTE', 'DAY_EXILE_REVOTE', 'ENDED'].includes(st.room.phase),
    `post-exile phase ${st.room.phase}`,
  )

  if (st.room.phase === 'DAY_EXECUTE') {
    // Ready → next night (or ENDED if win)
    try {
      st = await allLivingReady(lobby.roomId, lobby.players, null)
    } catch {
      // may already have auto-advanced in some paths
      st = await state(lobby.roomId, lobby.players[0].token)
    }
    if (st.room.phase === 'DAY_EXECUTE') {
      await advance(lobby.roomId, lobby.players[0].token)
      st = await state(lobby.roomId, lobby.players[0].token)
    }
    assert(
      ['NIGHT', 'ENDED'].includes(st.room.phase),
      `after execute expected NIGHT/ENDED, got ${st.room.phase}`,
    )
  }
  log(`full day cycle → ${st.room.phase}`)
})

scenario('night_kill_resolves_when_all_actors_submit', async () => {
  const lobby = await openLobby(['N1', 'N2', 'N3'])
  await start(lobby.roomId, lobby.players[0].token)
  const snaps = await allStates(lobby.roomId, lobby.players)
  const roles = byRole(snaps)
  assert(roles.werewolf?.length === 1, '1 wolf')
  assert(roles.police?.length === 1, '1 police')
  assert(roles.villager?.length === 1, '1 villager')

  const wolf = roles.werewolf[0]
  const police = roles.police[0]
  const vill = roles.villager[0]

  await nightAction(lobby.roomId, wolf.token, 'kill_vote', vill.playerId)
  // Mid-night poll must work for all
  for (const p of lobby.players) {
    const s = await state(lobby.roomId, p.token)
    assert(s.room.phase === 'NIGHT', 'still night until all act')
  }

  await nightAction(lobby.roomId, police.token, 'peek', wolf.playerId)
  let st = await tick(lobby.roomId, lobby.players[0].token)
  assert(
    ['DAY_ANNOUNCE', 'ENDED'].includes(st.room.phase),
    `after night actions got ${st.room.phase}`,
  )

  const policeView = await state(lobby.roomId, police.token)
  assert(policeView.you.last_peek, 'police has peek result')
  assert(
    policeView.you.last_peek.result === 'Wolf',
    `peek should be Wolf, got ${policeView.you.last_peek?.result}`,
  )

  // Villager must not see peek
  const villView = await state(lobby.roomId, vill.token)
  assert(!villView.you.last_peek, 'villager has no peek')
  log(`night kill path → ${st.room.phase}, police peek private`)
})

scenario('doctor_save_quiet_night', async () => {
  const lobby = await openLobby(['DocH', 'DocA', 'DocB', 'DocC'])
  await start(lobby.roomId, lobby.players[0].token)
  const snaps = await allStates(lobby.roomId, lobby.players)
  const roles = byRole(snaps)
  assert(roles.doctor?.length === 1, 'doctor present at 4p')
  assert(roles.werewolf?.length === 1, '1 wolf at 4p')

  const wolf = roles.werewolf[0]
  const doctor = roles.doctor[0]
  const police = roles.police[0]
  // Pick a non-wolf living target
  const wolfView = wolf.state
  const victim = livingPlayers(wolfView).find(
    (p) => p.id !== wolf.playerId && !(wolfView.you.wolf_allies || []).some((a) => a.id === p.id),
  )
  assert(victim, 'victim candidate')

  await nightAction(lobby.roomId, wolf.token, 'kill_vote', victim.id)
  await nightAction(lobby.roomId, doctor.token, 'protect', victim.id)
  if (police) {
    const peekTarget = livingPlayers(police.state).find((p) => p.id !== police.playerId)
    await nightAction(lobby.roomId, police.token, 'peek', peekTarget.id)
  }

  const st = await tick(lobby.roomId, lobby.players[0].token)
  assert(st.room.phase === 'DAY_ANNOUNCE', `expected morning, got ${st.room.phase}`)
  assert(
    (st.room.last_deaths || []).length === 0,
    `doctor save should mean 0 deaths, got ${JSON.stringify(st.room.last_deaths)}`,
  )
  log('doctor save → quiet morning')
})

scenario('reconnect_same_token', async () => {
  const lobby = await openLobby(['RecH', 'RecA', 'RecB'])
  await start(lobby.roomId, lobby.players[0].token)
  const before = await state(lobby.roomId, lobby.players[1].token)
  // Simulate tab refresh: only token, no other client state
  const after = await state(lobby.roomId, lobby.players[1].token)
  assert(after.you.player_id === before.you.player_id, 'same seat')
  assert(after.you.role === before.you.role, 'same role')
  assert(after.room.id === lobby.roomId, 'same room')
  log('reconnect via token OK')
})

scenario('host_advance_covers_phases', async () => {
  const lobby = await openLobby(['AdvH', 'AdvA', 'AdvB'])
  await start(lobby.roomId, lobby.players[0].token)
  await advance(lobby.roomId, lobby.players[0].token) // night → announce
  let st = await state(lobby.roomId, lobby.players[0].token)
  assert(st.room.phase === 'DAY_ANNOUNCE', 'announce')
  await advance(lobby.roomId, lobby.players[0].token)
  st = await state(lobby.roomId, lobby.players[0].token)
  assert(st.room.phase === 'DAY_STRAW_VOTE', 'straw')
  // non-host cannot advance
  let blocked = false
  try {
    await advance(lobby.roomId, lobby.players[1].token)
  } catch (e) {
    blocked = /HOST_ONLY|host/i.test(e.message)
  }
  assert(blocked, 'non-host advance blocked')
  log('host advance + host-only OK')
})

scenario('play_again_resets_to_lobby', async () => {
  const lobby = await openLobby(['PA1', 'PA2', 'PA3'])
  await start(lobby.roomId, lobby.players[0].token)
  // Force a quick end: night kill villager
  const snaps = await allStates(lobby.roomId, lobby.players)
  const roles = byRole(snaps)
  if (roles.werewolf && roles.villager) {
    await nightAction(
      lobby.roomId,
      roles.werewolf[0].token,
      'kill_vote',
      roles.villager[0].playerId,
    )
    if (roles.police?.[0]) {
      await nightAction(
        lobby.roomId,
        roles.police[0].token,
        'peek',
        roles.werewolf[0].playerId,
      )
    }
  } else {
    await advance(lobby.roomId, lobby.players[0].token)
  }
  let st = await tick(lobby.roomId, lobby.players[0].token)
  // Drive to ENDED if needed
  let guard = 0
  while (st.room.phase !== 'ENDED' && guard++ < 20) {
    if (st.room.phase === 'NIGHT') {
      await advance(lobby.roomId, lobby.players[0].token)
    } else if (['DAY_ANNOUNCE', 'DAY_DEFENSE', 'DAY_EXECUTE'].includes(st.room.phase)) {
      await advance(lobby.roomId, lobby.players[0].token)
    } else if (st.room.phase === 'DAY_STRAW_VOTE') {
      const t = livingPlayers(st)[0]?.id
      if (t) await allLivingVote(lobby.roomId, lobby.players, 'straw', t)
      else await advance(lobby.roomId, lobby.players[0].token)
    } else if (st.room.phase === 'DAY_EXILE_VOTE' || st.room.phase === 'DAY_EXILE_REVOTE') {
      const t = livingPlayers(st)[0]?.id
      if (t) {
        await allLivingVote(
          lobby.roomId,
          lobby.players,
          st.room.phase === 'DAY_EXILE_REVOTE' ? 'exile_revote' : 'exile',
          t,
        )
      } else await advance(lobby.roomId, lobby.players[0].token)
    } else {
      await advance(lobby.roomId, lobby.players[0].token)
    }
    st = await tick(lobby.roomId, lobby.players[0].token)
  }
  assert(st.room.phase === 'ENDED', `expected ENDED, got ${st.room.phase}`)
  await playAgain(lobby.roomId, lobby.players[0].token)
  st = await state(lobby.roomId, lobby.players[0].token)
  assert(st.room.phase === 'LOBBY', 'lobby after play again')
  assert(st.you.role == null, 'roles cleared')
  assert(st.room.player_count === 3, 'players kept')
  log('play again → lobby with same seats')
})

scenario('invalid_actions_rejected', async () => {
  const lobby = await openLobby(['BadH', 'BadA', 'BadB'])
  await start(lobby.roomId, lobby.players[0].token)
  const snaps = await allStates(lobby.roomId, lobby.players)
  const roles = byRole(snaps)
  const wolf = roles.werewolf[0]
  const vill = roles.villager[0]

  // Villager cannot kill
  let bad = false
  try {
    await nightAction(lobby.roomId, vill.token, 'kill_vote', wolf.playerId)
  } catch {
    bad = true
  }
  assert(bad, 'villager kill rejected')

  // Wolf cannot target self (ally rule / invalid)
  bad = false
  try {
    await nightAction(lobby.roomId, wolf.token, 'kill_vote', wolf.playerId)
  } catch {
    bad = true
  }
  assert(bad, 'wolf self-target rejected')
  log('invalid actions rejected')
})

/**
 * Simulate "continue after SQL hotpatch": existing tokens still work.
 * (Does not apply SQL — only proves session continuity API.)
 */
scenario('session_survives_repeated_state_fetches', async () => {
  const lobby = await openLobby(['ContH', 'ContA', 'ContB'])
  await start(lobby.roomId, lobby.players[0].token)
  await resolveQuietNight(lobby.roomId, lobby.players[0].token)
  // 10 rapid polls per player as if mid-ready UI thrash
  for (let i = 0; i < 10; i++) {
    for (const p of lobby.players) {
      const s = await state(lobby.roomId, p.token)
      assert(s.room.phase === 'DAY_ANNOUNCE', 'still announce')
    }
  }
  await allLivingReady(lobby.roomId, lobby.players, 'DAY_STRAW_VOTE')
  log('session continuity under poll thrash OK')
})

scenario('host_restart_mid_game_to_lobby', async () => {
  const lobby = await openLobby(['RstH', 'RstA', 'RstB'])
  await start(lobby.roomId, lobby.players[0].token)
  let st = await state(lobby.roomId, lobby.players[0].token)
  assert(st.room.phase === 'NIGHT', 'mid-game night')
  // Non-host cannot restart
  let blocked = false
  try {
    await playAgain(lobby.roomId, lobby.players[1].token)
  } catch (e) {
    blocked = /HOST_ONLY|host/i.test(e.message)
  }
  assert(blocked, 'non-host restart blocked')
  await playAgain(lobby.roomId, lobby.players[0].token)
  st = await state(lobby.roomId, lobby.players[0].token)
  assert(st.room.phase === 'LOBBY', 'restart → lobby')
  assert(st.you.role == null, 'roles cleared mid-game')
  assert(st.room.player_count === 3, 'seats kept')
  log('host mid-game restart → lobby OK')
})

scenario('host_status_shows_night_progress', async () => {
  const lobby = await openLobby(['HsH', 'HsA', 'HsB', 'HsC'])
  await start(lobby.roomId, lobby.players[0].token)
  const hostSt = await state(lobby.roomId, lobby.players[0].token)
  assert(hostSt.you.is_host, 'first player host')
  assert(hostSt.you.host_status?.night, 'host sees night board')
  assert(
    hostSt.you.host_status.night.wolves_living >= 1,
    'host sees living wolves count',
  )
  // Non-host must not receive host_status
  const other = await state(lobby.roomId, lobby.players[1].token)
  assert(!other.you.host_status, 'non-host has no host_status')
  log('host night status private OK')
})

scenario('doctor_police_skip_unblocks_night', async () => {
  const lobby = await openLobby(['SkH', 'SkA', 'SkB', 'SkC'])
  await start(lobby.roomId, lobby.players[0].token)
  const snaps = await allStates(lobby.roomId, lobby.players)
  const roles = byRole(snaps)
  assert(roles.doctor?.length === 1, 'doctor at 4p')
  assert(roles.police?.length === 1, 'police at 4p')
  const wolf = roles.werewolf[0]
  const doctor = roles.doctor[0]
  const police = roles.police[0]
  const victim = livingPlayers(wolf.state).find(
    (p) => p.id !== wolf.playerId && !(wolf.state.you.wolf_allies || []).some((a) => a.id === p.id),
  )
  assert(victim, 'victim')
  await nightAction(lobby.roomId, wolf.token, 'kill_vote', victim.id)
  // Skip specials (null target) — must not soft-lock night
  await nightAction(lobby.roomId, doctor.token, 'protect', null)
  await nightAction(lobby.roomId, police.token, 'peek', null)
  const st = await tick(lobby.roomId, lobby.players[0].token)
  assert(
    ['DAY_ANNOUNCE', 'ENDED'].includes(st.room.phase),
    `skip path advanced, got ${st.room.phase}`,
  )
  log(`doctor/police skip → ${st.room.phase}`)
})

/**
 * Reproduce the embarrassing 8p office game:
 * 2 wolves vote first → night must STILL be NIGHT until doctor + police act.
 * Then all specials act → morning.
 */
scenario('eight_player_wolves_only_stuck_then_full_night', async () => {
  const names = ['H1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8']
  const lobby = await openLobby(names)
  await start(lobby.roomId, lobby.players[0].token)
  let snaps = await allStates(lobby.roomId, lobby.players)
  const roles = byRole(snaps)
  assert(roles.werewolf?.length === 2, `expected 2 wolves, got ${roles.werewolf?.length}`)
  assert(roles.doctor?.length === 1, '1 doctor at 8p')
  assert(roles.police?.length === 1, '1 police at 8p')
  assert(roles.villager?.length === 4, '4 villagers at 8p')

  const wolves = roles.werewolf
  const doctor = roles.doctor[0]
  const police = roles.police[0]

  // Host (or any seat) must see host_status if host
  const hostSt = await state(lobby.roomId, lobby.players[0].token)
  assert(hostSt.you.is_host, 'first seat is host')
  assert(hostSt.you.host_status?.night, 'host night board present')
  assert(hostSt.you.host_status.night.wolves_living === 2, 'host sees 2 wolves')
  assert(
    (hostSt.you.host_status.night.blocking || []).includes('wolves'),
    'blocking includes wolves before votes',
  )

  // Pick a non-wolf victim both wolves can target
  const victim = livingPlayers(wolves[0].state).find(
    (p) =>
      p.id !== wolves[0].playerId &&
      !(wolves[0].state.you.wolf_allies || []).some((a) => a.id === p.id),
  )
  assert(victim, 'victim for kill')

  // Both wolves vote — THIS is the stuck office scenario if specials AFK
  await nightAction(lobby.roomId, wolves[0].token, 'kill_vote', victim.id)
  await nightAction(lobby.roomId, wolves[1].token, 'kill_vote', victim.id)

  let mid = await tick(lobby.roomId, lobby.players[0].token)
  assert(mid.room.phase === 'NIGHT', 'STUCK/WAIT: still night after both wolves only')
  assert(mid.you.host_status?.night?.wolves_voted === 2, 'host sees 2/2 wolf votes')
  const blocking = mid.you.host_status?.night?.blocking || []
  assert(blocking.includes('doctor') || blocking.includes('police'), `still blocking specials: ${blocking}`)

  // Doctor + police can still act (backend accepts)
  const protectTarget = livingPlayers(doctor.state)[0]
  const peekTarget = livingPlayers(police.state).find((p) => p.id !== police.playerId)
  assert(protectTarget && peekTarget, 'special targets')
  await nightAction(lobby.roomId, doctor.token, 'protect', protectTarget.id)
  await nightAction(lobby.roomId, police.token, 'peek', peekTarget.id)

  mid = await tick(lobby.roomId, lobby.players[0].token)
  assert(
    ['DAY_ANNOUNCE', 'ENDED'].includes(mid.room.phase),
    `after all night roles expected morning/end, got ${mid.room.phase}`,
  )

  // Police got a private peek
  const policeView = await state(lobby.roomId, police.token)
  assert(policeView.you.last_peek, 'police has peek result')
  // host_status only for host seat (police may be host if roles shuffled that way)
  if (!policeView.you.is_host) {
    assert(!policeView.you.host_status, 'non-host no host board')
  } else {
    assert(policeView.you.host_status, 'host police still has host board')
  }

  // Villagers never leak roles mid-game
  for (const v of roles.villager || []) {
    const st = await state(lobby.roomId, v.token)
    assertNoRoleLeak(st)
  }

  log(`8p night: wolves-only stuck verified, then full resolve → ${mid.room.phase}`)
})

/** Doctor/police must be able to change target before lock (upsert). */
scenario('eight_player_specials_can_resubmit_before_resolve', async () => {
  const lobby = await openLobby(['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8'])
  await start(lobby.roomId, lobby.players[0].token)
  const snaps = await allStates(lobby.roomId, lobby.players)
  const roles = byRole(snaps)
  const doctor = roles.doctor[0]
  const police = roles.police[0]
  const wolves = roles.werewolf
  const living = livingPlayers(doctor.state)
  assert(living.length >= 2, 'enough living')

  await nightAction(lobby.roomId, doctor.token, 'protect', living[0].id)
  await nightAction(lobby.roomId, doctor.token, 'protect', living[1].id)
  let st = await state(lobby.roomId, doctor.token)
  assert(
    st.you.my_night_actions?.protect === living[1].id,
    'doctor resubmit updates target',
  )

  const peekA = living.find((p) => p.id !== police.playerId)
  const peekB = living.find((p) => p.id !== police.playerId && p.id !== peekA.id)
  await nightAction(lobby.roomId, police.token, 'peek', peekA.id)
  if (peekB) {
    await nightAction(lobby.roomId, police.token, 'peek', peekB.id)
    st = await state(lobby.roomId, police.token)
    assert(st.you.my_night_actions?.peek === peekB.id, 'police resubmit updates')
  }

  // Finish night so room does not linger
  const victim = livingPlayers(wolves[0].state).find(
    (p) =>
      p.id !== wolves[0].playerId &&
      !(wolves[0].state.you.wolf_allies || []).some((a) => a.id === p.id),
  )
  for (const w of wolves) {
    await nightAction(lobby.roomId, w.token, 'kill_vote', victim.id)
  }
  st = await tick(lobby.roomId, lobby.players[0].token)
  assert(['DAY_ANNOUNCE', 'ENDED'].includes(st.room.phase), `resolved got ${st.room.phase}`)
  log('8p specials resubmit OK')
})

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main() {
  const cfg = getConfig()
  const only = process.argv.includes('--scenario')
    ? process.argv[process.argv.indexOf('--scenario') + 1]
    : null

  console.log('Integration smoke against', cfg.url)
  if (only) console.log('Filter scenario:', only)

  let passed = 0
  let failed = 0
  const failures = []

  for (const s of scenarios) {
    if (only && s.name !== only) continue
    process.stdout.write(`\n▶ ${s.name}\n`)
    try {
      await s.fn()
      console.log(`  ✓ PASS`)
      passed++
    } catch (e) {
      console.error(`  ✗ FAIL: ${e.message}`)
      failed++
      failures.push({ name: s.name, error: e.message })
    }
  }

  console.log(`\n==========`)
  console.log(`Passed: ${passed}  Failed: ${failed}  Total: ${passed + failed}`)
  if (failures.length) {
    console.log('Failures:')
    for (const f of failures) console.log(`  - ${f.name}: ${f.error}`)
    process.exit(1)
  }
  console.log('SMOKE OK')
}

main().catch((e) => {
  console.error('SMOKE FAIL:', e.message)
  process.exit(1)
})
