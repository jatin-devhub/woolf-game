import { useCallback, useEffect, useRef, useState } from 'react'
import * as api from '../lib/api'
import { clearSession, loadSession, saveSession } from '../lib/session'
import type { RoomState, Session } from '../lib/types'

const POLL_MS = 1500

export function useGame() {
  const [session, setSession] = useState<Session | null>(() => loadSession())
  const [state, setState] = useState<RoomState | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [booting, setBooting] = useState(true)
  const sessionRef = useRef(session)
  sessionRef.current = session

  const refresh = useCallback(async () => {
    const s = sessionRef.current
    if (!s) return
    try {
      const next = await api.tickRoom(s)
      setState(next)
      setError(null)
      // keep host flag in sync
      if (next.you.is_host !== s.isHost || next.you.display_name !== s.displayName) {
        const updated = {
          ...s,
          isHost: next.you.is_host,
          displayName: next.you.display_name,
          code: next.room.code,
        }
        saveSession(updated)
        setSession(updated)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Connection error'
      if (msg.includes('INVALID_TOKEN') || msg.includes('ROOM_NOT_FOUND')) {
        clearSession()
        setSession(null)
        setState(null)
      }
      setError(msg)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (!session) {
        setBooting(false)
        return
      }
      try {
        const next = await api.getRoomState(session)
        if (!cancelled) {
          setState(next)
          setError(null)
        }
      } catch (e) {
        if (!cancelled) {
          const msg = e instanceof Error ? e.message : 'Failed to restore session'
          if (msg.includes('INVALID_TOKEN') || msg.includes('ROOM_NOT_FOUND')) {
            clearSession()
            setSession(null)
            setState(null)
          } else {
            setError(msg)
          }
        }
      } finally {
        if (!cancelled) setBooting(false)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-bootstrap only when seat identity changes
  }, [session?.roomId, session?.token])

  useEffect(() => {
    if (!session) return
    const id = window.setInterval(() => {
      void refresh()
    }, POLL_MS)
    return () => window.clearInterval(id)
    // sessionRef used inside refresh; re-bind when seat or poll function changes
  }, [session?.roomId, session?.token, refresh])

  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setLoading(true)
    setError(null)
    try {
      const result = await fn()
      await refresh()
      return result
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong')
      return undefined
    } finally {
      setLoading(false)
    }
  }

  const create = async (name: string, useTimers: boolean) => {
    setLoading(true)
    setError(null)
    try {
      const s = await api.createRoom(name, useTimers)
      saveSession(s)
      setSession(s)
      const st = await api.getRoomState(s)
      setState(st)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Create failed')
    } finally {
      setLoading(false)
    }
  }

  const join = async (code: string, name: string) => {
    setLoading(true)
    setError(null)
    try {
      const s = await api.joinRoom(code, name)
      saveSession(s)
      setSession(s)
      const st = await api.getRoomState(s)
      setState(st)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Join failed')
    } finally {
      setLoading(false)
    }
  }

  const leave = async () => {
    if (!session) return
    try {
      await api.leaveRoom(session)
    } catch {
      /* room may already be gone */
    }
    clearSession()
    setSession(null)
    setState(null)
  }

  const exitToHome = () => {
    clearSession()
    setSession(null)
    setState(null)
  }

  return {
    session,
    state,
    loading,
    error,
    booting,
    setError,
    refresh,
    create,
    join,
    leave,
    exitToHome,
    setTimers: (v: boolean) => run(() => api.setRoomTimers(session!, v)),
    start: () => run(() => api.startGame(session!)),
    nightAction: (type: 'kill_vote' | 'protect' | 'peek', targetId: string | null) =>
      run(() => api.submitNightAction(session!, type, targetId)),
    dayVote: (stage: 'straw' | 'exile' | 'exile_revote', targetId: string) =>
      run(() => api.submitDayVote(session!, stage, targetId)),
    ready: () => run(() => api.playerReady(session!)),
    advance: () => run(() => api.hostAdvance(session!)),
    playAgain: () => run(() => api.playAgain(session!)),
  }
}
