# Wolf Game — rules (beta)

Mobile multiplayer. **No human moderator** — the server runs the game.

## Goal

- **Village wins** when all werewolves are dead.
- **Wolves win** when living werewolves ≥ living non-werewolves.

## Roles

| Role | Night action |
|------|----------------|
| **Villager** | None |
| **Werewolf** | Vote to kill one non-wolf |
| **Police** | Investigate one living player → **Wolf** or **Not wolf** (private) |
| **Doctor** | Protect one living player (**self-protect allowed**) |

On death, roles are revealed publicly.

### Role counts (MVP)

| Players | Wolves | Police | Doctor | Villagers |
|--------:|-------:|-------:|-------:|----------:|
| 3 | 1 | 1 | 0 | 1 |
| 4–6 | 1 | 1 | 1 | rest |
| 7–9 | 2 | 1 | 1 | rest |
| 10–12 | 3 | 1 | 1 | rest |

Min **3**, max **12**. Best with **5+**.

## Night

1. Wolves vote (they see each other and live vote tallies). **Required.**
2. Doctor protects someone (**required** — self OK).
3. Police investigates someone (**required**).
4. Resolution: doctor protect applies after wolf target is chosen.
5. **Wolf tie (first ballot):** revote among tied targets only. **Still tied:** server picks one at random among the tie.

Night ends when wolves + living doctor/police have all acted, host resolves night, or (if enabled) the timer fires.

The app shows a full-screen **Action required** UI for anyone who still must pick a target or tap Ready — so turns are hard to miss.

**Host board (host only):** shows wolves voted X/Y, whether doctor/police acted, day vote counts, and ready counts — never who has which role. Use it to nudge people, not to skip steps lightly.

## Day (two votes)

1. **Morning** — who died (or quiet night).
2. **Straw vote** (non-lethal) — after lock, everyone sees **counts and who voted for whom**.
3. **Defense** — discuss; ready up / host / timer.
4. **Exile vote** (lethal) — majority out; role revealed.
5. **Exile tie:** revote shortlist only. **Still tied:** **all tied players are eliminated**.

## Timers

Default: **off**. Host can enable recommended timers (night/votes 45s, defense 90s). Host can always force advance a phase, and can **restart to lobby** mid-game (same seats, roles cleared).

## How to join

1. Host creates a room → share the **6-character code**.
2. Others join with name + code.
3. Host starts at 3+ players.
4. Refresh is safe: your seat is restored via a secret token in the browser.
