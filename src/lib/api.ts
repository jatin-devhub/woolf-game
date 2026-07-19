import { friendlyError } from './errors'
import { supabase } from './supabase'
import type { RoomState, Session } from './types'

function rpcError(error: { message?: string; details?: string; hint?: string } | null): Error {
  const msg = error?.message || error?.details || error?.hint || 'Request failed'
  return new Error(friendlyError(msg))
}

export async function createRoom(displayName: string, useTimers = false): Promise<Session> {
  const { data, error } = await supabase.rpc('create_room', {
    p_display_name: displayName,
    p_use_timers: useTimers,
  })
  if (error) throw rpcError(error)
  const d = data as {
    room_id: string
    code: string
    player_id: string
    token: string
    display_name: string
    is_host: boolean
  }
  return {
    roomId: d.room_id,
    code: d.code,
    playerId: d.player_id,
    token: d.token,
    displayName: d.display_name,
    isHost: d.is_host,
  }
}

export async function joinRoom(code: string, displayName: string): Promise<Session> {
  const { data, error } = await supabase.rpc('join_room', {
    p_code: code,
    p_display_name: displayName,
  })
  if (error) throw rpcError(error)
  const d = data as {
    room_id: string
    code: string
    player_id: string
    token: string
    display_name: string
    is_host: boolean
  }
  return {
    roomId: d.room_id,
    code: d.code,
    playerId: d.player_id,
    token: d.token,
    displayName: d.display_name,
    isHost: d.is_host,
  }
}

export async function leaveRoom(session: Session): Promise<void> {
  const { error } = await supabase.rpc('leave_room', {
    p_room_id: session.roomId,
    p_token: session.token,
  })
  if (error) throw rpcError(error)
}

export async function setRoomTimers(session: Session, useTimers: boolean): Promise<void> {
  const { error } = await supabase.rpc('set_room_timers', {
    p_room_id: session.roomId,
    p_token: session.token,
    p_use_timers: useTimers,
  })
  if (error) throw rpcError(error)
}

export async function startGame(session: Session): Promise<void> {
  const { error } = await supabase.rpc('start_game', {
    p_room_id: session.roomId,
    p_token: session.token,
  })
  if (error) throw rpcError(error)
}

export async function submitNightAction(
  session: Session,
  actionType: 'kill_vote' | 'protect' | 'peek',
  targetId: string,
): Promise<void> {
  const { error } = await supabase.rpc('submit_night_action', {
    p_room_id: session.roomId,
    p_token: session.token,
    p_action_type: actionType,
    p_target_id: targetId,
  })
  if (error) throw rpcError(error)
}

export async function submitDayVote(
  session: Session,
  stage: 'straw' | 'exile' | 'exile_revote',
  targetId: string,
): Promise<void> {
  const { error } = await supabase.rpc('submit_day_vote', {
    p_room_id: session.roomId,
    p_token: session.token,
    p_stage: stage,
    p_target_id: targetId,
  })
  if (error) throw rpcError(error)
}

export async function playerReady(session: Session): Promise<void> {
  const { error } = await supabase.rpc('player_ready', {
    p_room_id: session.roomId,
    p_token: session.token,
  })
  if (error) throw rpcError(error)
}

export async function hostAdvance(session: Session): Promise<void> {
  const { error } = await supabase.rpc('host_advance', {
    p_room_id: session.roomId,
    p_token: session.token,
  })
  if (error) throw rpcError(error)
}

export async function playAgain(session: Session): Promise<void> {
  const { error } = await supabase.rpc('play_again', {
    p_room_id: session.roomId,
    p_token: session.token,
  })
  if (error) throw rpcError(error)
}

export async function tickRoom(session: Session): Promise<RoomState> {
  const { data, error } = await supabase.rpc('tick_room', {
    p_room_id: session.roomId,
    p_token: session.token,
  })
  if (error) throw rpcError(error)
  return data as RoomState
}

export async function getRoomState(session: Session): Promise<RoomState> {
  const { data, error } = await supabase.rpc('get_room_state', {
    p_room_id: session.roomId,
    p_token: session.token,
  })
  if (error) throw rpcError(error)
  return data as RoomState
}
