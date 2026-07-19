import { useState } from 'react'
import { Brand, Button, Card, Input, Shell } from '../components/ui'

export function HomeScreen({
  loading,
  onCreate,
  onJoin,
}: {
  loading: boolean
  onCreate: (name: string, useTimers: boolean) => void
  onJoin: (code: string, name: string) => void
}) {
  const [mode, setMode] = useState<'home' | 'create' | 'join'>('home')
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [useTimers, setUseTimers] = useState(false)

  if (mode === 'home') {
    return (
      <Shell>
        <Brand />
        <Card className="mt-auto space-y-3">
          <p className="text-center text-sm text-[var(--muted)]">
            3–12 players · Best with 5+ · Werewolves, Police & Doctor
          </p>
          <Button onClick={() => setMode('create')} disabled={loading}>
            Create room
          </Button>
          <Button variant="secondary" onClick={() => setMode('join')} disabled={loading}>
            Join with code
          </Button>
        </Card>
        <p className="mt-4 mb-2 text-center text-xs text-white/30">
          Share the room code. Everyone plays on their phone.
        </p>
      </Shell>
    )
  }

  return (
    <Shell>
      <Brand />
      <Card className="space-y-4">
        <h2 className="text-lg font-bold">{mode === 'create' ? 'Create a room' : 'Join a room'}</h2>
        <div>
          <label className="mb-1 block text-xs font-medium text-[var(--muted)]">Your name</label>
          <Input
            placeholder="e.g. Jatin"
            value={name}
            maxLength={24}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </div>
        {mode === 'join' ? (
          <div>
            <label className="mb-1 block text-xs font-medium text-[var(--muted)]">Room code</label>
            <Input
              placeholder="ABC123"
              value={code}
              maxLength={8}
              className="tracking-[0.3em] uppercase"
              onChange={(e) => setCode(e.target.value.toUpperCase())}
            />
          </div>
        ) : (
          <label className="flex items-center gap-3 rounded-xl border border-white/10 bg-black/20 px-3 py-3 text-sm">
            <input
              type="checkbox"
              checked={useTimers}
              onChange={(e) => setUseTimers(e.target.checked)}
              className="h-4 w-4 accent-violet-500"
            />
            <span>
              Use recommended timers
              <span className="mt-0.5 block text-xs text-[var(--muted)]">
                Night 45s · Votes 45s · Defense 90s. Host can still advance.
              </span>
            </span>
          </label>
        )}
        <Button
          disabled={loading || !name.trim() || (mode === 'join' && code.trim().length < 4)}
          onClick={() => {
            if (mode === 'create') onCreate(name.trim(), useTimers)
            else onJoin(code.trim(), name.trim())
          }}
        >
          {loading ? 'Working…' : mode === 'create' ? 'Create' : 'Join'}
        </Button>
        <Button variant="ghost" onClick={() => setMode('home')} disabled={loading}>
          Back
        </Button>
      </Card>
    </Shell>
  )
}
