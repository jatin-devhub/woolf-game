-- Hotfix: host status board, mid-game restart, doctor/police night skip
-- Paste into Supabase SQL Editor
--
-- SAFE FOR IN-PROGRESS GAMES:
--   CREATE OR REPLACE FUNCTION only — does NOT drop tables, rooms, or tokens.
--   After Run, refresh clients. Same room code + seats continue.
--
-- Changes:
--   1) play_again works mid-game (not only ENDED) → reset to LOBBY
--   2) get_room_state: host-only host_status (wolves/doctor/police progress)
--   3) submit_night_action: doctor/police may skip with null target

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

notify pgrst, 'reload schema';
