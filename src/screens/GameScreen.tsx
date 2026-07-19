import { useMemo, useState } from 'react'
import { Button, Card, PhaseBadge, PlayerChip, Shell } from '../components/ui'
import {
  PHASE_LABELS,
  ROLE_BLURBS,
  ROLE_LABELS,
  type Phase,
  type PublicPlayer,
  type Role,
  type RoomState,
} from '../lib/types'

function toneFor(phase: Phase): 'night' | 'day' | 'danger' {
  if (phase === 'NIGHT') return 'night'
  if (phase === 'DAY_EXECUTE' || phase === 'ENDED') return 'danger'
  return 'day'
}

function phaseHelp(phase: Phase, role: Role | null, alive: boolean): string {
  if (!alive && phase !== 'ENDED' && phase !== 'LOBBY') {
    return 'You are out. Spectate the public board.'
  }
  switch (phase) {
    case 'LOBBY':
      return 'Waiting for the host to start. Best with 5+ players (min 3).'
    case 'NIGHT':
      if (role === 'werewolf') return 'Pick a victim with your pack. You can see allies’ votes.'
      if (role === 'doctor') return 'Choose someone to protect tonight (self OK).'
      if (role === 'police') return 'Investigate one living player.'
      return 'Sleep tight. Night roles are acting…'
    case 'DAY_ANNOUNCE':
      return 'See who made it through the night.'
    case 'DAY_STRAW_VOTE':
      return 'Non-lethal straw poll. Everyone sees who voted for whom.'
    case 'DAY_DEFENSE':
      return 'Discuss the straw results. Defend yourselves, then continue.'
    case 'DAY_EXILE_VOTE':
      return 'Lethal vote. Majority sends someone out — role revealed.'
    case 'DAY_EXILE_REVOTE':
      return 'Tied! Vote only among the shortlist. Second tie eliminates all tied.'
    case 'DAY_EXECUTE':
      return 'Exile resolved. Ready up or host continues to night.'
    case 'ENDED':
      return 'Game over — full roles revealed.'
    default:
      return ''
  }
}

export function GameScreen({
  state,
  loading,
  onLeave,
  onExit,
  onSetTimers,
  onStart,
  onNight,
  onDayVote,
  onReady,
  onAdvance,
  onPlayAgain,
}: {
  state: RoomState
  loading: boolean
  onLeave: () => void
  onExit: () => void
  onSetTimers: (v: boolean) => void
  onStart: () => void
  onNight: (type: 'kill_vote' | 'protect' | 'peek', id: string) => void
  onDayVote: (stage: 'straw' | 'exile' | 'exile_revote', id: string) => void
  onReady: () => void
  onAdvance: () => void
  onPlayAgain: () => void
}) {
  const { room, players, you } = state
  const [picked, setPicked] = useState<string | null>(null)
  const [roleFlash, setRoleFlash] = useState(true)

  const living = useMemo(() => players.filter((p) => p.is_alive), [players])
  const isHost = you.is_host
  const role = you.role

  const showRoleCard =
    roleFlash && role && room.phase !== 'LOBBY' && room.phase !== 'ENDED' && you.is_alive

  const targets = useMemo(() => {
    if (room.phase === 'NIGHT' && role === 'werewolf') {
      if (room.wolf_ballot_round > 1 && room.wolf_revote_target_ids?.length) {
        return living.filter((p) => room.wolf_revote_target_ids.includes(p.id))
      }
      return living.filter((p) => p.id !== you.player_id && !isKnownAlly(p, you))
    }
    if (room.phase === 'NIGHT' && role === 'doctor') return living
    if (room.phase === 'NIGHT' && role === 'police') {
      return living.filter((p) => p.id !== you.player_id)
    }
    if (room.phase === 'DAY_EXILE_REVOTE' && room.exile_revote_target_ids?.length) {
      return living.filter((p) => room.exile_revote_target_ids.includes(p.id))
    }
    if (room.phase === 'DAY_STRAW_VOTE' || room.phase === 'DAY_EXILE_VOTE') {
      return living
    }
    return []
  }, [room, role, living, you])

  const mySubmitted = (() => {
    if (room.phase === 'NIGHT' && you.my_night_actions) {
      if (role === 'werewolf') return Boolean(you.my_night_actions.kill_vote)
      if (role === 'doctor') return Boolean(you.my_night_actions.protect)
      if (role === 'police') return Boolean(you.my_night_actions.peek)
    }
    if (
      room.phase === 'DAY_STRAW_VOTE' ||
      room.phase === 'DAY_EXILE_VOTE' ||
      room.phase === 'DAY_EXILE_REVOTE'
    ) {
      return Boolean(you.my_day_vote)
    }
    return false
  })()

  const submitAction = () => {
    if (!picked) return
    if (room.phase === 'NIGHT') {
      if (role === 'werewolf') onNight('kill_vote', picked)
      else if (role === 'doctor') onNight('protect', picked)
      else if (role === 'police') onNight('peek', picked)
    } else if (room.phase === 'DAY_STRAW_VOTE') onDayVote('straw', picked)
    else if (room.phase === 'DAY_EXILE_VOTE') onDayVote('exile', picked)
    else if (room.phase === 'DAY_EXILE_REVOTE') onDayVote('exile_revote', picked)
    setPicked(null)
  }

  if (showRoleCard && role) {
    return (
      <Shell tone="night">
        <div className="flex flex-1 flex-col items-center justify-center text-center">
          <p className="text-sm tracking-widest text-violet-300 uppercase">Your role</p>
          <h2 className="mt-2 text-4xl font-black text-white">{ROLE_LABELS[role]}</h2>
          <p className="mt-4 max-w-xs text-[var(--muted)]">{ROLE_BLURBS[role]}</p>
          {role === 'werewolf' && you.wolf_allies && you.wolf_allies.length > 0 ? (
            <p className="mt-3 text-sm text-red-200">
              Pack: {you.wolf_allies.map((a) => a.display_name).join(', ')}
            </p>
          ) : null}
          <div className="mt-8 w-full max-w-xs">
            <Button onClick={() => setRoleFlash(false)}>Got it</Button>
          </div>
        </div>
      </Shell>
    )
  }

  return (
    <Shell tone={toneFor(room.phase)}>
      <header className="mb-3 flex items-start justify-between gap-3">
        <div>
          <div className="text-xs tracking-widest text-white/40 uppercase">Room</div>
          <div className="font-mono text-2xl font-black tracking-[0.2em] text-white">{room.code}</div>
        </div>
        <div className="text-right text-xs text-[var(--muted)]">
          <div>
            {room.player_count} players · {room.living_count} alive
          </div>
          {room.use_timers && room.phase_ends_at ? (
            <div className="mt-1 text-amber-200">Timers on</div>
          ) : (
            <div className="mt-1">No timer</div>
          )}
        </div>
      </header>

      <PhaseBadge
        label={PHASE_LABELS[room.phase]}
        detail={phaseHelp(room.phase, role, you.is_alive)}
      />

      {room.last_announcement && room.phase !== 'LOBBY' ? (
        <Card className="mb-3 border-amber-500/20 bg-amber-950/20">
          <p className="text-sm text-amber-50">{room.last_announcement}</p>
        </Card>
      ) : null}

      {room.phase === 'LOBBY' ? (
        <LobbyBody
          players={players}
          youId={you.player_id}
          isHost={isHost}
          useTimers={room.use_timers}
          loading={loading}
          onSetTimers={onSetTimers}
          onStart={onStart}
          onLeave={onLeave}
        />
      ) : null}

      {room.phase === 'NIGHT' && role === 'werewolf' && you.is_alive ? (
        <Card className="mb-3">
          <p className="mb-2 text-xs font-semibold tracking-wide text-red-300 uppercase">Pack votes</p>
          {you.wolf_allies && you.wolf_allies.length === 0 ? (
            <p className="text-sm text-[var(--muted)]">You are the only wolf.</p>
          ) : (
            <p className="mb-2 text-sm text-[var(--muted)]">
              Allies: {(you.wolf_allies || []).map((a) => a.display_name).join(', ') || '—'}
            </p>
          )}
          <ul className="space-y-1 text-sm">
            {(you.wolf_votes || []).length === 0 ? (
              <li className="text-[var(--muted)]">No votes yet…</li>
            ) : (
              (you.wolf_votes || []).map((v) => (
                <li key={v.voter_id}>
                  <span className="text-white">{v.voter_name}</span>
                  <span className="text-[var(--muted)]"> → </span>
                  <span className="text-red-200">{v.target_name || '?'}</span>
                </li>
              ))
            )}
          </ul>
          {room.wolf_ballot_round > 1 ? (
            <p className="mt-2 text-sm text-amber-200">Revote: only tied targets are eligible.</p>
          ) : null}
        </Card>
      ) : null}

      {role === 'police' && you.last_peek ? (
        <Card className="mb-3 border-sky-400/20">
          <p className="text-xs font-semibold tracking-wide text-sky-300 uppercase">Last investigation</p>
          <p className="mt-1 text-sm">
            {you.last_peek.target_name}: <strong>{you.last_peek.result}</strong>
          </p>
        </Card>
      ) : null}

      {(room.phase === 'DAY_ANNOUNCE' || room.phase === 'DAY_EXECUTE') && room.last_deaths?.length ? (
        <Card className="mb-3 border-red-400/20">
          <p className="mb-2 text-xs font-semibold tracking-wide text-red-300 uppercase">Casualties</p>
          <ul className="space-y-2">
            {room.last_deaths.map((d) => (
              <li key={d.player_id} className="text-sm">
                <span className="font-semibold text-white">{d.name}</span>
                <span className="text-[var(--muted)]">
                  {' '}
                  · {ROLE_LABELS[d.role as Role] || d.role} · {d.cause}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {room.phase === 'DAY_DEFENSE' && room.straw_results ? (
        <Card className="mb-3">
          <p className="mb-2 text-xs font-semibold tracking-wide text-amber-200 uppercase">
            Straw poll (who voted for whom)
          </p>
          <div className="space-y-3">
            {[...room.straw_results]
              .sort((a, b) => b.count - a.count)
              .map((row) => (
                <div key={row.player_id} className="border-b border-white/5 pb-2 last:border-0">
                  <div className="flex justify-between text-sm font-semibold">
                    <span>{row.name}</span>
                    <span className="text-violet-300">{row.count}</span>
                  </div>
                  <p className="mt-0.5 text-xs text-[var(--muted)]">
                    {row.voters?.length
                      ? row.voters.map((v) => v.name).join(', ')
                      : 'No votes'}
                  </p>
                </div>
              ))}
          </div>
        </Card>
      ) : null}

      {room.phase === 'ENDED' ? (
        <Card className="mb-3 text-center">
          <p className="text-sm tracking-widest text-white/50 uppercase">Winner</p>
          <h2 className="mt-1 text-3xl font-black">
            {room.winner === 'wolves' ? 'Wolves' : 'Village'}
          </h2>
          <div className="mt-4 space-y-2 text-left">
            {players.map((p) => (
              <PlayerChip
                key={p.id}
                name={p.display_name}
                alive={p.is_alive}
                you={p.id === you.player_id}
                host={p.is_host}
                role={p.role ? ROLE_LABELS[p.role] : null}
              />
            ))}
          </div>
          {isHost ? (
            <div className="mt-4">
              <Button onClick={onPlayAgain} disabled={loading}>
                Play again
              </Button>
            </div>
          ) : (
            <p className="mt-4 text-sm text-[var(--muted)]">Waiting for host to play again…</p>
          )}
          <div className="mt-2">
            <Button variant="ghost" onClick={onExit}>
              Leave room
            </Button>
          </div>
        </Card>
      ) : null}

      {room.phase !== 'LOBBY' && room.phase !== 'ENDED' ? (
        <>
          <Card className="mb-3">
            <p className="mb-2 text-xs font-semibold tracking-wide text-white/50 uppercase">Players</p>
            <div className="space-y-2">
              {players.map((p) => (
                <PlayerChip
                  key={p.id}
                  name={p.display_name}
                  alive={p.is_alive}
                  you={p.id === you.player_id}
                  host={p.is_host}
                  role={p.role ? ROLE_LABELS[p.role] : null}
                  selected={picked === p.id}
                  disabled={!targets.some((t) => t.id === p.id) || mySubmitted || !you.is_alive}
                  onClick={
                    targets.some((t) => t.id === p.id) && !mySubmitted && you.is_alive
                      ? () => setPicked(p.id)
                      : undefined
                  }
                  subtitle={
                    you.my_day_vote === p.id
                      ? 'Your vote'
                      : room.phase === 'NIGHT' &&
                          role === 'werewolf' &&
                          you.my_night_actions?.kill_vote === p.id
                        ? 'Your kill vote'
                        : undefined
                  }
                />
              ))}
            </div>
          </Card>

          {targets.length > 0 && you.is_alive ? (
            <div className="mt-auto space-y-2 pb-2">
              {mySubmitted ? (
                <Card className="text-center text-sm text-emerald-200">Submitted — waiting for others…</Card>
              ) : (
                <Button disabled={!picked || loading} onClick={submitAction}>
                  {room.phase === 'NIGHT'
                    ? role === 'werewolf'
                      ? 'Confirm kill vote'
                      : role === 'doctor'
                        ? 'Protect'
                        : 'Investigate'
                    : room.phase === 'DAY_STRAW_VOTE'
                      ? 'Cast straw vote'
                      : 'Cast exile vote'}
                </Button>
              )}
            </div>
          ) : null}

          {(room.phase === 'DAY_ANNOUNCE' ||
            room.phase === 'DAY_DEFENSE' ||
            room.phase === 'DAY_EXECUTE') &&
          you.is_alive ? (
            <div className="mt-auto space-y-2 pb-2">
              <Button disabled={loading || you.i_am_ready} onClick={onReady}>
                {you.i_am_ready
                  ? `Ready (${room.ready_count}/${room.living_count})`
                  : `I'm ready (${room.ready_count}/${room.living_count})`}
              </Button>
            </div>
          ) : null}

          {isHost ? (
            <div className="pb-3">
              <Button variant="secondary" disabled={loading} onClick={onAdvance}>
                Host: force advance
              </Button>
            </div>
          ) : (
            <div className="h-3" />
          )}
        </>
      ) : null}
    </Shell>
  )
}

function isKnownAlly(
  p: PublicPlayer,
  you: RoomState['you'],
): boolean {
  // public players don't include living roles; use ally list
  return Boolean(you.wolf_allies?.some((a) => a.id === p.id)) || p.id === you.player_id
}

function LobbyBody({
  players,
  youId,
  isHost,
  useTimers,
  loading,
  onSetTimers,
  onStart,
  onLeave,
}: {
  players: PublicPlayer[]
  youId: string
  isHost: boolean
  useTimers: boolean
  loading: boolean
  onSetTimers: (v: boolean) => void
  onStart: () => void
  onLeave: () => void
}) {
  const canStart = players.length >= 3
  return (
    <>
      <Card className="mb-3">
        <p className="mb-2 text-xs font-semibold tracking-wide text-white/50 uppercase">
          Players ({players.length}/12)
        </p>
        <div className="space-y-2">
          {players.map((p) => (
            <PlayerChip
              key={p.id}
              name={p.display_name}
              alive
              you={p.id === youId}
              host={p.is_host}
            />
          ))}
        </div>
        {players.length < 5 ? (
          <p className="mt-3 text-xs text-amber-200/90">Best with 5+ players — playable from 3.</p>
        ) : null}
      </Card>

      {isHost ? (
        <Card className="mb-3">
          <label className="flex items-center gap-3 text-sm">
            <input
              type="checkbox"
              checked={useTimers}
              onChange={(e) => onSetTimers(e.target.checked)}
              className="h-4 w-4 accent-violet-500"
            />
            Use recommended timers
          </label>
        </Card>
      ) : null}

      <div className="mt-auto space-y-2 pb-3">
        {isHost ? (
          <Button disabled={!canStart || loading} onClick={onStart}>
            {canStart ? 'Start game' : `Need ${3 - players.length} more to start`}
          </Button>
        ) : (
          <Card className="text-center text-sm text-[var(--muted)]">Waiting for host to start…</Card>
        )}
        <Button variant="ghost" onClick={onLeave} disabled={loading}>
          Leave room
        </Button>
      </div>
    </>
  )
}
