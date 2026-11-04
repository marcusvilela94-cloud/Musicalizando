-- =====================================================================
-- Musicalizando — 003: funções RPC públicas (security definer)
-- Toda escrita passa por aqui. Cada função trava a linha da sala
-- (SELECT ... FOR UPDATE), então chamadas simultâneas na mesma sala
-- são serializadas: dois toques quase juntos nunca geram duas vezes.
-- =====================================================================

-- Sorteio de modo por rodada (fase 2). Hoje: sempre o modo fixo.
create or replace function public.npl_pick_mode(p_settings jsonb)
returns text
language plpgsql volatile
set search_path = public
as $$
begin
  if p_settings->>'modeSelection' = 'random' and jsonb_array_length(p_settings->'modePool') > 0 then
    return p_settings->'modePool'->>(floor(random() * jsonb_array_length(p_settings->'modePool')))::int;
  end if;
  return coalesce(p_settings->>'mode', 'classic');
end $$;
revoke execute on function public.npl_pick_mode(jsonb) from public, anon, authenticated;

create or replace function public.npl_player_json(p public.npl_players)
returns jsonb
language sql immutable
set search_path = public
as $$ select to_jsonb(p) - 'token_hash' $$;

-- ---------------------------------------------------------------------
-- Leitura: estado completo da sala para quem tem o código
-- ---------------------------------------------------------------------
create or replace function public.npl_get_state(p_code text)
returns jsonb
language plpgsql stable
security definer
set search_path = public
as $$
declare
  r public.npl_rooms;
begin
  select * into r from public.npl_rooms where code = btrim(p_code);
  if not found then return null; end if;
  return jsonb_build_object(
    'server_now', floor(extract(epoch from clock_timestamp()) * 1000)::bigint,
    'room', to_jsonb(r) - 'owner_hash',
    'teams', coalesce((select jsonb_agg(to_jsonb(t) order by t.idx) from public.npl_teams t where t.room_id = r.id), '[]'::jsonb),
    'players', coalesce((select jsonb_agg(public.npl_player_json(p) order by p.joined_at) from public.npl_players p where p.room_id = r.id), '[]'::jsonb),
    'rounds', coalesce((select jsonb_agg(to_jsonb(x) order by x.round_no) from public.npl_rounds x
                         where x.room_id = r.id and x.match_no = r.match_no), '[]'::jsonb),
    'attempts', coalesce((select jsonb_agg(to_jsonb(a) order by a.created_at) from public.npl_attempts a
                           join public.npl_rounds x on x.id = a.round_id
                          where a.room_id = r.id and x.match_no = r.match_no), '[]'::jsonb)
  );
end $$;

create or replace function public.npl_is_owner(p_code text, p_owner_token text)
returns boolean
language sql stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.npl_rooms
                  where code = btrim(p_code) and owner_hash = public.npl_hash(p_owner_token))
$$;

-- ---------------------------------------------------------------------
-- Sala
-- ---------------------------------------------------------------------
create or replace function public.npl_create_room(p_owner_token text, p_settings jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
  v_room public.npl_rooms;
  v_tries int := 0;
begin
  if length(coalesce(p_owner_token, '')) < 16 then raise exception 'npl:bad_token'; end if;

  -- limpeza: salas sem atividade há 6 horas (apenas tabelas npl_, em cascata)
  delete from public.npl_rooms where last_activity_at < now() - interval '6 hours';

  if (select count(*) from public.npl_rooms) >= 500 then raise exception 'npl:too_many_rooms'; end if;

  loop
    v_code := lpad(floor(random() * 10000)::int::text, 4, '0');
    exit when not exists (select 1 from public.npl_rooms where code = v_code);
    v_tries := v_tries + 1;
    if v_tries > 500 then raise exception 'npl:no_codes'; end if;
  end loop;

  insert into public.npl_rooms (code, owner_hash, settings)
  values (v_code, public.npl_hash(p_owner_token), public.npl_clean_settings(p_settings))
  returning * into v_room;

  perform public.npl_apply_team_layout(v_room.id);
  return jsonb_build_object('room_id', v_room.id, 'code', v_room.code);
end $$;

create or replace function public.npl_update_settings(p_code text, p_owner_token text, p_settings jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.npl_rooms := public.npl_lock_room(p_code);
  v_new jsonb;
begin
  perform public.npl_require_owner(v_room, p_owner_token);
  if v_room.phase = 'playing' then raise exception 'npl:match_running'; end if;
  v_new := public.npl_clean_settings(v_room.settings || coalesce(p_settings, '{}'::jsonb));
  update public.npl_rooms set settings = v_new where id = v_room.id;
  if v_new->>'teamMode' is distinct from v_room.settings->>'teamMode'
     or v_new->>'teamCount' is distinct from v_room.settings->>'teamCount' then
    perform public.npl_apply_team_layout(v_room.id);
  end if;
  perform public.npl_touch(v_room.id, 'settings');
  return v_new;
end $$;

create or replace function public.npl_set_phase(p_code text, p_owner_token text, p_phase text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_room public.npl_rooms := public.npl_lock_room(p_code);
begin
  perform public.npl_require_owner(v_room, p_owner_token);
  if p_phase not in ('config', 'lobby') then raise exception 'npl:bad_phase'; end if;
  if v_room.phase = 'playing' then raise exception 'npl:match_running'; end if;
  update public.npl_rooms set phase = p_phase where id = v_room.id;
  perform public.npl_touch(v_room.id, 'phase');
end $$;

-- ---------------------------------------------------------------------
-- Jogadores e times
-- ---------------------------------------------------------------------
create or replace function public.npl_join(p_code text, p_token text, p_nickname text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.npl_rooms := public.npl_lock_room(p_code);
  v_nick text := left(btrim(regexp_replace(coalesce(p_nickname, ''), '\s+', ' ', 'g')), 20);
  v_player public.npl_players;
  v_team public.npl_teams;
begin
  if length(coalesce(p_token, '')) < 16 then raise exception 'npl:bad_token'; end if;

  select * into v_player from public.npl_players
   where room_id = v_room.id and token_hash = public.npl_hash(p_token);
  if found then
    -- reconexão: mesmo time, mesmos pontos
    if v_nick <> '' and v_nick <> v_player.nickname then
      update public.npl_players set nickname = v_nick where id = v_player.id returning * into v_player;
      perform public.npl_touch(v_room.id, 'join');
    end if;
    return public.npl_player_json(v_player);
  end if;

  if v_nick = '' then raise exception 'npl:nickname_required'; end if;
  if (select count(*) from public.npl_players where room_id = v_room.id) >= 40 then
    raise exception 'npl:room_full';
  end if;

  insert into public.npl_players (room_id, token_hash, nickname, active_from_round)
  values (v_room.id, public.npl_hash(p_token), v_nick,
          case when v_room.phase = 'playing' then v_room.round_no + 1 else 0 end)
  returning * into v_player;

  if v_room.settings->>'teamMode' = 'solo' then
    v_team := public.npl_add_team(v_room.id, v_nick);
    update public.npl_players set team_id = v_team.id where id = v_player.id returning * into v_player;
  end if;

  perform public.npl_touch(v_room.id, 'join');
  return public.npl_player_json(v_player);
end $$;

create or replace function public.npl_set_team(p_code text, p_token text, p_team_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.npl_rooms := public.npl_lock_room(p_code);
  v_player public.npl_players := public.npl_player_by_token(v_room.id, p_token);
begin
  if not exists (select 1 from public.npl_teams where id = p_team_id and room_id = v_room.id) then
    raise exception 'npl:team_not_found';
  end if;
  if v_room.settings->>'teamMode' = 'solo' then raise exception 'npl:solo_mode'; end if;
  if v_room.phase = 'playing' then
    -- no meio da partida só escolhe quem ainda não tem time; joga a partir da próxima rodada
    if v_player.team_id is not null then raise exception 'npl:team_locked'; end if;
    update public.npl_players set team_id = p_team_id, active_from_round = v_room.round_no + 1
     where id = v_player.id returning * into v_player;
  else
    update public.npl_players set team_id = p_team_id where id = v_player.id returning * into v_player;
  end if;
  perform public.npl_touch(v_room.id, 'team');
  return public.npl_player_json(v_player);
end $$;

create or replace function public.npl_rename_team(p_code text, p_token text, p_team_id uuid, p_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.npl_rooms := public.npl_lock_room(p_code);
  v_name text := left(btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')), 24);
begin
  if v_name = '' then raise exception 'npl:name_required'; end if;
  if v_room.owner_hash <> public.npl_hash(p_token) and not exists (
       select 1 from public.npl_players
        where room_id = v_room.id and token_hash = public.npl_hash(p_token) and team_id = p_team_id) then
    raise exception 'npl:not_allowed';
  end if;
  update public.npl_teams set name = v_name where id = p_team_id and room_id = v_room.id;
  perform public.npl_touch(v_room.id, 'team');
end $$;

create or replace function public.npl_shuffle_teams(p_code text, p_owner_token text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.npl_rooms := public.npl_lock_room(p_code);
  v_teams uuid[];
  v_n int;
  v_i int := 0;
  v_pid uuid;
begin
  perform public.npl_require_owner(v_room, p_owner_token);
  if v_room.phase = 'playing' then raise exception 'npl:match_running'; end if;
  if v_room.settings->>'teamMode' = 'solo' then return; end if;
  perform public.npl_apply_team_layout(v_room.id);
  select array_agg(id order by idx) into v_teams from public.npl_teams where room_id = v_room.id;
  v_n := coalesce(array_length(v_teams, 1), 0);
  if v_n = 0 then return; end if;
  -- ordem aleatória + distribuição circular = times com tamanhos que diferem no máximo em 1
  for v_pid in select id from public.npl_players where room_id = v_room.id order by random() loop
    update public.npl_players set team_id = v_teams[(v_i % v_n) + 1] where id = v_pid;
    v_i := v_i + 1;
  end loop;
  perform public.npl_touch(v_room.id, 'team');
end $$;

create or replace function public.npl_move_player(p_code text, p_owner_token text, p_player_id uuid, p_team_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_room public.npl_rooms := public.npl_lock_room(p_code);
begin
  perform public.npl_require_owner(v_room, p_owner_token);
  if p_team_id is not null and not exists (select 1 from public.npl_teams where id = p_team_id and room_id = v_room.id) then
    raise exception 'npl:team_not_found';
  end if;
  update public.npl_players set team_id = p_team_id where id = p_player_id and room_id = v_room.id;
  perform public.npl_touch(v_room.id, 'team');
end $$;

create or replace function public.npl_remove_player(p_code text, p_owner_token text, p_player_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.npl_rooms := public.npl_lock_room(p_code);
  v_team uuid;
begin
  perform public.npl_require_owner(v_room, p_owner_token);
  delete from public.npl_players where id = p_player_id and room_id = v_room.id returning team_id into v_team;
  if v_room.settings->>'teamMode' = 'solo' and v_room.phase <> 'playing' and v_team is not null then
    delete from public.npl_teams t where t.id = v_team
       and not exists (select 1 from public.npl_players p where p.team_id = t.id);
  end if;
  perform public.npl_touch(v_room.id, 'team');
end $$;

create or replace function public.npl_rematch_vote(p_code text, p_token text, p_value boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.npl_rooms := public.npl_lock_room(p_code);
  v_player public.npl_players := public.npl_player_by_token(v_room.id, p_token);
begin
  update public.npl_players set wants_rematch = coalesce(p_value, true) where id = v_player.id;
  perform public.npl_touch(v_room.id, 'rematch');
end $$;

-- ---------------------------------------------------------------------
-- Partida
-- ---------------------------------------------------------------------
-- p_tracks: [{deezer_id, title, title_short, artist, artists[], cover, album}]
create or replace function public.npl_start_match(p_code text, p_owner_token text, p_tracks jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.npl_rooms := public.npl_lock_room(p_code);
  v_match int;
  v_count int;
  v_pid uuid;
  v_tid uuid;
begin
  perform public.npl_require_owner(v_room, p_owner_token);
  if v_room.phase = 'playing' then raise exception 'npl:match_running'; end if;
  if jsonb_typeof(p_tracks) <> 'array' or jsonb_array_length(p_tracks) < 1 then
    raise exception 'npl:no_tracks';
  end if;

  -- quem está sem time vai para o time com menos gente
  for v_pid in select id from public.npl_players where room_id = v_room.id and team_id is null order by joined_at loop
    select t.id into v_tid from public.npl_teams t
     where t.room_id = v_room.id
     order by (select count(*) from public.npl_players p where p.team_id = t.id), t.idx
     limit 1;
    if v_tid is null then
      v_tid := (public.npl_add_team(v_room.id, null)).id;
    end if;
    update public.npl_players set team_id = v_tid where id = v_pid;
  end loop;

  -- times vazios não entram na partida
  delete from public.npl_teams t
   where t.room_id = v_room.id
     and not exists (select 1 from public.npl_players p where p.team_id = t.id);
  if (select count(*) from public.npl_teams where room_id = v_room.id) < 2 then
    raise exception 'npl:need_two_teams';
  end if;

  v_match := v_room.match_no + 1;
  delete from public.npl_tracks where room_id = v_room.id;
  delete from public.npl_rounds where room_id = v_room.id;          -- tentativas saem em cascata
  delete from public.npl_score_adjustments where room_id = v_room.id;

  insert into public.npl_tracks (room_id, match_no, position, deezer_id, title, title_short, artist, artists, cover, album)
  select v_room.id, v_match, n::int,
         (e->>'deezer_id')::bigint,
         left(coalesce(e->>'title', '?'), 300),
         left(e->>'title_short', 300),
         left(coalesce(e->>'artist', '?'), 300),
         case when jsonb_typeof(e->'artists') = 'array' then e->'artists'
              else jsonb_build_array(coalesce(e->>'artist', '?')) end,
         left(e->>'cover', 500),
         left(e->>'album', 300)
    from jsonb_array_elements(p_tracks) with ordinality as x(e, n)
   where n <= 30;
  get diagnostics v_count = row_count;

  update public.npl_players set active_from_round = 0, wants_rematch = false where room_id = v_room.id;
  update public.npl_rooms
     set match_no = v_match, round_no = 1, total_rounds = v_count,
         phase = 'playing', paused = false, paused_at = null
   where id = v_room.id;
  insert into public.npl_rounds (room_id, match_no, round_no, mode)
  values (v_room.id, v_match, 1, public.npl_pick_mode(v_room.settings));

  perform public.npl_recalc_scores(v_room.id);
  perform public.npl_touch(v_room.id, 'start');
  return jsonb_build_object('match_no', v_match, 'total_rounds', v_count);
end $$;

-- IDs Deezer da rodada atual e da próxima (só o dono; a tela principal busca a prévia)
create or replace function public.npl_host_tracks(p_code text, p_owner_token text)
returns jsonb
language plpgsql stable
security definer
set search_path = public
as $$
declare r public.npl_rooms;
begin
  select * into r from public.npl_rooms where code = btrim(p_code);
  if not found then raise exception 'npl:room_not_found'; end if;
  perform public.npl_require_owner(r, p_owner_token);
  return coalesce((
    select jsonb_agg(jsonb_build_object('round_no', t.position, 'deezer_id', t.deezer_id) order by t.position)
      from public.npl_tracks t
     where t.room_id = r.id and t.match_no = r.match_no
       and t.position between r.round_no and r.round_no + 1), '[]'::jsonb);
end $$;

-- A tela principal carregou o áudio: abre a rodada (estágio 1).
-- p_artists: lista de artistas da faixa (principal + participações) vinda do Deezer.
create or replace function public.npl_round_begin(p_code text, p_owner_token text, p_round_id uuid, p_artists jsonb default '[]'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.npl_rooms := public.npl_lock_room(p_code);
  v_round public.npl_rounds;
begin
  perform public.npl_require_owner(v_room, p_owner_token);
  select * into v_round from public.npl_rounds where id = p_round_id and room_id = v_room.id for update;
  if not found then raise exception 'npl:round_not_found'; end if;
  if v_round.status <> 'loading' then return to_jsonb(v_round); end if;

  if jsonb_typeof(p_artists) = 'array' and jsonb_array_length(p_artists) > 0 then
    update public.npl_tracks t
       set artists = (select coalesce(jsonb_agg(distinct v), '[]'::jsonb) from (
                        select jsonb_array_elements_text(t.artists) as v
                        union
                        select left(jsonb_array_elements_text(p_artists), 300)) q
                       where btrim(v) <> '')
     where t.room_id = v_room.id and t.match_no = v_round.match_no and t.position = v_round.round_no;
  end if;

  update public.npl_rounds
     set status = 'playing', stage = 1, stage_started_at = clock_timestamp(), started_at = now()
   where id = v_round.id
  returning * into v_round;
  perform public.npl_touch(v_room.id, 'round');
  return to_jsonb(v_round);
end $$;

-- Relógio da rodada: a tela principal avança o estágio ao fim de cada trecho.
create or replace function public.npl_advance_stage(p_code text, p_owner_token text, p_round_id uuid, p_from_stage int)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.npl_rooms := public.npl_lock_room(p_code);
  v_round public.npl_rounds;
begin
  perform public.npl_require_owner(v_room, p_owner_token);
  select * into v_round from public.npl_rounds where id = p_round_id and room_id = v_room.id for update;
  if not found or v_round.status <> 'playing' or v_round.stage <> p_from_stage or v_room.paused then
    return jsonb_build_object('ok', false, 'round', to_jsonb(v_round));
  end if;
  if v_round.stage < public.npl_stage_count(v_round.mode) then
    update public.npl_rounds set stage = stage + 1, stage_started_at = clock_timestamp()
     where id = v_round.id returning * into v_round;
    perform public.npl_touch(v_room.id, 'stage');
  else
    -- ninguém acertou até o último estágio: revela sem pontos
    perform public.npl_reveal_round(v_round.id, false);
    perform public.npl_touch(v_room.id, 'reveal');
    select * into v_round from public.npl_rounds where id = p_round_id;
  end if;
  return jsonb_build_object('ok', true, 'round', to_jsonb(v_round));
end $$;

create or replace function public.npl_skip_round(p_code text, p_owner_token text, p_round_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.npl_rooms := public.npl_lock_room(p_code);
  v_round public.npl_rounds;
begin
  perform public.npl_require_owner(v_room, p_owner_token);
  select * into v_round from public.npl_rounds where id = p_round_id and room_id = v_room.id for update;
  if not found or v_round.status in ('revealed', 'scoreboard') then return; end if;
  update public.npl_attempts set status = 'cancelled', points = 0, decided_at = now()
   where round_id = v_round.id and status in ('open', 'doubt');
  perform public.npl_reveal_round(v_round.id, true);
  perform public.npl_recalc_scores(v_room.id);
  perform public.npl_touch(v_room.id, 'reveal');
end $$;

create or replace function public.npl_show_scoreboard(p_code text, p_owner_token text, p_round_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_room public.npl_rooms := public.npl_lock_room(p_code);
begin
  perform public.npl_require_owner(v_room, p_owner_token);
  update public.npl_rounds set status = 'scoreboard'
   where id = p_round_id and room_id = v_room.id and status = 'revealed';
  if found then perform public.npl_touch(v_room.id, 'scoreboard'); end if;
end $$;

-- p_from_round evita avanço duplo (tela e celular do dono apertando juntos)
create or replace function public.npl_next_round(p_code text, p_owner_token text, p_from_round int)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.npl_rooms := public.npl_lock_room(p_code);
  v_round public.npl_rounds;
begin
  perform public.npl_require_owner(v_room, p_owner_token);
  if v_room.phase <> 'playing' or v_room.round_no <> p_from_round then return; end if;
  select * into v_round from public.npl_rounds
   where room_id = v_room.id and match_no = v_room.match_no and round_no = v_room.round_no;
  if found and v_round.status not in ('revealed', 'scoreboard') then return; end if;
  if v_room.round_no >= v_room.total_rounds then
    update public.npl_rooms set phase = 'finished', paused = false where id = v_room.id;
    perform public.npl_touch(v_room.id, 'finished');
    return;
  end if;
  update public.npl_rooms set round_no = round_no + 1 where id = v_room.id;
  insert into public.npl_rounds (room_id, match_no, round_no, mode)
  values (v_room.id, v_room.match_no, v_room.round_no + 1, public.npl_pick_mode(v_room.settings));
  perform public.npl_touch(v_room.id, 'next');
end $$;

create or replace function public.npl_finish_match(p_code text, p_owner_token text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_room public.npl_rooms := public.npl_lock_room(p_code);
begin
  perform public.npl_require_owner(v_room, p_owner_token);
  if v_room.phase <> 'playing' then return; end if;
  update public.npl_attempts set status = 'cancelled', points = 0
   where room_id = v_room.id and status in ('open', 'doubt');
  update public.npl_rounds set status = 'revealed', current_attempt_id = null
   where room_id = v_room.id and status in ('answering', 'doubt');
  update public.npl_rooms set phase = 'finished', paused = false where id = v_room.id;
  perform public.npl_recalc_scores(v_room.id);
  perform public.npl_touch(v_room.id, 'finished');
end $$;

create or replace function public.npl_pause(p_code text, p_owner_token text, p_paused boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_room public.npl_rooms := public.npl_lock_room(p_code);
begin
  perform public.npl_require_owner(v_room, p_owner_token);
  if p_paused and not v_room.paused then
    update public.npl_rooms set paused = true, paused_at = clock_timestamp() where id = v_room.id;
  elsif not p_paused and v_room.paused then
    -- o tempo de resposta não corre durante a pausa
    update public.npl_attempts a
       set deadline = a.deadline + (clock_timestamp() - v_room.paused_at)
     where a.room_id = v_room.id and a.status = 'open' and a.deadline is not null;
    update public.npl_rooms set paused = false, paused_at = null where id = v_room.id;
  else
    return;
  end if;
  perform public.npl_touch(v_room.id, 'pause');
end $$;

-- ---------------------------------------------------------------------
-- O botão "EU SEI!" — decisão atômica de quem apertou primeiro
-- ---------------------------------------------------------------------
create or replace function public.npl_buzz(p_code text, p_token text, p_round_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.npl_rooms := public.npl_lock_room(p_code);   -- trava a sala: toques entram em fila
  v_player public.npl_players := public.npl_player_by_token(v_room.id, p_token);
  v_round public.npl_rounds;
  v_att public.npl_attempts;
  v_now timestamptz;
  v_secs int;
  v_expired boolean;
begin
  if v_player.team_id is null then return jsonb_build_object('ok', false, 'reason', 'no_team'); end if;

  v_expired := public.npl_expire_overdue(v_room);

  select * into v_round from public.npl_rounds
   where id = p_round_id and room_id = v_room.id and match_no = v_room.match_no and round_no = v_room.round_no
   for update;
  if not found then
    if v_expired then perform public.npl_touch(v_room.id, 'timeout'); end if;
    return jsonb_build_object('ok', false, 'reason', 'closed');
  end if;
  if v_player.active_from_round > v_round.round_no then
    if v_expired then perform public.npl_touch(v_room.id, 'timeout'); end if;
    return jsonb_build_object('ok', false, 'reason', 'not_yet');
  end if;

  v_now := clock_timestamp();

  -- (a) já existe tentativa em andamento: registra o toque atrasado (para mostrar a ordem)
  if v_round.status in ('answering', 'doubt') then
    select * into v_att from public.npl_attempts where id = v_round.current_attempt_id;
    if v_att.team_id = v_player.team_id then
      return jsonb_build_object('ok', false, 'reason', 'own_turn');
    end if;
    if v_now - v_att.created_at < interval '10 seconds' and not exists (
         select 1 from public.npl_attempts
          where parent_id = v_att.id and team_id = v_player.team_id) then
      insert into public.npl_attempts (room_id, round_id, team_id, player_id, kind, parent_id, status, created_at, stage)
      values (v_room.id, v_round.id, v_player.team_id, v_player.id, 'late', v_att.id, 'late', v_now, v_round.stage);
      perform public.npl_touch(v_room.id, 'late');
    end if;
    return jsonb_build_object('ok', false, 'reason', 'taken', 'team_id', v_att.team_id,
      'behind_ms', floor(extract(epoch from (v_now - v_att.created_at)) * 1000)::int);
  end if;

  -- (c) rodada precisa estar aberta
  if v_round.status <> 'playing' then
    if v_expired then perform public.npl_touch(v_room.id, 'timeout'); end if;
    return jsonb_build_object('ok', false, 'reason', 'closed');
  end if;
  if v_room.paused then return jsonb_build_object('ok', false, 'reason', 'paused'); end if;

  -- (b) time bloqueado (o último que errou)
  if v_round.locked_team_id = v_player.team_id then
    if v_expired then perform public.npl_touch(v_room.id, 'timeout'); end if;
    return jsonb_build_object('ok', false, 'reason', 'locked');
  end if;

  v_secs := coalesce((v_room.settings->>'answerSeconds')::int, 20);
  insert into public.npl_attempts (room_id, round_id, team_id, player_id, kind, status, created_at, deadline,
                                   stage, stage_points, ms_into_stage, steal)
  values (v_room.id, v_round.id, v_player.team_id, v_player.id, 'turn', 'open', v_now,
          case when v_secs > 0 then v_now + make_interval(secs => v_secs) end,
          v_round.stage, public.npl_stage_points(v_round.mode, v_round.stage),
          greatest(0, floor(extract(epoch from (v_now - coalesce(v_round.stage_started_at, v_now))) * 1000))::int,
          v_round.had_error)
  returning * into v_att;

  update public.npl_rounds set status = 'answering', current_attempt_id = v_att.id where id = v_round.id;
  perform public.npl_touch(v_room.id, 'buzz', jsonb_build_object('team_id', v_att.team_id, 'attempt_id', v_att.id));
  return jsonb_build_object('ok', true, 'attempt_id', v_att.id, 'deadline', v_att.deadline, 'team_id', v_att.team_id);
end $$;

-- Resposta do time (vale o primeiro envio de qualquer celular do time)
create or replace function public.npl_submit_answer(p_code text, p_token text, p_attempt_id uuid, p_artist text, p_title text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.npl_rooms := public.npl_lock_room(p_code);
  v_player public.npl_players := public.npl_player_by_token(v_room.id, p_token);
  v_att public.npl_attempts;
  v_round public.npl_rounds;
  v_track public.npl_tracks;
  v_scoring text := coalesce(v_room.settings->>'scoring', 'artist_title');
  v_artist_res text;
  v_title_res text;
  v_res text;
begin
  select * into v_att from public.npl_attempts where id = p_attempt_id and room_id = v_room.id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'closed'); end if;
  select * into v_round from public.npl_rounds where id = v_att.round_id for update;
  if v_att.status <> 'open' or v_round.current_attempt_id is distinct from v_att.id then
    return jsonb_build_object('ok', false, 'reason', 'closed', 'status', v_att.status);
  end if;
  if v_player.team_id is distinct from v_att.team_id then
    return jsonb_build_object('ok', false, 'reason', 'not_your_team');
  end if;
  if v_att.deadline is not null and not v_room.paused
     and clock_timestamp() > v_att.deadline + interval '1.5 seconds' then
    perform public.npl_finalize_attempt(v_att.id, 'timeout', 'auto');
    perform public.npl_touch(v_room.id, 'timeout');
    return jsonb_build_object('ok', false, 'reason', 'timeout');
  end if;

  select * into v_track from public.npl_tracks
   where room_id = v_room.id and match_no = v_round.match_no and position = v_round.round_no;

  if v_scoring = 'title' then
    v_artist_res := 'empty';
  else
    v_artist_res := public.npl_classify(p_artist,
      array(select jsonb_array_elements_text(v_track.artists)) || v_track.artist, false);
  end if;
  v_title_res := public.npl_classify(p_title, array[v_track.title, coalesce(v_track.title_short, v_track.title)], true);

  if v_artist_res = 'empty' and v_title_res = 'empty' then
    return jsonb_build_object('ok', false, 'reason', 'empty');
  end if;

  update public.npl_attempts
     set answer_artist = case when v_scoring = 'title' then null else left(btrim(p_artist), 120) end,
         answer_title = left(btrim(p_title), 120),
         artist_result = v_artist_res,
         title_result = v_title_res,
         answered_by = v_player.id
   where id = v_att.id;

  -- zona de dúvida: só importa se puder mudar o resultado
  if v_title_res = 'doubt' or (v_scoring = 'artist_title' and v_title_res <> 'ok' and v_artist_res = 'doubt') then
    update public.npl_attempts set status = 'doubt' where id = v_att.id;
    update public.npl_rounds set status = 'doubt' where id = v_round.id;
    perform public.npl_touch(v_room.id, 'doubt');
    return jsonb_build_object('ok', true, 'result', 'doubt');
  end if;

  v_res := public.npl_finalize_attempt(v_att.id, 'wrong', 'auto');
  perform public.npl_touch(v_room.id, 'answer', jsonb_build_object('result', v_res));
  return jsonb_build_object('ok', true, 'result', v_res,
    'points', (select points from public.npl_attempts where id = v_att.id));
end $$;

-- "Valeu ou não valeu?" — só o dono decide
create or replace function public.npl_judge(p_code text, p_owner_token text, p_attempt_id uuid, p_accept boolean)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.npl_rooms := public.npl_lock_room(p_code);
  v_att public.npl_attempts;
  v_new text := case when p_accept then 'ok' else 'wrong' end;
  v_res text;
begin
  perform public.npl_require_owner(v_room, p_owner_token);
  select * into v_att from public.npl_attempts where id = p_attempt_id and room_id = v_room.id for update;
  if not found or v_att.status <> 'doubt' then return null; end if;
  update public.npl_attempts
     set artist_result = case when artist_result = 'doubt' then v_new else artist_result end,
         title_result  = case when title_result  = 'doubt' then v_new else title_result end
   where id = v_att.id;
  v_res := public.npl_finalize_attempt(v_att.id, 'wrong', 'owner');
  perform public.npl_touch(v_room.id, 'answer', jsonb_build_object('result', v_res));
  return v_res;
end $$;

-- Inverte uma decisão (automática ou não) e recalcula o placar
create or replace function public.npl_override(p_code text, p_owner_token text, p_attempt_id uuid, p_correct boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.npl_rooms := public.npl_lock_room(p_code);
  v_att public.npl_attempts;
  v_round public.npl_rounds;
  v_scoring text := coalesce(v_room.settings->>'scoring', 'artist_title');
  v_pts int;
begin
  perform public.npl_require_owner(v_room, p_owner_token);
  select * into v_att from public.npl_attempts where id = p_attempt_id and room_id = v_room.id and kind = 'turn' for update;
  if not found then raise exception 'npl:attempt_not_found'; end if;
  select * into v_round from public.npl_rounds where id = v_att.round_id for update;

  if p_correct and v_att.status in ('wrong', 'timeout') then
    v_att.artist_result := case when coalesce(v_att.answer_artist, '') <> '' then 'ok' else v_att.artist_result end;
    v_att.title_result  := case when coalesce(v_att.answer_title, '')  <> '' then 'ok' else v_att.title_result end;
    if coalesce(v_att.artist_result, '') <> 'ok' and coalesce(v_att.title_result, '') <> 'ok' then
      if v_scoring = 'artist_title' then v_att.artist_result := 'ok'; else v_att.title_result := 'ok'; end if;
    end if;
    v_pts := public.npl_attempt_points(v_att, v_scoring);
    update public.npl_attempts
       set status = 'correct', points = v_pts, artist_result = v_att.artist_result, title_result = v_att.title_result,
           overridden = true, decided_by = 'owner', decided_at = now()
     where id = v_att.id;
    if v_round.status in ('loading', 'playing', 'answering', 'doubt') then
      update public.npl_attempts set status = 'cancelled', points = 0
       where round_id = v_round.id and status in ('open', 'doubt');
      update public.npl_rounds set winner_team_id = v_att.team_id, points = v_pts where id = v_round.id;
      perform public.npl_reveal_round(v_round.id, false);
    elsif v_round.winner_team_id is null then
      update public.npl_rounds set winner_team_id = v_att.team_id, points = v_pts where id = v_round.id;
    end if;
  elsif not p_correct and v_att.status = 'correct' then
    update public.npl_attempts
       set status = 'wrong', points = -coalesce((v_room.settings->>'penalty')::int, 0),
           artist_result = case when artist_result = 'ok' then 'wrong' else artist_result end,
           title_result  = case when title_result  = 'ok' then 'wrong' else title_result end,
           overridden = true, decided_by = 'owner', decided_at = now()
     where id = v_att.id;
    if v_round.winner_team_id = v_att.team_id then
      update public.npl_rounds set winner_team_id = null, points = 0 where id = v_round.id;
    end if;
  else
    return;
  end if;
  perform public.npl_recalc_scores(v_room.id);
  perform public.npl_touch(v_room.id, 'override');
end $$;

create or replace function public.npl_adjust_score(p_code text, p_owner_token text, p_team_id uuid, p_delta int)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_room public.npl_rooms := public.npl_lock_room(p_code);
begin
  perform public.npl_require_owner(v_room, p_owner_token);
  if not exists (select 1 from public.npl_teams where id = p_team_id and room_id = v_room.id) then
    raise exception 'npl:team_not_found';
  end if;
  insert into public.npl_score_adjustments (room_id, match_no, team_id, delta)
  values (v_room.id, v_room.match_no, p_team_id, greatest(-1000, least(1000, coalesce(p_delta, 0))));
  perform public.npl_recalc_scores(v_room.id);
  perform public.npl_touch(v_room.id, 'score');
end $$;

-- Dono encerra a vez do time (útil com "sem limite"): conta como erro
create or replace function public.npl_end_turn(p_code text, p_owner_token text, p_attempt_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.npl_rooms := public.npl_lock_room(p_code);
  v_att public.npl_attempts;
begin
  perform public.npl_require_owner(v_room, p_owner_token);
  select * into v_att from public.npl_attempts where id = p_attempt_id and room_id = v_room.id for update;
  if not found or v_att.status <> 'open' then return; end if;
  perform public.npl_finalize_attempt(v_att.id, 'timeout', 'owner');
  perform public.npl_touch(v_room.id, 'timeout');
end $$;

-- Qualquer cliente pode pedir para o servidor conferir prazos vencidos
-- (o horário é sempre o do servidor, então não há como trapacear).
create or replace function public.npl_tick(p_code text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_room public.npl_rooms := public.npl_lock_room(p_code);
begin
  if public.npl_expire_overdue(v_room) then
    perform public.npl_touch(v_room.id, 'timeout');
    return true;
  end if;
  return false;
end $$;

revoke execute on function public.npl_player_json(public.npl_players) from public, anon, authenticated;

-- Resposta certa da rodada atual, só para o dono e só na "zona de dúvida"
-- (a tela principal mostra "Valeu ou não valeu?" com a digitada e a certa).
create or replace function public.npl_host_answer(p_code text, p_owner_token text)
returns jsonb
language plpgsql stable
security definer
set search_path = public
as $$
declare
  r public.npl_rooms;
  v_round public.npl_rounds;
  v_track public.npl_tracks;
begin
  select * into r from public.npl_rooms where code = btrim(p_code);
  if not found then raise exception 'npl:room_not_found'; end if;
  perform public.npl_require_owner(r, p_owner_token);
  select * into v_round from public.npl_rounds
   where room_id = r.id and match_no = r.match_no and round_no = r.round_no;
  if not found or v_round.status <> 'doubt' then return null; end if;
  select * into v_track from public.npl_tracks
   where room_id = r.id and match_no = r.match_no and position = r.round_no;
  return jsonb_build_object('title', v_track.title, 'artist', v_track.artist, 'artists', v_track.artists);
end $$;
