export type Phase =
  | 'LOBBY'
  | 'NIGHT'
  | 'DAY_ANNOUNCE'
  | 'DAY_STRAW_VOTE'
  | 'DAY_DEFENSE'
  | 'DAY_EXILE_VOTE'
  | 'DAY_EXILE_REVOTE'
  | 'DAY_EXECUTE'
  | 'ENDED'

export type Role = 'villager' | 'werewolf' | 'police' | 'doctor'

export interface Session {
  roomId: string
  code: string
  playerId: string
  token: string
  displayName: string
  isHost: boolean
}

export interface PublicPlayer {
  id: string
  display_name: string
  is_alive: boolean
  is_host: boolean
  seat_order: number
  role: Role | null
}

export interface DeathInfo {
  player_id: string
  name: string
  role: string
  cause: string
}

export interface StrawResult {
  player_id: string
  name: string
  count: number
  voters: { id: string; name: string }[]
}

export interface RoomPublic {
  id: string
  code: string
  phase: Phase
  host_player_id: string | null
  use_timers: boolean
  phase_ends_at: string | null
  night_number: number
  day_number: number
  wolf_ballot_round: number
  wolf_revote_target_ids: string[]
  exile_ballot_round: number
  exile_revote_target_ids: string[]
  last_deaths: DeathInfo[]
  last_announcement: string | null
  straw_results: StrawResult[] | null
  winner: 'village' | 'wolves' | null
  player_count: number
  living_count: number
  ready_count: number
}

/** Host-only progress board (role counts only — never night identities). */
export interface HostStatus {
  phase: Phase
  night?: {
    wolves_living: number
    wolves_voted: number
    doctor_living: number
    doctor_acted: number
    police_living: number
    police_acted: number
    wolf_ballot_round: number
    blocking: string[]
  }
  votes?: {
    cast: number
    needed: number
    stage: string
  }
  ready?: {
    ready_count: number
    needed: number
  }
}

export interface YouPrivate {
  player_id: string
  display_name: string
  role: Role | null
  is_alive: boolean
  is_host: boolean
  wolf_allies?: { id: string; display_name: string }[]
  wolf_votes?: {
    voter_id: string
    voter_name: string
    target_id: string | null
    target_name: string | null
  }[]
  wolf_revote_targets?: string[]
  last_peek?: {
    night_number: number
    target_id: string
    target_name: string
    result: string
  } | null
  /** Maps action_type → target_id (null target = doctor/police skip). */
  my_night_actions?: Record<string, string | null>
  my_day_vote?: string | null
  i_am_ready?: boolean
  host_status?: HostStatus
}

export interface RoomState {
  room: RoomPublic
  players: PublicPlayer[]
  you: YouPrivate
  server_time: string
}

export const ROLE_LABELS: Record<Role, string> = {
  villager: 'Villager',
  werewolf: 'Werewolf',
  police: 'Police',
  doctor: 'Doctor',
}

export const ROLE_BLURBS: Record<Role, string> = {
  villager: 'No night action. Listen, vote, and survive.',
  werewolf: 'Each night, vote with your pack to eliminate someone.',
  police: 'Each night, investigate one person → Wolf or Not wolf.',
  doctor: 'Each night, protect one living player (including yourself).',
}

export const PHASE_LABELS: Record<Phase, string> = {
  LOBBY: 'Lobby',
  NIGHT: 'Night',
  DAY_ANNOUNCE: 'Morning',
  DAY_STRAW_VOTE: 'Straw vote',
  DAY_DEFENSE: 'Defense',
  DAY_EXILE_VOTE: 'Exile vote',
  DAY_EXILE_REVOTE: 'Exile revote',
  DAY_EXECUTE: 'Exile result',
  ENDED: 'Game over',
}
