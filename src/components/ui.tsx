import type { InputHTMLAttributes, ReactNode } from 'react'

export function Shell({
  children,
  tone = 'night',
}: {
  children: ReactNode
  tone?: 'night' | 'day' | 'danger'
}) {
  const cls =
    tone === 'day' ? 'phase-day' : tone === 'danger' ? 'phase-danger' : 'phase-night'
  return (
    <div className={`${cls} min-h-dvh`}>
      <div className="safe-pad mx-auto flex min-h-dvh w-full max-w-md flex-col px-4 pt-4">
        {children}
      </div>
    </div>
  )
}

export function Brand() {
  return (
    <div className="mb-6 text-center">
      <div className="text-xs font-semibold tracking-[0.35em] text-violet-300/80 uppercase">
        Party game
      </div>
      <h1 className="mt-1 text-3xl font-black tracking-tight text-white">Wolf Game</h1>
      <p className="mt-1 text-sm text-[var(--muted)]">No moderator. Just your phone.</p>
    </div>
  )
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-2xl border border-white/10 bg-[var(--bg-card)]/90 p-4 shadow-xl backdrop-blur ${className}`}>
      {children}
    </div>
  )
}

export function Button({
  children,
  onClick,
  disabled,
  variant = 'primary',
  className = '',
  type = 'button',
}: {
  children: ReactNode
  onClick?: () => void
  disabled?: boolean
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost'
  className?: string
  type?: 'button' | 'submit'
}) {
  const base =
    'w-full rounded-xl px-4 py-3.5 text-base font-semibold transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40'
  const styles = {
    primary: 'bg-violet-600 text-white hover:bg-violet-500 shadow-lg shadow-violet-900/40',
    secondary: 'bg-white/10 text-white hover:bg-white/15 border border-white/10',
    danger: 'bg-red-600 text-white hover:bg-red-500',
    ghost: 'bg-transparent text-[var(--muted)] hover:text-white',
  }
  return (
    <button type={type} className={`${base} ${styles[variant]} ${className}`} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  )
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full rounded-xl border border-white/15 bg-black/30 px-4 py-3.5 text-base text-white outline-none placeholder:text-white/30 focus:border-violet-400 ${props.className || ''}`}
    />
  )
}

export function PhaseBadge({ label, detail }: { label: string; detail?: string }) {
  return (
    <div className="mb-3 text-center">
      <div className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-black/30 px-3 py-1 text-xs font-semibold tracking-wide text-violet-200 uppercase">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-violet-400" />
        {label}
      </div>
      {detail ? <p className="mt-2 text-sm text-[var(--muted)]">{detail}</p> : null}
    </div>
  )
}

export function Toast({ message, onClose }: { message: string; onClose: () => void }) {
  if (!message) return null
  return (
    <div className="fixed top-3 right-3 left-3 z-50 mx-auto max-w-md">
      <div className="flex items-start gap-3 rounded-xl border border-red-400/30 bg-red-950/95 px-4 py-3 text-sm text-red-50 shadow-xl">
        <p className="flex-1 break-words">{message}</p>
        <button type="button" className="text-red-200" onClick={onClose}>
          ✕
        </button>
      </div>
    </div>
  )
}

export function PlayerChip({
  name,
  alive,
  selected,
  you,
  host,
  role,
  onClick,
  disabled,
  subtitle,
}: {
  name: string
  alive: boolean
  selected?: boolean
  you?: boolean
  host?: boolean
  role?: string | null
  onClick?: () => void
  disabled?: boolean
  subtitle?: string
}) {
  const clickable = Boolean(onClick) && !disabled
  return (
    <button
      type="button"
      disabled={!clickable}
      onClick={onClick}
      className={`flex w-full items-center justify-between rounded-xl border px-3 py-3 text-left transition ${
        selected
          ? 'border-violet-400 bg-violet-600/30'
          : alive
            ? 'border-white/10 bg-white/5 hover:bg-white/10'
            : 'border-white/5 bg-black/20 opacity-60 grayscale'
      } ${!clickable ? 'cursor-default' : ''}`}
    >
      <div>
        <div className="font-semibold text-white">
          {name}
          {you ? <span className="ml-2 text-xs font-normal text-violet-300">(you)</span> : null}
          {host ? <span className="ml-2 text-xs font-normal text-amber-300">host</span> : null}
        </div>
        <div className="text-xs text-[var(--muted)]">
          {!alive ? 'Dead' : subtitle || 'Alive'}
          {role ? ` · ${role}` : ''}
        </div>
      </div>
      <div className={`h-2.5 w-2.5 rounded-full ${alive ? 'bg-emerald-400' : 'bg-red-500'}`} />
    </button>
  )
}
