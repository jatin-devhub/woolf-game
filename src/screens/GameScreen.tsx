import { useEffect, useMemo, useState } from 'react'
import { Button, Card, PhaseBadge, PlayerChip, Shell } from '../components/ui'
import {
  PHASE_LABELS,
  ROLE_BLURBS,
  ROLE_LABELS,
  type HostStatus,
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
      if (role === 'werewolf') return 'Your pack must pick a victim. Game waits on you.'
      if (role === 'doctor') return 'You must protect someone (self OK). Game waits on you.'
      if (role === 'police') return 'You must investigate someone. Game waits on you.'
      return 'You sleep. Waiting for night roles to finish…'
    case 'DAY_ANNOUNCE':
      return 'Read the morning news, then tap Ready so the day can continue.'
    case 'DAY_STRAW_VOTE':
      return 'Everyone must cast a straw vote. Non-lethal.'
    case 'DAY_DEFENSE':
      return 'Discuss results, then everyone taps Ready.'
    case 'DAY_EXILE_VOTE':
      return 'Everyone must cast a lethal exile vote.'
    case 'DAY_EXILE_REVOTE':
      return 'Tied! Vote only among the shortlist. Everyone must vote.'
    case 'DAY_EXECUTE':
      return 'Exile resolved. Tap Ready for the next night.'
    case 'ENDED':
      return 'Game over — full roles revealed.'
    default:
      return ''
  }
}

function nightActionTitle(role: Role | null): string {
  if (role === 'werewolf') return 'Choose who the pack kills'
  if (role === 'doctor') return 'Choose who to protect'
  if (role === 'police') return 'Choose who to investigate'
  return 'Your night action'
}

function voteActionTitle(phase: Phase): string {
  if (phase === 'DAY_STRAW_VOTE') return 'Cast your straw vote'
  if (phase === 'DAY_EXILE_REVOTE') return 'Cast your revote'
  return 'Cast your exile vote'
}

function confirmLabel(phase: Phase, role: Role | null): string {
  if (phase === 'NIGHT') {
    if (role === 'werewolf') return 'Lock kill vote'
    if (role === 'doctor') return 'Lock protect'
    if (role === 'police') return 'Lock investigation'
  }
  if (phase === 'DAY_STRAW_VOTE') return 'Lock straw vote'
  return 'Lock exile vote'
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
  onNight: (type: 'kill_vote' | 'protect' | 'peek', id: string | null) => void
  onDayVote: (stage: 'straw' | 'exile' | 'exile_revote', id: string) => void
  onReady: () => void
  onAdvance: () => void
  onPlayAgain: () => void
}) {
  const { room, players, you } = state
  const [picked, setPicked] = useState<string | null>(null)
  const [roleFlash, setRoleFlash] = useState(true)
  const [hostToolsOpen, setHostToolsOpen] = useState(false)

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
      if (role === 'werewolf') return 'kill_vote' in you.my_night_actions
      if (role === 'doctor') return 'protect' in you.my_night_actions
      if (role === 'police') return 'peek' in you.my_night_actions
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

  const needsPick =
    you.is_alive &&
    !mySubmitted &&
    targets.length > 0 &&
    (room.phase === 'NIGHT' ||
      room.phase === 'DAY_STRAW_VOTE' ||
      room.phase === 'DAY_EXILE_VOTE' ||
      room.phase === 'DAY_EXILE_REVOTE')

  const needsReady =
    you.is_alive &&
    !you.i_am_ready &&
    (room.phase === 'DAY_ANNOUNCE' ||
      room.phase === 'DAY_DEFENSE' ||
      room.phase === 'DAY_EXECUTE')

  const mustAct = needsPick || needsReady

  // Clear selection when phase or ballot changes so you can't lock a stale pick
  useEffect(() => {
    setPicked(null)
  }, [room.phase, room.wolf_ballot_round, room.exile_ballot_round, room.day_number, room.night_number])

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

  const confirmRestart = () => {
    const midGame = room.phase !== 'ENDED' && room.phase !== 'LOBBY'
    const msg = midGame
      ? 'Restart the game? Everyone returns to the lobby with the same seats. Roles are cleared.'
      : 'Play again? Same seats, new roles after you start.'
    if (window.confirm(msg)) onPlayAgain()
  }

  if (showRoleCard && role) {
    const hasImmediateAction =
      room.phase === 'NIGHT' &&
      (role === 'werewolf' || role === 'doctor' || role === 'police')
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
          {hasImmediateAction ? (
            <Card className="mt-6 w-full max-w-xs border-amber-400/40 bg-amber-950/40 text-left">
              <p className="text-xs font-semibold tracking-wide text-amber-200 uppercase">
                Action required tonight
              </p>
              <p className="mt-1 text-sm text-amber-50">{nightActionTitle(role)}</p>
              <p className="mt-2 text-xs text-[var(--muted)]">
                Morning will not start until you and the other night roles finish.
              </p>
            </Card>
          ) : null}
          <div className="mt-8 w-full max-w-xs">
            <Button onClick={() => setRoleFlash(false)}>
              {hasImmediateAction ? 'Continue — take your action' : 'Got it'}
            </Button>
          </div>
        </div>
      </Shell>
    )
  }

  // Full-screen action mode: player must pick + lock before seeing the quiet board
  if (needsPick) {
    return (
      <Shell tone={toneFor(room.phase)}>
        <ActionRequiredBanner
          phase={room.phase}
          title={
            room.phase === 'NIGHT' ? nightActionTitle(role) : voteActionTitle(room.phase)
          }
          subtitle={
            room.phase === 'NIGHT'
              ? 'The game is blocked until night roles act. Tap a player, then lock your choice.'
              : 'Everyone living must vote. Tap a player, then lock your vote.'
          }
        />

        {room.phase === 'NIGHT' && role === 'werewolf' ? (
          <PackVotesCard you={you} ballotRound={room.wolf_ballot_round} />
        ) : null}

        <Card className="mb-3 flex-1 border-violet-400/30">
          <p className="mb-2 text-xs font-semibold tracking-wide text-violet-200 uppercase">
            Tap a target ({targets.length} eligible)
          </p>
          <div className="space-y-2">
            {players.map((p) => {
              const eligible = targets.some((t) => t.id === p.id)
              return (
                <PlayerChip
                  key={p.id}
                  name={p.display_name}
                  alive={p.is_alive}
                  you={p.id === you.player_id}
                  host={p.is_host}
                  role={p.role ? ROLE_LABELS[p.role] : null}
                  selected={picked === p.id}
                  disabled={!eligible}
                  onClick={eligible ? () => setPicked(p.id) : undefined}
                  subtitle={eligible ? (picked === p.id ? 'Selected' : 'Tap to select') : undefined}
                />
              )
            })}
          </div>
        </Card>

        <div className="sticky bottom-0 z-10 space-y-2 bg-gradient-to-t from-[var(--bg-deep)] via-[var(--bg-deep)] to-transparent pt-4 pb-3">
          {!picked ? (
            <Card className="border-amber-400/30 bg-amber-950/30 text-center text-sm text-amber-100">
              Select a player above to continue
            </Card>
          ) : (
            <Card className="border-emerald-400/20 bg-emerald-950/20 text-center text-sm text-emerald-100">
              Selected:{' '}
              <strong>{players.find((p) => p.id === picked)?.display_name || '—'}</strong>
            </Card>
          )}
          <Button disabled={!picked || loading} onClick={submitAction} className="action-pulse">
            {confirmLabel(room.phase, role)}
          </Button>
          {isHost ? (
            <button
              type="button"
              className="w-full text-center text-xs text-white/40 underline"
              onClick={() => setHostToolsOpen((v) => !v)}
            >
              {hostToolsOpen ? 'Hide host tools' : 'Host tools (if someone is stuck)'}
            </button>
          ) : null}
          {isHost && hostToolsOpen ? (
            <HostTools
              phase={room.phase}
              loading={loading}
              onAdvance={onAdvance}
              onRestart={confirmRestart}
              status={you.host_status}
            />
          ) : null}
        </div>
      </Shell>
    )
  }

  // Ready-required phases: force the ready CTA up front
  if (needsReady) {
    return (
      <Shell tone={toneFor(room.phase)}>
        <ActionRequiredBanner
          phase={room.phase}
          title="Tap Ready to continue"
          subtitle={`${room.ready_count}/${room.living_count} living players ready. The phase will not move until everyone is ready (or host advances).`}
        />

        {room.last_announcement ? (
          <Card className="mb-3 border-amber-500/20 bg-amber-950/20">
            <p className="text-sm text-amber-50">{room.last_announcement}</p>
          </Card>
        ) : null}

        {(room.phase === 'DAY_ANNOUNCE' || room.phase === 'DAY_EXECUTE') &&
        room.last_deaths?.length ? (
          <DeathsCard deaths={room.last_deaths} />
        ) : null}

        {room.phase === 'DAY_DEFENSE' && room.straw_results ? (
          <StrawResultsCard results={room.straw_results} />
        ) : null}

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
              />
            ))}
          </div>
        </Card>

        <div className="sticky bottom-0 z-10 space-y-2 bg-gradient-to-t from-[var(--bg-deep)] via-[var(--bg-deep)] to-transparent pt-4 pb-3">
          <Button disabled={loading} onClick={onReady} className="action-pulse">
            I&apos;m ready ({room.ready_count}/{room.living_count})
          </Button>
          {isHost ? (
            <HostTools
              phase={room.phase}
              loading={loading}
              onAdvance={onAdvance}
              onRestart={confirmRestart}
              status={you.host_status}
              compact
            />
          ) : null}
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

      {isHost && you.host_status && room.phase !== 'LOBBY' && room.phase !== 'ENDED' ? (
        <HostStatusCard status={you.host_status} />
      ) : null}

      {/* Waiting state after you already acted */}
      {room.phase !== 'LOBBY' && room.phase !== 'ENDED' && you.is_alive && mySubmitted ? (
        <Card className="mb-3 border-emerald-400/30 bg-emerald-950/25 text-center">
          <p className="text-xs font-semibold tracking-wide text-emerald-300 uppercase">
            You&apos;re done
          </p>
          <p className="mt-1 text-sm text-emerald-50">
            Waiting for other players to finish this step…
          </p>
          {room.phase === 'NIGHT' ? (
            <p className="mt-2 text-xs text-[var(--muted)]">
              Night needs every living wolf, doctor, and police to act.
            </p>
          ) : null}
          {room.phase.includes('VOTE') || room.phase.includes('EXILE') ? (
            <p className="mt-2 text-xs text-[var(--muted)]">
              Day votes need every living player.
            </p>
          ) : null}
        </Card>
      ) : null}

      {room.phase === 'NIGHT' &&
      you.is_alive &&
      role === 'villager' &&
      !mustAct ? (
        <Card className="mb-3 border-indigo-400/20 bg-indigo-950/20 text-center">
          <p className="text-lg font-bold text-white">You are asleep</p>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Night roles (wolves, doctor, police) must finish before morning. Stay on this screen.
          </p>
        </Card>
      ) : null}

      {room.phase === 'NIGHT' && role === 'werewolf' && you.is_alive && mySubmitted ? (
        <PackVotesCard you={you} ballotRound={room.wolf_ballot_round} />
      ) : null}

      {role === 'police' && you.last_peek ? (
        <Card className="mb-3 border-sky-400/20">
          <p className="text-xs font-semibold tracking-wide text-sky-300 uppercase">
            Last investigation
          </p>
          <p className="mt-1 text-sm">
            {you.last_peek.target_name}: <strong>{you.last_peek.result}</strong>
          </p>
        </Card>
      ) : null}

      {(room.phase === 'DAY_ANNOUNCE' || room.phase === 'DAY_EXECUTE') &&
      room.last_deaths?.length ? (
        <DeathsCard deaths={room.last_deaths} />
      ) : null}

      {room.phase === 'DAY_DEFENSE' && room.straw_results ? (
        <StrawResultsCard results={room.straw_results} />
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
              <Button onClick={confirmRestart} disabled={loading}>
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
            <p className="mb-2 text-xs font-semibold tracking-wide text-white/50 uppercase">
              Players
            </p>
            <div className="space-y-2">
              {players.map((p) => (
                <PlayerChip
                  key={p.id}
                  name={p.display_name}
                  alive={p.is_alive}
                  you={p.id === you.player_id}
                  host={p.is_host}
                  role={p.role ? ROLE_LABELS[p.role] : null}
                  subtitle={
                    you.my_day_vote === p.id
                      ? 'Your vote'
                      : room.phase === 'NIGHT' &&
                          role === 'werewolf' &&
                          you.my_night_actions?.kill_vote === p.id
                        ? 'Your kill vote'
                        : room.phase === 'NIGHT' &&
                            role === 'doctor' &&
                            you.my_night_actions?.protect === p.id
                          ? 'Your protect'
                          : room.phase === 'NIGHT' &&
                              role === 'police' &&
                              you.my_night_actions?.peek === p.id
                            ? 'Your investigation'
                            : undefined
                  }
                />
              ))}
            </div>
          </Card>

          {you.is_alive && you.i_am_ready &&
          (room.phase === 'DAY_ANNOUNCE' ||
            room.phase === 'DAY_DEFENSE' ||
            room.phase === 'DAY_EXECUTE') ? (
            <Card className="mb-3 text-center text-sm text-emerald-200">
              Ready ({room.ready_count}/{room.living_count}) — waiting for others…
            </Card>
          ) : null}

          {isHost ? (
            <div className="mt-auto space-y-2 pb-3">
              <HostTools
                phase={room.phase}
                loading={loading}
                onAdvance={onAdvance}
                onRestart={confirmRestart}
                status={you.host_status}
              />
            </div>
          ) : (
            <div className="h-3" />
          )}
        </>
      ) : null}
    </Shell>
  )
}

function ActionRequiredBanner({
  phase,
  title,
  subtitle,
}: {
  phase: Phase
  title: string
  subtitle: string
}) {
  return (
    <div className="mb-3">
      <div className="rounded-2xl border border-amber-400/50 bg-gradient-to-br from-amber-950/80 to-violet-950/60 p-4 shadow-lg shadow-amber-900/30 action-glow">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-2.5 w-2.5 animate-pulse rounded-full bg-amber-400" />
          <p className="text-xs font-bold tracking-[0.2em] text-amber-200 uppercase">
            Action required · {PHASE_LABELS[phase]}
          </p>
        </div>
        <h2 className="mt-2 text-xl font-black text-white">{title}</h2>
        <p className="mt-1 text-sm text-amber-50/90">{subtitle}</p>
      </div>
    </div>
  )
}

function PackVotesCard({
  you,
  ballotRound,
}: {
  you: RoomState['you']
  ballotRound: number
}) {
  return (
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
      {ballotRound > 1 ? (
        <p className="mt-2 text-sm text-amber-200">Revote: only tied targets are eligible.</p>
      ) : null}
    </Card>
  )
}

function DeathsCard({
  deaths,
}: {
  deaths: { player_id: string; name: string; role: string; cause: string }[]
}) {
  return (
    <Card className="mb-3 border-red-400/20">
      <p className="mb-2 text-xs font-semibold tracking-wide text-red-300 uppercase">Casualties</p>
      <ul className="space-y-2">
        {deaths.map((d) => (
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
  )
}

function StrawResultsCard({
  results,
}: {
  results: NonNullable<RoomState['room']['straw_results']>
}) {
  return (
    <Card className="mb-3">
      <p className="mb-2 text-xs font-semibold tracking-wide text-amber-200 uppercase">
        Straw poll (who voted for whom)
      </p>
      <div className="space-y-3">
        {[...results]
          .sort((a, b) => b.count - a.count)
          .map((row) => (
            <div key={row.player_id} className="border-b border-white/5 pb-2 last:border-0">
              <div className="flex justify-between text-sm font-semibold">
                <span>{row.name}</span>
                <span className="text-violet-300">{row.count}</span>
              </div>
              <p className="mt-0.5 text-xs text-[var(--muted)]">
                {row.voters?.length ? row.voters.map((v) => v.name).join(', ') : 'No votes'}
              </p>
            </div>
          ))}
      </div>
    </Card>
  )
}

function hostAdvanceLabel(phase: Phase): string {
  switch (phase) {
    case 'NIGHT':
      return 'Host: resolve night now'
    case 'DAY_ANNOUNCE':
      return 'Host: start straw vote'
    case 'DAY_STRAW_VOTE':
      return 'Host: close straw vote'
    case 'DAY_DEFENSE':
      return 'Host: start exile vote'
    case 'DAY_EXILE_VOTE':
    case 'DAY_EXILE_REVOTE':
      return 'Host: resolve exile'
    case 'DAY_EXECUTE':
      return 'Host: go to night'
    default:
      return 'Host: force advance'
  }
}

function HostTools({
  phase,
  loading,
  onAdvance,
  onRestart,
  status,
  compact,
}: {
  phase: Phase
  loading: boolean
  onAdvance: () => void
  onRestart: () => void
  status?: HostStatus
  compact?: boolean
}) {
  return (
    <div className="space-y-2">
      {!compact && status ? <HostStatusCard status={status} /> : null}
      <Button variant="secondary" disabled={loading} onClick={onAdvance}>
        {hostAdvanceLabel(phase)}
      </Button>
      <Button variant="danger" disabled={loading} onClick={onRestart}>
        Host: restart to lobby
      </Button>
    </div>
  )
}

function HostStatusCard({ status }: { status: HostStatus }) {
  const n = status.night
  const v = status.votes
  const r = status.ready
  return (
    <Card className="mb-0 border-amber-500/30 bg-amber-950/25">
      <p className="mb-2 text-xs font-semibold tracking-wide text-amber-200 uppercase">
        Host board — who still needs to act
      </p>
      {n ? (
        <ul className="space-y-1 text-sm">
          <li>
            Wolves:{' '}
            <strong className="text-white">
              {n.wolves_voted}/{n.wolves_living}
            </strong>
            {n.wolf_ballot_round > 1 ? (
              <span className="text-amber-200"> · revote</span>
            ) : null}
          </li>
          {n.doctor_living > 0 ? (
            <li>
              Doctor:{' '}
              <strong className={n.doctor_acted >= n.doctor_living ? 'text-emerald-300' : 'text-amber-200'}>
                {n.doctor_acted >= n.doctor_living ? 'done' : 'MUST ACT'}
              </strong>
            </li>
          ) : (
            <li className="text-[var(--muted)]">Doctor: none</li>
          )}
          {n.police_living > 0 ? (
            <li>
              Police:{' '}
              <strong className={n.police_acted >= n.police_living ? 'text-emerald-300' : 'text-amber-200'}>
                {n.police_acted >= n.police_living ? 'done' : 'MUST ACT'}
              </strong>
            </li>
          ) : (
            <li className="text-[var(--muted)]">Police: none</li>
          )}
          {n.blocking?.length ? (
            <li className="mt-1 font-semibold text-amber-100">
              Nudge: {n.blocking.join(', ')}
            </li>
          ) : (
            <li className="mt-1 text-emerald-200">All night roles done — resolving…</li>
          )}
        </ul>
      ) : null}
      {v ? (
        <p className="text-sm">
          Votes:{' '}
          <strong className="text-white">
            {v.cast}/{v.needed}
          </strong>
          {v.cast < v.needed ? (
            <span className="text-amber-200"> — still waiting on players</span>
          ) : null}
        </p>
      ) : null}
      {r ? (
        <p className="text-sm">
          Ready:{' '}
          <strong className="text-white">
            {r.ready_count}/{r.needed}
          </strong>
        </p>
      ) : null}
      <p className="mt-2 text-xs text-[var(--muted)]">
        Tell people to open the app and finish the amber &quot;Action required&quot; screen. Only
        use resolve/restart if someone truly left.
      </p>
    </Card>
  )
}

function isKnownAlly(p: PublicPlayer, you: RoomState['you']): boolean {
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
