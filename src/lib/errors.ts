/** Map raw Supabase / Postgres errors to short player-facing copy. */
export function friendlyError(raw: string): string {
  const msg = raw.replace(/^.*ERROR:\s*/i, '').split('\n')[0].trim()

  const map: Record<string, string> = {
    NAME_REQUIRED: 'Enter a display name.',
    ROOM_NOT_FOUND: 'Room not found. Check the code.',
    GAME_ALREADY_STARTED: 'That game already started.',
    ROOM_FULL: 'Room is full (max 12).',
    NEED_3_PLAYERS: 'Need at least 3 players to start.',
    TOO_MANY_PLAYERS: 'Too many players.',
    HOST_ONLY: 'Only the host can do that.',
    LOBBY_ONLY: 'Only available in the lobby.',
    ALREADY_STARTED: 'Game already started.',
    INVALID_TOKEN: 'Session expired. Rejoin the room.',
    NOT_NIGHT: 'It is not night.',
    DEAD: 'You are out and cannot act.',
    NOT_WOLF: 'Only werewolves can do that.',
    NOT_DOCTOR: 'Only the doctor can do that.',
    NOT_POLICE: 'Only the police can do that.',
    BAD_ACTION: 'Invalid action.',
    TARGET_REQUIRED: 'Pick a target.',
    INVALID_TARGET: 'That player is not a valid target.',
    CANNOT_TARGET_ALLY: 'You cannot target a fellow werewolf.',
    TARGET_NOT_IN_REVOTE: 'Only tied players are eligible.',
    CANNOT_PEEK_SELF: 'Police cannot investigate themselves.',
    BAD_VOTE_PHASE: 'Voting is closed for this phase.',
    READY_NOT_APPLICABLE: 'Ready is not needed right now.',
    CANNOT_ADVANCE: 'Cannot advance from this phase.',
    NOT_ENDED: 'Game is still going.',
    CANNOT_LEAVE_IN_GAME: 'Leave is only allowed in the lobby. Host can Restart to lobby.',
  }

  if (map[msg]) return map[msg]
  // PostgREST sometimes wraps: "P0001: NEED_3_PLAYERS"
  for (const [code, text] of Object.entries(map)) {
    if (msg.includes(code)) return text
  }
  return msg || 'Something went wrong'
}
