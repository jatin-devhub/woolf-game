# Smoke test notes

## Automated

```bash
npm run test:unit           # pure logic — no network
npm run test:integration    # live RPC: ready→straw + straw→exile (stage-ambiguity regression)
npm run smoke               # 11 multi-player game scenarios against .env
npm run smoke -- --scenario ready_path_announce_to_straw
npm run build
```

### Smoke scenarios (must all pass)

| Scenario | What it proves |
|----------|----------------|
| `lobby_create_join_privacy_start` | lobby, roles private, late join blocked |
| `ready_path_announce_to_straw` | **last “I’m ready” → straw; no SQL ambiguity** |
| `ready_path_defense_to_exile` | straw voters published; defense ready → exile |
| `full_day_exile_and_next_night` | 4p full day → next night |
| `night_kill_resolves_when_all_actors_submit` | wolf+police actions; peek privacy |
| `doctor_save_quiet_night` | protect cancels kill |
| `reconnect_same_token` | refresh restores seat |
| `host_advance_covers_phases` | host-only advance |
| `play_again_resets_to_lobby` | seats kept, roles cleared |
| `invalid_actions_rejected` | wrong-role / self-target rejected |
| `session_survives_repeated_state_fetches` | poll thrash during ready |

Harness: `scripts/lib/game-client.mjs` (multi-seat RPC client).

### Hotfix without restarting the game

`supabase/patches/001_fix_stage_ambiguous.sql` is **CREATE OR REPLACE only**.  
It does **not** drop rooms or tokens. After you run it in the SQL editor, refresh clients — **same game continues**.

## Manual (phones / browsers)

1. `npm run dev` (or deploy `dist/`).
2. **Host:** Create room, copy 6-letter code.
3. **Two more clients:** Join (incognito / second phone / second browser).
4. Start at 3+. Confirm role cards (Police named correctly, not Seer).
5. Night: wolf vote + police peek (and doctor if present) → morning.
6. Straw vote → defense shows **who voted for whom** → exile.
7. Refresh one tab mid-game → same seat restores.
8. Host force-advance works if someone is AFK.
9. End screen + Play again (host).

## Privacy checks

- Living players must **not** see others’ roles in the player list.
- Wolves see allies + live kill votes only on their private panel.
- Police see peek result only on their private panel.
