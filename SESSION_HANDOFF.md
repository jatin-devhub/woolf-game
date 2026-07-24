# Wolf Game — session handoff (read this first)

**Last updated:** 2026-07-24 (host tools + night soft-lock fixes)  
**Workspace:** `/home/da-006/Desktop/jatin/personal/wolf-game`  
**Original product pack:** `../wolf-game-handoff/` (`PROMPT_FOR_OTHER_GROK.md`, `VALUES_TO_FILL.md`)

A new Grok/session should start here. Do **not** re-derive product rules from chat — they are in the files below.

---

## Status at handoff

| Area | State |
|------|--------|
| Product / rules | Locked (see `GAME_RULES.md`, handoff prompt) |
| Frontend SPA | **Done** — Vite + React + TS + Tailwind, mobile-first |
| Backend SQL/RPCs | **Done** — `supabase/schema.sql` |
| Cloud Supabase | Project live; **full schema was applied by user once** |
| Known bug fix | **`stage` ambiguous** — fixed in repo; **cloud needs hotpatch if not re-applied** |
| Unit tests | Pass (`npm run test:unit` — 16 tests) |
| Integration / smoke | Comprehensive suite exists; **green on local fixed DB**; cloud fails ready-path until patch |
| Production build | `dist/` builds (`npm run build`) |
| APK / Capacitor | **Not started** — discussed only (see Open work) |
| Static hosting | User said they handle frontend deploy themselves |

### Critical open item (may still be needed)

**Bug:** last player taps **I'm ready** → error `column reference "stage" is ambiguous`.

- **Cause:** PL/pgSQL variable `stage` clashed with `day_votes.stage` in `get_room_state` (and related vote helpers).
- **Fix in repo:** variables renamed to `v_stage` in `supabase/schema.sql`.
- **Cloud apply (non-destructive — game rooms/tokens survive):**  
  Paste and run **`supabase/patches/001_fix_stage_ambiguous.sql`** in Supabase SQL Editor.  
  Then refresh clients; **same game can continue** (no need for new room unless they prefer).
- **Verify:**  
  `npm run smoke -- --scenario ready_path_announce_to_straw`  
  should PASS against cloud after patch.

If user already re-ran full `schema.sql` or the patch after the bug report, cloud is fine — confirm with smoke.

**Not caused by** shared Chrome localStorage (that only confuses multi-tab identity). Multi-player testing: use separate profiles / devices.

---

## How to run demo

```bash
cd /home/da-006/Desktop/jatin/personal/wolf-game
npm install          # if needed
# .env already points at cloud (gitignored) — see .env.example
npm run dev          # http://localhost:5173 — open multiple browsers/phones
```

Cloud project (from values / `.env`):

- URL: `https://dqlnbvmdxeiqitdgotnu.supabase.co`
- Anon key: in `.env` and `../wolf-game-handoff/VALUES_TO_FILL.md` (never commit `service_role`)

Local Supabase (optional, was used for full smoke):

```bash
supabase start
# apply: docker exec -i supabase_db_wolf-game psql -U postgres -d postgres < supabase/schema.sql
# point .env at http://127.0.0.1:54321 + anon from `supabase status`
```

---

## Architecture (beta)

```
SPA (Vite/React)  --HTTP RPC + poll ~1.5s-->  Supabase Postgres
                     security definer RPCs only; RLS blocks table access
```

- Auth: join token in `localStorage` (`src/lib/session.ts`), hashed server-side.
- Privacy: `get_room_state(room_id, token)` returns public board + private slice.
- Phases: LOBBY → NIGHT → DAY_ANNOUNCE → DAY_STRAW_VOTE → DAY_DEFENSE → DAY_EXILE_VOTE → (REVOTE) → DAY_EXECUTE → NIGHT / ENDED.
- Roles: Villager, Werewolf, **Police** (not Seer), Doctor. Counts in SQL `_wg_role_counts` + `src/lib/roles.ts` (must stay in sync).
- Default: no timers; host advance + all-ready; optional timers in lobby.

Key RPCs: `create_room`, `join_room`, `start_game`, `submit_night_action`, `submit_day_vote`, `player_ready`, `host_advance`, `tick_room`, `get_room_state`, `play_again`.

---

## Repo map

```
wolf-game/
  SESSION_HANDOFF.md     ← this file
  README.md              deploy + commands
  GAME_RULES.md          player rules
  SMOKE_TEST.md          test matrix
  .env                   local secrets (gitignored) — cloud URL + anon
  .env.example
  src/
    App.tsx, main.tsx, index.css
    lib/     api, supabase, session, types, roles, errors (+ unit tests)
    hooks/   useGame (poll + session)
    screens/ HomeScreen, GameScreen
    components/ui.tsx
    integration/game-flow.test.ts   live RPC regression tests
  scripts/
    smoke-game.mjs       11 multi-player scenarios
    lib/game-client.mjs  harness
  supabase/
    schema.sql           full install (drops game objects — beta OK)
    patches/
      001_fix_stage_ambiguous.sql   hotpatch, keeps data
  dist/                  last production build
```

---

## Tests (use these; do not rely on thin smokes)

```bash
npm run test:unit           # pure logic
npm run test:integration    # live: ready→straw, straw→exile
npm run smoke               # 11 scenarios against .env backend
npm run test:all
npm run build
```

Smoke scenarios that matter most:

- `ready_path_announce_to_straw` — **the stage bug regression**
- `ready_path_defense_to_exile`
- `doctor_save_quiet_night`, `night_kill_...`, privacy, reconnect, play_again

Harness forces `get_room_state` after every ready/vote so SQL ambiguities fail CI.

---

## Product decisions (do not re-litigate)

- Name: **Wolf Game**; Police not Seer; min 3 max 12; recommend 5+.
- 3p roles: 1 wolf, 1 police, 1 villager (no doctor).
- Day: straw (public who-voted-for-whom) → defense → lethal exile; exile double-tie → kill all tied.
- Night wolf tie → revote → still tie → random among tied.
- Doctor self-protect OK; role reveal on death; no full accounts.
- User hosts frontend themselves; quality bar: office friends on phones, no moderator.

Full checklist: `../wolf-game-handoff/PROMPT_FOR_OTHER_GROK.md`.

---

## 2026-07-24 fixes (apply on cloud)

Embarrassing stuck night + no restart: night auto-advance requires **wolves + doctor + police**; with 8p (2 wolves) both wolves voting is not enough if doctor/police AFK or sabotaging. Host had force-advance but no progress board and no mid-game restart.

**Cloud apply (non-destructive):** paste `supabase/patches/002_host_tools_night_status.sql` in SQL Editor. Also deploy new `dist/`.

Verify: `npm run smoke` against cloud after patch (14 scenarios).

## Open work / next session ideas

1. **Confirm cloud has stage + host-tools patches** (`npm run smoke` all green on cloud `.env`).
2. **Optional polish:** UX, empty states, timer countdown UI, analytics (user said optional).
3. **APK (discussed, not built):** Capacitor wrap of same SPA → no static host; still needs Supabase + network. Machine had Java 11 but **no Android SDK** at last check. Scaffold Capacitor + install SDK to produce debug APK.
4. **Deploy:** user uploads `dist/` when ready; set `VITE_*` at build time.
5. **Multi-tab testing:** use separate browser profiles — one profile shares `localStorage` and breaks multi-seat reconnect.

---

## Security notes

- Anon key is public-by-design for SPA; **never** put `service_role` in frontend or git.
- `.env` is gitignored; `VALUES_TO_FILL.md` in handoff pack contains secrets — treat carefully.
- RLS enabled; clients only `GRANT EXECUTE` on RPCs.

---

## Suggested first message for a new session

> Read `wolf-game/SESSION_HANDOFF.md` and continue from there. Priority: verify cloud stage hotpatch with `npm run smoke`, then [polish / Capacitor APK / deploy help].

---

## Quick verification checklist for new agent

- [ ] `cd wolf-game && npm run test:unit` green  
- [ ] `npm run smoke -- --scenario ready_path_announce_to_straw` green on cloud  
- [ ] If red with `stage is ambiguous` → apply `supabase/patches/001_fix_stage_ambiguous.sql`  
- [ ] `npm run dev` → 3 browsers → full game  
- [ ] Do not re-scaffold from scratch unless user asks  
