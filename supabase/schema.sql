-- Wolf Game — full schema + RPCs
-- Paste entire file into Supabase SQL Editor (or: psql / supabase db execute)
-- Safe to re-run: drops game objects first.

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Clean reinstall (dev / beta)
-- ---------------------------------------------------------------------------
drop function if exists public.create_room(text, boolean) cascade;
drop function if exists public.join_room(text, text) cascade;
drop function if exists public.leave_room(uuid, text) cascade;
drop function if exists public.set_room_timers(uuid, text, boolean) cascade;
drop function if exists public.start_game(uuid, text) cascade;
drop function if exists public.submit_night_action(uuid, text, text, uuid) cascade;
drop function if exists public.submit_day_vote(uuid, text, text, uuid) cascade;
drop function if exists public.player_ready(uuid, text) cascade;
drop function if exists public.host_advance(uuid, text) cascade;
drop function if exists public.play_again(uuid, text) cascade;
drop function if exists public.tick_room(uuid, text) cascade;
drop function if exists public.get_room_state(uuid, text) cascade;
drop function if exists public._wg_token_hash(text) cascade;
drop function if exists public._wg_player(uuid, text) cascade;
drop function if exists public._wg_room_code() cascade;
drop function if exists public._wg_role_counts(int) cascade;
drop function if exists public._wg_assign_roles(uuid) cascade;
drop function if exists public._wg_living(uuid) cascade;
drop function if exists public._wg_count_living_wolves(uuid) cascade;
drop function if exists public._wg_count_living_non_wolves(uuid) cascade;
drop function if exists public._wg_check_win(uuid) cascade;
drop function if exists public._wg_set_phase(uuid, text, int) cascade;
drop function if exists public._wg_resolve_night(uuid) cascade;
drop function if exists public._wg_resolve_straw(uuid) cascade;
drop function if exists public._wg_resolve_exile(uuid) cascade;
drop function if exists public._wg_maybe_advance(uuid) cascade;
drop function if exists public._wg_public_players(uuid) cascade;
drop function if exists public._wg_kill_player(uuid, uuid, text) cascade;

drop table if exists public.player_ready_flags cascade;
drop table if exists public.peeks cascade;
drop table if exists public.day_votes cascade;
drop table if exists public.night_actions cascade;
drop table if exists public.players cascade;
drop table if exists public.rooms cascade;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  phase text not null default 'LOBBY',
  host_player_id uuid,
  use_timers boolean not null default false,
  timer_night_sec int not null default 45,
  timer_straw_sec int not null default 45,
  timer_defense_sec int not null default 90,
  timer_exile_sec int not null default 45,
  phase_ends_at timestamptz,
  night_number int not null default 0,
  day_number int not null default 0,
  wolf_ballot_round int not null default 1,
  wolf_revote_target_ids uuid[] not null default '{}',
  exile_ballot_round int not null default 1,
  exile_revote_target_ids uuid[] not null default '{}',
  last_deaths jsonb not null default '[]'::jsonb,
  last_announcement text,
  straw_results jsonb,
  winner text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint rooms_phase_check check (phase in (
    'LOBBY','NIGHT','DAY_ANNOUNCE','DAY_STRAW_VOTE','DAY_DEFENSE',
    'DAY_EXILE_VOTE','DAY_EXILE_REVOTE','DAY_EXECUTE','ENDED'
  ))
);

create table public.players (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  display_name text not null,
  token_hash text not null,
  role text,
  is_alive boolean not null default true,
  is_host boolean not null default false,
  seat_order int not null default 0,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint players_role_check check (role is null or role in ('villager','werewolf','police','doctor')),
  unique (room_id, token_hash)
);

create index players_room_idx on public.players(room_id);

alter table public.rooms
  add constraint rooms_host_fk
  foreign key (host_player_id) references public.players(id) on delete set null;

create table public.night_actions (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  night_number int not null,
  player_id uuid not null references public.players(id) on delete cascade,
  action_type text not null,
  target_id uuid references public.players(id) on delete set null,
  ballot_round int not null default 1,
  updated_at timestamptz not null default now(),
  constraint night_actions_type_check check (action_type in ('kill_vote','protect','peek')),
  unique (room_id, night_number, player_id, action_type, ballot_round)
);

create table public.day_votes (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  day_number int not null,
  stage text not null,
  voter_id uuid not null references public.players(id) on delete cascade,
  target_id uuid references public.players(id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint day_votes_stage_check check (stage in ('straw','exile','exile_revote')),
  unique (room_id, day_number, stage, voter_id)
);

create table public.peeks (
  room_id uuid not null references public.rooms(id) on delete cascade,
  night_number int not null,
  police_id uuid not null references public.players(id) on delete cascade,
  target_id uuid not null references public.players(id) on delete cascade,
  is_wolf boolean not null,
  primary key (room_id, night_number, police_id)
);

create table public.player_ready_flags (
  room_id uuid not null references public.rooms(id) on delete cascade,
  phase text not null,
  player_id uuid not null references public.players(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (room_id, phase, player_id)
);

-- ---------------------------------------------------------------------------
-- RLS: no direct table access; all via security definer RPCs
-- ---------------------------------------------------------------------------
alter table public.rooms enable row level security;
alter table public.players enable row level security;
alter table public.night_actions enable row level security;
alter table public.day_votes enable row level security;
alter table public.peeks enable row level security;
alter table public.player_ready_flags enable row level security;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public._wg_token_hash(p_token text)
returns text
language sql
immutable
as $$
  select encode(extensions.digest(p_token, 'sha256'), 'hex');
$$;

create or replace function public._wg_room_code()
returns text
language plpgsql
as $$
declare
  chars text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  new_code text;
  i int;
begin
  loop
    new_code := '';
    for i in 1..6 loop
      new_code := new_code || substr(chars, 1 + floor(random() * length(chars))::int, 1);
    end loop;
    exit when not exists (select 1 from public.rooms r where r.code = new_code);
  end loop;
  return new_code;
end;
$$;

create or replace function public._wg_player(p_room_id uuid, p_token text)
returns public.players
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  p public.players;
begin
  select * into p
  from public.players
  where room_id = p_room_id
    and token_hash = public._wg_token_hash(p_token);
  if not found then
    raise exception 'INVALID_TOKEN' using errcode = 'P0001';
  end if;
  return p;
end;
$$;

create or replace function public._wg_role_counts(p_n int)
returns table(wolves int, police int, doctor int, villagers int)
language plpgsql
immutable
as $$
declare
  w int;
  p int := 1;
  d int;
  v int;
begin
  if p_n < 3 then
    raise exception 'TOO_FEW_PLAYERS' using errcode = 'P0001';
  end if;
  if p_n = 3 then
    w := 1; d := 0;
  elsif p_n <= 6 then
    w := 1; d := 1;
  elsif p_n <= 9 then
    w := 2; d := 1;
  else
    w := 3; d := 1; -- 10–12
  end if;
  v := p_n - w - p - d;
  if v < 0 then
    raise exception 'BAD_ROLE_MATH' using errcode = 'P0001';
  end if;
  return query select w, p, d, v;
end;
$$;

create or replace function public._wg_assign_roles(p_room_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
  rc record;
  ids uuid[];
  bag text[] := '{}';
  i int;
begin
  select array_agg(id order by seat_order, created_at) into ids
  from public.players where room_id = p_room_id;
  n := coalesce(array_length(ids, 1), 0);
  select * into rc from public._wg_role_counts(n);

  for i in 1..rc.wolves loop bag := bag || array['werewolf']; end loop;
  for i in 1..rc.police loop bag := bag || array['police']; end loop;
  for i in 1..rc.doctor loop bag := bag || array['doctor']; end loop;
  for i in 1..rc.villagers loop bag := bag || array['villager']; end loop;

  -- Fisher–Yates shuffle
  for i in reverse array_length(bag,1)..2 loop
    declare
      j int := 1 + floor(random() * i)::int;
      tmp text;
    begin
      tmp := bag[i];
      bag[i] := bag[j];
      bag[j] := tmp;
    end;
  end loop;

  for i in 1..n loop
    update public.players set role = bag[i], is_alive = true
    where id = ids[i];
  end loop;
end;
$$;

create or replace function public._wg_set_phase(p_room_id uuid, p_phase text, p_timer_sec int default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.rooms;
  secs int;
begin
  select * into r from public.rooms where id = p_room_id for update;
  delete from public.player_ready_flags where room_id = p_room_id;

  secs := null;
  if r.use_timers and p_timer_sec is not null and p_timer_sec > 0 then
    secs := p_timer_sec;
  end if;

  update public.rooms set
    phase = p_phase,
    phase_ends_at = case when secs is not null then now() + make_interval(secs => secs) else null end,
    updated_at = now()
  where id = p_room_id;
end;
$$;

create or replace function public._wg_check_win(p_room_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  wolves int;
  non_wolves int;
begin
  select count(*) into wolves
  from public.players
  where room_id = p_room_id and is_alive and role = 'werewolf';

  select count(*) into non_wolves
  from public.players
  where room_id = p_room_id and is_alive and coalesce(role, '') <> 'werewolf';

  if wolves = 0 then
    update public.rooms set winner = 'village', phase = 'ENDED', phase_ends_at = null, updated_at = now()
    where id = p_room_id;
    return 'village';
  end if;
  if wolves >= non_wolves then
    update public.rooms set winner = 'wolves', phase = 'ENDED', phase_ends_at = null, updated_at = now()
    where id = p_room_id;
    return 'wolves';
  end if;
  return null;
end;
$$;

create or replace function public._wg_kill_player(p_room_id uuid, p_player_id uuid, p_cause text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  pl public.players;
  death jsonb;
begin
  select * into pl from public.players where id = p_player_id and room_id = p_room_id;
  if not found or not pl.is_alive then
    return null;
  end if;
  update public.players set is_alive = false where id = p_player_id;
  death := jsonb_build_object(
    'player_id', pl.id,
    'name', pl.display_name,
    'role', pl.role,
    'cause', p_cause
  );
  return death;
end;
$$;

create or replace function public._wg_resolve_night(p_room_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.rooms;
  wolf_ids uuid[];
  living_wolves int;
  vote_rec record;
  max_votes int;
  tied uuid[] := '{}';
  target uuid;
  protect_target uuid;
  death jsonb;
  deaths jsonb := '[]'::jsonb;
  peeker record;
  tgt public.players;
begin
  select * into r from public.rooms where id = p_room_id for update;
  if r.phase <> 'NIGHT' then
    return;
  end if;

  select array_agg(id) into wolf_ids
  from public.players
  where room_id = p_room_id and is_alive and role = 'werewolf';
  living_wolves := coalesce(array_length(wolf_ids, 1), 0);

  -- tally kill votes for current ballot round
  max_votes := 0;
  for vote_rec in
    select na.target_id as tid, count(*)::int as c
    from public.night_actions na
    where na.room_id = p_room_id
      and na.night_number = r.night_number
      and na.action_type = 'kill_vote'
      and na.ballot_round = r.wolf_ballot_round
      and na.target_id is not null
    group by na.target_id
  loop
    if vote_rec.c > max_votes then
      max_votes := vote_rec.c;
      tied := array[vote_rec.tid];
    elsif vote_rec.c = max_votes and vote_rec.c > 0 then
      tied := tied || vote_rec.tid;
    end if;
  end loop;

  if max_votes = 0 or array_length(tied, 1) is null then
    -- no votes → quiet night
    target := null;
  elsif array_length(tied, 1) > 1 then
    if r.wolf_ballot_round = 1 then
      update public.rooms set
        wolf_ballot_round = 2,
        wolf_revote_target_ids = tied,
        last_announcement = 'Wolves tied — revote among tied targets.',
        updated_at = now()
      where id = p_room_id;
      -- stay in NIGHT for revote; clear phase timer refresh
      perform public._wg_set_phase(p_room_id, 'NIGHT', (select timer_night_sec from public.rooms where id = p_room_id));
      update public.rooms set wolf_ballot_round = 2, wolf_revote_target_ids = tied where id = p_room_id;
      return;
    else
      -- random among tied
      target := tied[1 + floor(random() * array_length(tied, 1))::int];
    end if;
  else
    target := tied[1];
  end if;

  -- doctor protect (any ballot of this night; latest)
  select na.target_id into protect_target
  from public.night_actions na
  join public.players p on p.id = na.player_id
  where na.room_id = p_room_id
    and na.night_number = r.night_number
    and na.action_type = 'protect'
    and p.role = 'doctor'
  order by na.updated_at desc
  limit 1;

  -- police peeks
  for peeker in
    select na.player_id as police_id, na.target_id
    from public.night_actions na
    join public.players p on p.id = na.player_id
    where na.room_id = p_room_id
      and na.night_number = r.night_number
      and na.action_type = 'peek'
      and p.role = 'police'
      and na.target_id is not null
  loop
    select * into tgt from public.players where id = peeker.target_id;
    insert into public.peeks(room_id, night_number, police_id, target_id, is_wolf)
    values (p_room_id, r.night_number, peeker.police_id, peeker.target_id, tgt.role = 'werewolf')
    on conflict (room_id, night_number, police_id) do update
      set target_id = excluded.target_id, is_wolf = excluded.is_wolf;
  end loop;

  if target is not null and (protect_target is null or protect_target <> target) then
    death := public._wg_kill_player(p_room_id, target, 'night');
    if death is not null then
      deaths := deaths || jsonb_build_array(death);
    end if;
  end if;

  update public.rooms set
    last_deaths = deaths,
    last_announcement = case
      when jsonb_array_length(deaths) = 0 then 'The night was quiet. No one died.'
      else 'Morning comes. Someone did not survive the night.'
    end,
    wolf_ballot_round = 1,
    wolf_revote_target_ids = '{}',
    day_number = r.day_number + 1,
    updated_at = now()
  where id = p_room_id;

  if public._wg_check_win(p_room_id) is not null then
    return;
  end if;

  perform public._wg_set_phase(p_room_id, 'DAY_ANNOUNCE', null);
end;
$$;

create or replace function public._wg_resolve_straw(p_room_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.rooms;
  results jsonb := '[]'::jsonb;
  rec record;
  voters jsonb;
begin
  select * into r from public.rooms where id = p_room_id for update;
  if r.phase <> 'DAY_STRAW_VOTE' then
    return;
  end if;

  for rec in
    select p.id, p.display_name,
      coalesce((
        select count(*) from public.day_votes dv
        where dv.room_id = p_room_id and dv.day_number = r.day_number
          and dv.stage = 'straw' and dv.target_id = p.id
      ), 0)::int as vote_count
    from public.players p
    where p.room_id = p_room_id and p.is_alive
    order by p.seat_order
  loop
    select coalesce(jsonb_agg(jsonb_build_object('id', v.id, 'name', v.display_name) order by v.display_name), '[]'::jsonb)
    into voters
    from public.day_votes dv
    join public.players v on v.id = dv.voter_id
    where dv.room_id = p_room_id and dv.day_number = r.day_number
      and dv.stage = 'straw' and dv.target_id = rec.id;

    results := results || jsonb_build_array(jsonb_build_object(
      'player_id', rec.id,
      'name', rec.display_name,
      'count', rec.vote_count,
      'voters', voters
    ));
  end loop;

  update public.rooms set straw_results = results, last_announcement = 'Straw poll results are in. Defend yourselves.', updated_at = now()
  where id = p_room_id;

  perform public._wg_set_phase(p_room_id, 'DAY_DEFENSE', (select timer_defense_sec from public.rooms where id = p_room_id));
end;
$$;

create or replace function public._wg_resolve_exile(p_room_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.rooms;
  v_stage text;
  max_votes int := 0;
  tied uuid[] := '{}';
  vote_rec record;
  death jsonb;
  deaths jsonb := '[]'::jsonb;
  tid uuid;
  win text;
begin
  select * into r from public.rooms where id = p_room_id for update;
  if r.phase = 'DAY_EXILE_VOTE' then
    v_stage := 'exile';
  elsif r.phase = 'DAY_EXILE_REVOTE' then
    v_stage := 'exile_revote';
  else
    return;
  end if;

  for vote_rec in
    select dv.target_id as tid, count(*)::int as c
    from public.day_votes dv
    where dv.room_id = p_room_id
      and dv.day_number = r.day_number
      and dv.stage = v_stage
      and dv.target_id is not null
    group by dv.target_id
  loop
    if vote_rec.c > max_votes then
      max_votes := vote_rec.c;
      tied := array[vote_rec.tid];
    elsif vote_rec.c = max_votes and vote_rec.c > 0 then
      tied := tied || vote_rec.tid;
    end if;
  end loop;

  if max_votes = 0 or array_length(tied, 1) is null then
    -- no votes: skip exile
    update public.rooms set
      last_deaths = '[]'::jsonb,
      last_announcement = 'No one was exiled today.',
      exile_ballot_round = 1,
      exile_revote_target_ids = '{}',
      updated_at = now()
    where id = p_room_id;
    perform public._wg_set_phase(p_room_id, 'DAY_EXECUTE', null);
    -- auto continue to night after announce-style execute
    if public._wg_check_win(p_room_id) is null then
      update public.rooms set night_number = night_number + 1, wolf_ballot_round = 1, wolf_revote_target_ids = '{}', updated_at = now()
      where id = p_room_id;
      perform public._wg_set_phase(p_room_id, 'NIGHT', (select timer_night_sec from public.rooms where id = p_room_id));
    end if;
    return;
  end if;

  if array_length(tied, 1) > 1 and r.phase = 'DAY_EXILE_VOTE' then
    update public.rooms set
      exile_ballot_round = 2,
      exile_revote_target_ids = tied,
      last_announcement = 'Exile vote tied — revote among the tied players.',
      updated_at = now()
    where id = p_room_id;
    perform public._wg_set_phase(p_room_id, 'DAY_EXILE_REVOTE', (select timer_exile_sec from public.rooms where id = p_room_id));
    update public.rooms set exile_ballot_round = 2, exile_revote_target_ids = tied where id = p_room_id;
    return;
  end if;

  -- single winner, or second-round multi-kill all tied
  foreach tid in array tied loop
    death := public._wg_kill_player(p_room_id, tid, 'exile');
    if death is not null then
      deaths := deaths || jsonb_build_array(death);
    end if;
  end loop;

  update public.rooms set
    last_deaths = deaths,
    last_announcement = case
      when jsonb_array_length(deaths) = 0 then 'No one was exiled.'
      when jsonb_array_length(deaths) = 1 then format('%s was exiled.', deaths->0->>'name')
      else 'Multiple players were exiled after a tied revote.'
    end,
    exile_ballot_round = 1,
    exile_revote_target_ids = '{}',
    updated_at = now()
  where id = p_room_id;

  perform public._wg_set_phase(p_room_id, 'DAY_EXECUTE', null);

  win := public._wg_check_win(p_room_id);
  if win is not null then
    return;
  end if;

  -- brief execute then night (client can show; host_advance also works)
  -- Auto-advance to night for smoother beta unless timers mode wants pause — we stay on DAY_EXECUTE
  -- until host_advance / all ready / tick with no timer auto.
end;
$$;

create or replace function public._wg_maybe_advance(p_room_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.rooms;
  living int;
  wolves_living int;
  wolves_voted int;
  doctor_living int;
  doctor_done int;
  police_living int;
  police_done int;
  votes int;
  ready_count int;
  need_ready int;
begin
  select * into r from public.rooms where id = p_room_id for update;
  if r.phase = 'ENDED' or r.phase = 'LOBBY' then
    return;
  end if;

  -- timer expiry
  if r.use_timers and r.phase_ends_at is not null and now() >= r.phase_ends_at then
    if r.phase = 'NIGHT' then
      perform public._wg_resolve_night(p_room_id);
      return;
    elsif r.phase = 'DAY_STRAW_VOTE' then
      perform public._wg_resolve_straw(p_room_id);
      return;
    elsif r.phase = 'DAY_DEFENSE' then
      perform public._wg_set_phase(p_room_id, 'DAY_EXILE_VOTE', r.timer_exile_sec);
      return;
    elsif r.phase in ('DAY_EXILE_VOTE','DAY_EXILE_REVOTE') then
      perform public._wg_resolve_exile(p_room_id);
      return;
    elsif r.phase = 'DAY_ANNOUNCE' then
      perform public._wg_set_phase(p_room_id, 'DAY_STRAW_VOTE', r.timer_straw_sec);
      return;
    elsif r.phase = 'DAY_EXECUTE' then
      if public._wg_check_win(p_room_id) is null then
        update public.rooms set night_number = night_number + 1, updated_at = now() where id = p_room_id;
        perform public._wg_set_phase(p_room_id, 'NIGHT', r.timer_night_sec);
      end if;
      return;
    end if;
  end if;

  select count(*) into living from public.players where room_id = p_room_id and is_alive;

  if r.phase = 'NIGHT' then
    select count(*) into wolves_living from public.players where room_id = p_room_id and is_alive and role = 'werewolf';
    select count(*) into wolves_voted
    from public.night_actions na
    join public.players p on p.id = na.player_id
    where na.room_id = p_room_id and na.night_number = r.night_number
      and na.action_type = 'kill_vote' and na.ballot_round = r.wolf_ballot_round
      and p.role = 'werewolf' and p.is_alive and na.target_id is not null;

    select count(*) into doctor_living from public.players where room_id = p_room_id and is_alive and role = 'doctor';
    select count(*) into doctor_done
    from public.night_actions na
    join public.players p on p.id = na.player_id
    where na.room_id = p_room_id and na.night_number = r.night_number
      and na.action_type = 'protect' and p.role = 'doctor' and p.is_alive;

    select count(*) into police_living from public.players where room_id = p_room_id and is_alive and role = 'police';
    select count(*) into police_done
    from public.night_actions na
    join public.players p on p.id = na.player_id
    where na.room_id = p_room_id and na.night_number = r.night_number
      and na.action_type = 'peek' and p.role = 'police' and p.is_alive;

    -- On wolf revote round, doctor/police already acted; only need wolves
    if r.wolf_ballot_round > 1 then
      if wolves_living > 0 and wolves_voted >= wolves_living then
        perform public._wg_resolve_night(p_room_id);
      end if;
    else
      if wolves_living > 0 and wolves_voted >= wolves_living
         and (doctor_living = 0 or doctor_done >= doctor_living)
         and (police_living = 0 or police_done >= police_living) then
        perform public._wg_resolve_night(p_room_id);
      end if;
    end if;
    return;
  end if;

  if r.phase = 'DAY_STRAW_VOTE' then
    select count(*) into votes from public.day_votes
    where room_id = p_room_id and day_number = r.day_number and stage = 'straw' and target_id is not null;
    if living > 0 and votes >= living then
      perform public._wg_resolve_straw(p_room_id);
    end if;
    return;
  end if;

  if r.phase = 'DAY_EXILE_VOTE' then
    select count(*) into votes from public.day_votes
    where room_id = p_room_id and day_number = r.day_number and stage = 'exile' and target_id is not null;
    if living > 0 and votes >= living then
      perform public._wg_resolve_exile(p_room_id);
    end if;
    return;
  end if;

  if r.phase = 'DAY_EXILE_REVOTE' then
    select count(*) into votes from public.day_votes
    where room_id = p_room_id and day_number = r.day_number and stage = 'exile_revote' and target_id is not null;
    if living > 0 and votes >= living then
      perform public._wg_resolve_exile(p_room_id);
    end if;
    return;
  end if;

  if r.phase in ('DAY_ANNOUNCE','DAY_DEFENSE','DAY_EXECUTE') then
    select count(*) into ready_count from public.player_ready_flags
    where room_id = p_room_id and phase = r.phase;
    need_ready := living;
    if need_ready > 0 and ready_count >= need_ready then
      if r.phase = 'DAY_ANNOUNCE' then
        perform public._wg_set_phase(p_room_id, 'DAY_STRAW_VOTE', r.timer_straw_sec);
      elsif r.phase = 'DAY_DEFENSE' then
        perform public._wg_set_phase(p_room_id, 'DAY_EXILE_VOTE', r.timer_exile_sec);
      elsif r.phase = 'DAY_EXECUTE' then
        if public._wg_check_win(p_room_id) is null then
          update public.rooms set night_number = night_number + 1, updated_at = now() where id = p_room_id;
          perform public._wg_set_phase(p_room_id, 'NIGHT', r.timer_night_sec);
        end if;
      end if;
    end if;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Public RPCs
-- ---------------------------------------------------------------------------
create or replace function public.create_room(p_display_name text, p_use_timers boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token text := encode(extensions.gen_random_bytes(24), 'hex');
  v_room public.rooms;
  v_player public.players;
  v_name text := trim(p_display_name);
begin
  if v_name is null or length(v_name) < 1 then
    raise exception 'NAME_REQUIRED' using errcode = 'P0001';
  end if;
  if length(v_name) > 24 then
    v_name := left(v_name, 24);
  end if;

  insert into public.rooms(code, use_timers)
  values (public._wg_room_code(), coalesce(p_use_timers, false))
  returning * into v_room;

  insert into public.players(room_id, display_name, token_hash, is_host, seat_order)
  values (v_room.id, v_name, public._wg_token_hash(v_token), true, 1)
  returning * into v_player;

  update public.rooms set host_player_id = v_player.id where id = v_room.id;

  return jsonb_build_object(
    'room_id', v_room.id,
    'code', v_room.code,
    'player_id', v_player.id,
    'token', v_token,
    'display_name', v_player.display_name,
    'is_host', true
  );
end;
$$;

create or replace function public.join_room(p_code text, p_display_name text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token text := encode(extensions.gen_random_bytes(24), 'hex');
  v_room public.rooms;
  v_player public.players;
  v_name text := trim(p_display_name);
  base_name text;
  n int;
  suffix int := 0;
  final_name text;
begin
  if v_name is null or length(v_name) < 1 then
    raise exception 'NAME_REQUIRED' using errcode = 'P0001';
  end if;
  if length(v_name) > 24 then
    v_name := left(v_name, 24);
  end if;

  select * into v_room from public.rooms where code = upper(trim(p_code)) for update;
  if not found then
    raise exception 'ROOM_NOT_FOUND' using errcode = 'P0001';
  end if;
  if v_room.phase <> 'LOBBY' then
    raise exception 'GAME_ALREADY_STARTED' using errcode = 'P0001';
  end if;

  select count(*) into n from public.players where room_id = v_room.id;
  if n >= 12 then
    raise exception 'ROOM_FULL' using errcode = 'P0001';
  end if;

  base_name := v_name;
  final_name := base_name;
  while exists (
    select 1 from public.players where room_id = v_room.id and lower(display_name) = lower(final_name)
  ) loop
    suffix := suffix + 1;
    final_name := left(base_name, 20) || ' ' || suffix::text;
  end loop;

  insert into public.players(room_id, display_name, token_hash, is_host, seat_order)
  values (v_room.id, final_name, public._wg_token_hash(v_token), false, n + 1)
  returning * into v_player;

  update public.rooms set updated_at = now() where id = v_room.id;

  return jsonb_build_object(
    'room_id', v_room.id,
    'code', v_room.code,
    'player_id', v_player.id,
    'token', v_token,
    'display_name', v_player.display_name,
    'is_host', false
  );
end;
$$;

create or replace function public.leave_room(p_room_id uuid, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  me public.players;
  r public.rooms;
  new_host uuid;
begin
  me := public._wg_player(p_room_id, p_token);
  select * into r from public.rooms where id = p_room_id for update;

  if r.phase <> 'LOBBY' then
    raise exception 'CANNOT_LEAVE_IN_GAME' using errcode = 'P0001';
  end if;

  delete from public.players where id = me.id;

  if not exists (select 1 from public.players where room_id = p_room_id) then
    delete from public.rooms where id = p_room_id;
    return jsonb_build_object('ok', true, 'room_deleted', true);
  end if;

  if r.host_player_id = me.id then
    select id into new_host from public.players where room_id = p_room_id order by seat_order limit 1;
    update public.players set is_host = true where id = new_host;
    update public.rooms set host_player_id = new_host, updated_at = now() where id = p_room_id;
  end if;

  return jsonb_build_object('ok', true, 'room_deleted', false);
end;
$$;

create or replace function public.set_room_timers(p_room_id uuid, p_token text, p_use_timers boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  me public.players;
  r public.rooms;
begin
  me := public._wg_player(p_room_id, p_token);
  select * into r from public.rooms where id = p_room_id for update;
  if r.phase <> 'LOBBY' then
    raise exception 'LOBBY_ONLY' using errcode = 'P0001';
  end if;
  if r.host_player_id <> me.id then
    raise exception 'HOST_ONLY' using errcode = 'P0001';
  end if;
  update public.rooms set use_timers = coalesce(p_use_timers, false), updated_at = now() where id = p_room_id;
  return jsonb_build_object('ok', true, 'use_timers', coalesce(p_use_timers, false));
end;
$$;

create or replace function public.start_game(p_room_id uuid, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  me public.players;
  r public.rooms;
  n int;
begin
  me := public._wg_player(p_room_id, p_token);
  select * into r from public.rooms where id = p_room_id for update;
  if r.phase <> 'LOBBY' then
    raise exception 'ALREADY_STARTED' using errcode = 'P0001';
  end if;
  if r.host_player_id <> me.id then
    raise exception 'HOST_ONLY' using errcode = 'P0001';
  end if;
  select count(*) into n from public.players where room_id = p_room_id;
  if n < 3 then
    raise exception 'NEED_3_PLAYERS' using errcode = 'P0001';
  end if;
  if n > 12 then
    raise exception 'TOO_MANY_PLAYERS' using errcode = 'P0001';
  end if;

  perform public._wg_assign_roles(p_room_id);

  update public.rooms set
    night_number = 1,
    day_number = 0,
    wolf_ballot_round = 1,
    wolf_revote_target_ids = '{}',
    exile_ballot_round = 1,
    exile_revote_target_ids = '{}',
    last_deaths = '[]'::jsonb,
    last_announcement = 'Night falls. The town sleeps…',
    straw_results = null,
    winner = null,
    updated_at = now()
  where id = p_room_id;

  perform public._wg_set_phase(p_room_id, 'NIGHT', r.timer_night_sec);
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.submit_night_action(
  p_room_id uuid,
  p_token text,
  p_action_type text,
  p_target_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  me public.players;
  r public.rooms;
  tgt public.players;
begin
  me := public._wg_player(p_room_id, p_token);
  select * into r from public.rooms where id = p_room_id for update;

  if r.phase <> 'NIGHT' then
    raise exception 'NOT_NIGHT' using errcode = 'P0001';
  end if;
  if not me.is_alive then
    raise exception 'DEAD' using errcode = 'P0001';
  end if;

  if p_action_type = 'kill_vote' then
    if me.role <> 'werewolf' then raise exception 'NOT_WOLF' using errcode = 'P0001'; end if;
  elsif p_action_type = 'protect' then
    if me.role <> 'doctor' then raise exception 'NOT_DOCTOR' using errcode = 'P0001'; end if;
  elsif p_action_type = 'peek' then
    if me.role <> 'police' then raise exception 'NOT_POLICE' using errcode = 'P0001'; end if;
  else
    raise exception 'BAD_ACTION' using errcode = 'P0001';
  end if;

  -- Wolves must pick a victim. Doctor/police may skip (null target) so AFK does not soft-lock night.
  if p_action_type = 'kill_vote' and p_target_id is null then
    raise exception 'TARGET_REQUIRED' using errcode = 'P0001';
  end if;

  if p_target_id is not null then
    select * into tgt from public.players where id = p_target_id and room_id = p_room_id;
    if not found or not tgt.is_alive then
      raise exception 'INVALID_TARGET' using errcode = 'P0001';
    end if;

    if p_action_type = 'kill_vote' then
      if tgt.role = 'werewolf' then
        raise exception 'CANNOT_TARGET_ALLY' using errcode = 'P0001';
      end if;
      if r.wolf_ballot_round > 1 and not (p_target_id = any (r.wolf_revote_target_ids)) then
        raise exception 'TARGET_NOT_IN_REVOTE' using errcode = 'P0001';
      end if;
    end if;

    -- police cannot peek self; doctor may self-protect
    if p_action_type = 'peek' and p_target_id = me.id then
      raise exception 'CANNOT_PEEK_SELF' using errcode = 'P0001';
    end if;
  end if;

  insert into public.night_actions(room_id, night_number, player_id, action_type, target_id, ballot_round)
  values (
    p_room_id, r.night_number, me.id, p_action_type, p_target_id,
    case when p_action_type = 'kill_vote' then r.wolf_ballot_round else 1 end
  )
  on conflict (room_id, night_number, player_id, action_type, ballot_round)
  do update set target_id = excluded.target_id, updated_at = now();

  update public.rooms set updated_at = now() where id = p_room_id;
  perform public._wg_maybe_advance(p_room_id);

  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.submit_day_vote(
  p_room_id uuid,
  p_token text,
  p_stage text,
  p_target_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  me public.players;
  r public.rooms;
  tgt public.players;
  v_stage text;
begin
  me := public._wg_player(p_room_id, p_token);
  select * into r from public.rooms where id = p_room_id for update;

  if not me.is_alive then
    raise exception 'DEAD' using errcode = 'P0001';
  end if;

  if p_stage = 'straw' and r.phase = 'DAY_STRAW_VOTE' then
    v_stage := 'straw';
  elsif p_stage = 'exile' and r.phase = 'DAY_EXILE_VOTE' then
    v_stage := 'exile';
  elsif p_stage in ('exile','exile_revote') and r.phase = 'DAY_EXILE_REVOTE' then
    v_stage := 'exile_revote';
  else
    raise exception 'BAD_VOTE_PHASE' using errcode = 'P0001';
  end if;

  if p_target_id is null then
    raise exception 'TARGET_REQUIRED' using errcode = 'P0001';
  end if;

  select * into tgt from public.players where id = p_target_id and room_id = p_room_id;
  if not found or not tgt.is_alive then
    raise exception 'INVALID_TARGET' using errcode = 'P0001';
  end if;

  if v_stage = 'exile_revote' and not (p_target_id = any (r.exile_revote_target_ids)) then
    raise exception 'TARGET_NOT_IN_REVOTE' using errcode = 'P0001';
  end if;

  insert into public.day_votes(room_id, day_number, stage, voter_id, target_id)
  values (p_room_id, r.day_number, v_stage, me.id, p_target_id)
  on conflict (room_id, day_number, stage, voter_id)
  do update set target_id = excluded.target_id, updated_at = now();

  update public.rooms set updated_at = now() where id = p_room_id;
  perform public._wg_maybe_advance(p_room_id);

  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.player_ready(p_room_id uuid, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  me public.players;
  r public.rooms;
begin
  me := public._wg_player(p_room_id, p_token);
  select * into r from public.rooms where id = p_room_id for update;

  if r.phase not in ('DAY_ANNOUNCE','DAY_DEFENSE','DAY_EXECUTE') then
    raise exception 'READY_NOT_APPLICABLE' using errcode = 'P0001';
  end if;
  if not me.is_alive then
    raise exception 'DEAD' using errcode = 'P0001';
  end if;

  insert into public.player_ready_flags(room_id, phase, player_id)
  values (p_room_id, r.phase, me.id)
  on conflict do nothing;

  perform public._wg_maybe_advance(p_room_id);
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.host_advance(p_room_id uuid, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  me public.players;
  r public.rooms;
begin
  me := public._wg_player(p_room_id, p_token);
  select * into r from public.rooms where id = p_room_id for update;

  if r.host_player_id <> me.id then
    raise exception 'HOST_ONLY' using errcode = 'P0001';
  end if;

  if r.phase = 'NIGHT' then
    perform public._wg_resolve_night(p_room_id);
  elsif r.phase = 'DAY_ANNOUNCE' then
    perform public._wg_set_phase(p_room_id, 'DAY_STRAW_VOTE', r.timer_straw_sec);
  elsif r.phase = 'DAY_STRAW_VOTE' then
    perform public._wg_resolve_straw(p_room_id);
  elsif r.phase = 'DAY_DEFENSE' then
    perform public._wg_set_phase(p_room_id, 'DAY_EXILE_VOTE', r.timer_exile_sec);
  elsif r.phase = 'DAY_EXILE_VOTE' then
    perform public._wg_resolve_exile(p_room_id);
  elsif r.phase = 'DAY_EXILE_REVOTE' then
    perform public._wg_resolve_exile(p_room_id);
  elsif r.phase = 'DAY_EXECUTE' then
    if public._wg_check_win(p_room_id) is null then
      update public.rooms set night_number = night_number + 1, updated_at = now() where id = p_room_id;
      perform public._wg_set_phase(p_room_id, 'NIGHT', r.timer_night_sec);
    end if;
  else
    raise exception 'CANNOT_ADVANCE' using errcode = 'P0001';
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.play_again(p_room_id uuid, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  me public.players;
  r public.rooms;
begin
  me := public._wg_player(p_room_id, p_token);
  select * into r from public.rooms where id = p_room_id for update;
  if r.host_player_id <> me.id then
    raise exception 'HOST_ONLY' using errcode = 'P0001';
  end if;
  -- Host may restart mid-game or after ENDED (not only when the match finished).
  if r.phase = 'LOBBY' then
    return jsonb_build_object('ok', true, 'already_lobby', true);
  end if;

  delete from public.night_actions where room_id = p_room_id;
  delete from public.day_votes where room_id = p_room_id;
  delete from public.peeks where room_id = p_room_id;
  delete from public.player_ready_flags where room_id = p_room_id;

  update public.players set role = null, is_alive = true where room_id = p_room_id;

  update public.rooms set
    phase = 'LOBBY',
    phase_ends_at = null,
    night_number = 0,
    day_number = 0,
    wolf_ballot_round = 1,
    wolf_revote_target_ids = '{}',
    exile_ballot_round = 1,
    exile_revote_target_ids = '{}',
    last_deaths = '[]'::jsonb,
    last_announcement = null,
    straw_results = null,
    winner = null,
    updated_at = now()
  where id = p_room_id;

  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.tick_room(p_room_id uuid, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  me public.players;
begin
  me := public._wg_player(p_room_id, p_token);
  update public.players set last_seen_at = now() where id = me.id;
  perform public._wg_maybe_advance(p_room_id);
  return public.get_room_state(p_room_id, p_token);
end;
$$;

create or replace function public.get_room_state(p_room_id uuid, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  me public.players;
  r public.rooms;
  players_json jsonb;
  private_json jsonb := '{}'::jsonb;
  wolf_allies jsonb := '[]'::jsonb;
  wolf_votes jsonb := '[]'::jsonb;
  my_night jsonb := '{}'::jsonb;
  my_day_vote uuid;
  peek_json jsonb;
  v_stage text;
  ready_count int;
  living int;
  host_status jsonb;
  wolves_living int;
  wolves_voted int;
  doctor_living int;
  doctor_acted int;
  police_living int;
  police_acted int;
  votes_cast int;
  blocking text[] := '{}';
begin
  me := public._wg_player(p_room_id, p_token);
  select * into r from public.rooms where id = p_room_id;
  if not found then
    raise exception 'ROOM_NOT_FOUND' using errcode = 'P0001';
  end if;

  update public.players set last_seen_at = now() where id = me.id;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', p.id,
      'display_name', p.display_name,
      'is_alive', p.is_alive,
      'is_host', p.is_host,
      'seat_order', p.seat_order,
      'role', case
        when r.phase = 'ENDED' then p.role
        when not p.is_alive and p.role is not null then p.role
        else null
      end
    ) order by p.seat_order, p.created_at
  ), '[]'::jsonb)
  into players_json
  from public.players p
  where p.room_id = p_room_id;

  -- private: own role
  private_json := private_json || jsonb_build_object(
    'player_id', me.id,
    'display_name', me.display_name,
    'role', me.role,
    'is_alive', me.is_alive,
    'is_host', me.is_host
  );

  if me.role = 'werewolf' and me.is_alive then
    select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'display_name', p.display_name) order by p.seat_order), '[]'::jsonb)
    into wolf_allies
    from public.players p
    where p.room_id = p_room_id and p.role = 'werewolf' and p.is_alive and p.id <> me.id;

    select coalesce(jsonb_agg(jsonb_build_object(
      'voter_id', na.player_id,
      'voter_name', p.display_name,
      'target_id', na.target_id,
      'target_name', t.display_name
    )), '[]'::jsonb)
    into wolf_votes
    from public.night_actions na
    join public.players p on p.id = na.player_id
    left join public.players t on t.id = na.target_id
    where na.room_id = p_room_id
      and na.night_number = r.night_number
      and na.action_type = 'kill_vote'
      and na.ballot_round = r.wolf_ballot_round
      and r.phase = 'NIGHT';

    private_json := private_json || jsonb_build_object(
      'wolf_allies', wolf_allies,
      'wolf_votes', wolf_votes,
      'wolf_revote_targets', r.wolf_revote_target_ids
    );
  end if;

  if me.role = 'police' then
    select jsonb_build_object(
      'night_number', pk.night_number,
      'target_id', pk.target_id,
      'target_name', t.display_name,
      'result', case when pk.is_wolf then 'Wolf' else 'Not wolf' end
    )
    into peek_json
    from public.peeks pk
    join public.players t on t.id = pk.target_id
    where pk.room_id = p_room_id and pk.police_id = me.id
    order by pk.night_number desc
    limit 1;
    private_json := private_json || jsonb_build_object('last_peek', peek_json);
  end if;

  -- my submitted actions this phase
  if r.phase = 'NIGHT' and me.is_alive then
    select jsonb_object_agg(na.action_type, na.target_id) into my_night
    from public.night_actions na
    where na.room_id = p_room_id and na.night_number = r.night_number and na.player_id = me.id
      and (na.action_type <> 'kill_vote' or na.ballot_round = r.wolf_ballot_round);
    private_json := private_json || jsonb_build_object('my_night_actions', coalesce(my_night, '{}'::jsonb));
  end if;

  if r.phase = 'DAY_STRAW_VOTE' then v_stage := 'straw';
  elsif r.phase = 'DAY_EXILE_VOTE' then v_stage := 'exile';
  elsif r.phase = 'DAY_EXILE_REVOTE' then v_stage := 'exile_revote';
  else v_stage := null;
  end if;

  if v_stage is not null then
    select dv.target_id into my_day_vote
    from public.day_votes dv
    where dv.room_id = p_room_id
      and dv.day_number = r.day_number
      and dv.stage = v_stage
      and dv.voter_id = me.id;
    private_json := private_json || jsonb_build_object('my_day_vote', my_day_vote);
  end if;

  select count(*) into ready_count from public.player_ready_flags where room_id = p_room_id and phase = r.phase;
  select count(*) into living from public.players where room_id = p_room_id and is_alive;

  private_json := private_json || jsonb_build_object(
    'i_am_ready', exists (
      select 1 from public.player_ready_flags where room_id = p_room_id and phase = r.phase and player_id = me.id
    )
  );

  -- Host-only progress (role counts only — never names night identities)
  if me.is_host and r.phase not in ('LOBBY', 'ENDED') then
    host_status := jsonb_build_object('phase', r.phase);

    if r.phase = 'NIGHT' then
      select count(*) into wolves_living from public.players where room_id = p_room_id and is_alive and role = 'werewolf';
      select count(*) into wolves_voted
      from public.night_actions na
      join public.players p on p.id = na.player_id
      where na.room_id = p_room_id and na.night_number = r.night_number
        and na.action_type = 'kill_vote' and na.ballot_round = r.wolf_ballot_round
        and p.role = 'werewolf' and p.is_alive and na.target_id is not null;

      select count(*) into doctor_living from public.players where room_id = p_room_id and is_alive and role = 'doctor';
      select count(*) into doctor_acted
      from public.night_actions na
      join public.players p on p.id = na.player_id
      where na.room_id = p_room_id and na.night_number = r.night_number
        and na.action_type = 'protect' and p.role = 'doctor' and p.is_alive;

      select count(*) into police_living from public.players where room_id = p_room_id and is_alive and role = 'police';
      select count(*) into police_acted
      from public.night_actions na
      join public.players p on p.id = na.player_id
      where na.room_id = p_room_id and na.night_number = r.night_number
        and na.action_type = 'peek' and p.role = 'police' and p.is_alive;

      blocking := '{}';
      if wolves_living > 0 and wolves_voted < wolves_living then
        blocking := blocking || array['wolves'];
      end if;
      if r.wolf_ballot_round = 1 then
        if doctor_living > 0 and doctor_acted < doctor_living then
          blocking := blocking || array['doctor'];
        end if;
        if police_living > 0 and police_acted < police_living then
          blocking := blocking || array['police'];
        end if;
      end if;

      host_status := host_status || jsonb_build_object(
        'night', jsonb_build_object(
          'wolves_living', wolves_living,
          'wolves_voted', wolves_voted,
          'doctor_living', doctor_living,
          'doctor_acted', doctor_acted,
          'police_living', police_living,
          'police_acted', police_acted,
          'wolf_ballot_round', r.wolf_ballot_round,
          'blocking', to_jsonb(blocking)
        )
      );
    elsif r.phase in ('DAY_STRAW_VOTE', 'DAY_EXILE_VOTE', 'DAY_EXILE_REVOTE') then
      if r.phase = 'DAY_STRAW_VOTE' then v_stage := 'straw';
      elsif r.phase = 'DAY_EXILE_VOTE' then v_stage := 'exile';
      else v_stage := 'exile_revote';
      end if;
      select count(*) into votes_cast from public.day_votes
      where room_id = p_room_id and day_number = r.day_number and stage = v_stage and target_id is not null;
      host_status := host_status || jsonb_build_object(
        'votes', jsonb_build_object(
          'cast', votes_cast,
          'needed', living,
          'stage', v_stage
        )
      );
    elsif r.phase in ('DAY_ANNOUNCE', 'DAY_DEFENSE', 'DAY_EXECUTE') then
      host_status := host_status || jsonb_build_object(
        'ready', jsonb_build_object(
          'ready_count', ready_count,
          'needed', living
        )
      );
    end if;

    private_json := private_json || jsonb_build_object('host_status', host_status);
  end if;

  return jsonb_build_object(
    'room', jsonb_build_object(
      'id', r.id,
      'code', r.code,
      'phase', r.phase,
      'host_player_id', r.host_player_id,
      'use_timers', r.use_timers,
      'phase_ends_at', r.phase_ends_at,
      'night_number', r.night_number,
      'day_number', r.day_number,
      'wolf_ballot_round', r.wolf_ballot_round,
      'wolf_revote_target_ids', r.wolf_revote_target_ids,
      'exile_ballot_round', r.exile_ballot_round,
      'exile_revote_target_ids', r.exile_revote_target_ids,
      'last_deaths', r.last_deaths,
      'last_announcement', r.last_announcement,
      'straw_results', r.straw_results,
      'winner', r.winner,
      'player_count', (select count(*) from public.players where room_id = p_room_id),
      'living_count', living,
      'ready_count', ready_count
    ),
    'players', players_json,
    'you', private_json,
    'server_time', now()
  );
end;
$$;

-- Grants: anon + authenticated can execute RPCs only
grant usage on schema public to anon, authenticated;
grant execute on function public.create_room(text, boolean) to anon, authenticated;
grant execute on function public.join_room(text, text) to anon, authenticated;
grant execute on function public.leave_room(uuid, text) to anon, authenticated;
grant execute on function public.set_room_timers(uuid, text, boolean) to anon, authenticated;
grant execute on function public.start_game(uuid, text) to anon, authenticated;
grant execute on function public.submit_night_action(uuid, text, text, uuid) to anon, authenticated;
grant execute on function public.submit_day_vote(uuid, text, text, uuid) to anon, authenticated;
grant execute on function public.player_ready(uuid, text) to anon, authenticated;
grant execute on function public.host_advance(uuid, text) to anon, authenticated;
grant execute on function public.play_again(uuid, text) to anon, authenticated;
grant execute on function public.tick_room(uuid, text) to anon, authenticated;
grant execute on function public.get_room_state(uuid, text) to anon, authenticated;

-- Done
notify pgrst, 'reload schema';
