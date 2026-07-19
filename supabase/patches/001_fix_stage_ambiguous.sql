-- Hotfix: ambiguous stage column vs variable
-- Paste into Supabase SQL Editor
--
-- SAFE FOR IN-PROGRESS GAMES:
--   CREATE OR REPLACE FUNCTION only — does NOT drop tables, rooms, or tokens.
--   After Run, refresh the app (or wait ~1.5s poll). Same room code + seats continue.
--   You do NOT need to start a new game.

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
    where p.room_id = p_room_id and p.role = 'werewolf' and p.id <> me.id;

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

notify pgrst, 'reload schema';
