# Wolf Game

Mobile-first multiplayer **Werewolf** party game. No human moderator — **Supabase** is the authority. Frontend is a static SPA (Vite + React + TypeScript).

> **New session / new agent:** read **[SESSION_HANDOFF.md](./SESSION_HANDOFF.md)** first for status, bugs, tests, and next steps.

## Quick start (demo)

### 1. Env

```bash
cd wolf-game
cp .env.example .env
# Fill VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY (already set if you use the project .env)
```

### 2. Database (once per Supabase project)

In [Supabase SQL Editor](https://supabase.com/dashboard) → paste and run:

`supabase/schema.sql`

### 3. Run

```bash
npm install
npm run dev
```

Open the printed URL on your phone (same Wi‑Fi) or use multiple browser profiles/tabs.

### 4. Tests

```bash
npm run test:unit         # pure logic (roles, win math, tallies)
npm run test:integration  # live RPC regression (ready→straw, straw→exile)
npm run smoke             # full multi-scenario game simulations (11 cases)
npm run test:all          # unit + integration + smoke
npm run build             # production build → dist/
```

`smoke` opens real multi-player seats against whatever is in `.env` (cloud or local). It covers quiet night, **all-ready phase transitions**, doctor save, privacy, reconnect, play again, and invalid actions.

Host: **Create room** → share code → others **Join** → **Start** at 3+ players.

## Architecture

```
Phone browsers (SPA)  --HTTP RPC + poll ~1.5s-->  Supabase (Postgres security-definer RPCs)
```

- **No open table access** (RLS on; clients only call RPCs).
- **Auth (beta):** `player_id` + secret `token` in `localStorage` (hashed server-side).
- **Privacy:** `get_room_state` returns public board + private slice for the calling token only.
- **Realtime later:** polling is intentional; phase machine is server-side so Realtime can be added without rewriting rules.

### Main RPCs

| RPC | Purpose |
|-----|---------|
| `create_room` / `join_room` / `leave_room` | Lobby |
| `start_game` | Assign roles → night |
| `submit_night_action` | Wolf / doctor / police |
| `submit_day_vote` | Straw / exile / revote |
| `player_ready` / `host_advance` | No-timer progression |
| `tick_room` | Idempotent resolve + return state |
| `get_room_state` | Public + private view |
| `play_again` | Reset to lobby |

See [GAME_RULES.md](./GAME_RULES.md) for player-facing rules.

## Deploy frontend

```bash
npm run build
# upload dist/ to any static host (Cloudflare Pages, Netlify, cPanel, …)
```

Set the same `VITE_*` vars at build time. **Never** put the `service_role` key in the frontend.

## Local Supabase (optional)

```bash
supabase start
# apply: docker exec -i supabase_db_wolf-game psql -U postgres -d postgres < supabase/schema.sql
# point .env at http://127.0.0.1:54321 + local anon key from `supabase status`
```

## Engineering notes

- Role math is mirrored in SQL (`_wg_role_counts`) and TS (`src/lib/roles.ts`) — unit tests lock the table.
- Errors raised as short codes (`NEED_3_PLAYERS`, …) and mapped to UI copy in `src/lib/errors.ts`.
- Re-running `schema.sql` is safe for beta (drops and recreates game objects).

## Project layout

```
src/
  lib/          # API client, types, pure rules helpers
  hooks/        # useGame (session + polling)
  screens/      # Home + in-game
  components/   # UI primitives
supabase/
  schema.sql    # tables + RLS + RPCs
scripts/
  smoke-game.mjs
```
