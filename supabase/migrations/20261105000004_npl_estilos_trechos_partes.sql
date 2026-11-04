-- =====================================================================
-- Musicalizando — 004: estilos de sala ("Todos jogam" / "Com apresentador"),
-- trechos manuais com pontos sorteados, artista e música como partes
-- independentes, roubo com pontos normais, bloqueio por tempo,
-- resposta falada/digitada, "Quase!" e efeitos sonoros (config).
-- Aplicar DEPOIS das migrações 001–003. Pode rodar mais de uma vez.
-- Continua tudo com o prefixo npl_ (projeto Supabase compartilhado).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Colunas novas
-- ---------------------------------------------------------------------
-- owner_hash (já existia) passa a ser o token da TELA (TV).
-- ctrl_hash é o token do CELULAR do dono (o token de jogador daquele aparelho).
alter table public.npl_rooms add column if not exists ctrl_hash text;
alter table public.npl_rooms add column if not exists claim_hash text;    -- QR "Sou o dono" (uso único)
alter table public.npl_rooms add column if not exists pause_reason text;  -- owner | owner_away

alter table public.npl_rounds add column if not exists offsets jsonb not null default '[]'::jsonb; -- início (s) de cada trecho
alter table public.npl_rounds add column if not exists play_seq int not null default 0;           -- +1 a cada "Tocar/Repetir"
alter table public.npl_rounds add column if not exists played_stage int not null default 0;       -- último estágio tocado
alter table public.npl_rounds add column if not exists play_at timestamptz;
alter table public.npl_rounds add column if not exists artist_team_id uuid references public.npl_teams (id) on delete set null;
alter table public.npl_rounds add column if not exists title_team_id uuid references public.npl_teams (id) on delete set null;
alter table public.npl_rounds add column if not exists found jsonb not null default '{}'::jsonb;  -- partes já descobertas
alter table public.npl_rounds add column if not exists locks jsonb not null default '{}'::jsonb;  -- {team_id: liberado_em}

-- ---------------------------------------------------------------------
-- Configuração: "Modo de resposta" (falada = padrão | digitada)
-- ---------------------------------------------------------------------
create or replace function public.npl_default_settings()
returns jsonb
language sql immutable
set search_path = public
as $$
  select jsonb_build_object(
    'mode', 'classic',
    'modeSelection', 'fixed',
    'modePool', jsonb_build_array('classic'),
    'rounds', 10,
    'answerSeconds', 20,            -- 0 = sem limite
    'penalty', 0,
    'scoring', 'artist_title',      -- artist_title ("Artista e música") | title ("Só a música")
    'roomStyle', 'all',             -- all ("Todos jogam", controles na TV) | host ("Com apresentador")
    'answerMode', 'spoken',         -- só no estilo host: spoken (falada) | typed (digitada)
    'lockSeconds', 15,              -- bloqueio após erro: 10 | 15 | 20 | 30
    'sounds', true,                 -- efeitos sonoros na TV
    'teamMode', 'teams',
    'teamCount', 2,
    'sources', jsonb_build_array(jsonb_build_object('type', 'preset', 'id', 'top_brasil', 'label', 'Top Brasil'))
  )
$$;

create or replace function public.npl_clean_settings(p jsonb)
returns jsonb
language plpgsql immutable
set search_path = public
as $$
declare
  s jsonb := public.npl_default_settings() || coalesce(p, '{}'::jsonb);
  v_int int;
begin
  begin v_int := (s->>'rounds')::int; exception when others then v_int := 10; end;
  s := jsonb_set(s, '{rounds}', to_jsonb(least(30, greatest(5, coalesce(v_int, 10)))));

  begin v_int := (s->>'answerSeconds')::int; exception when others then v_int := 20; end;
  if v_int is null or v_int not in (0, 10, 20, 30) then v_int := 20; end if;
  s := jsonb_set(s, '{answerSeconds}', to_jsonb(v_int));

  begin v_int := (s->>'penalty')::int; exception when others then v_int := 0; end;
  if v_int is null or v_int not in (0, 20, 50) then v_int := 0; end if;
  s := jsonb_set(s, '{penalty}', to_jsonb(v_int));

  begin v_int := (s->>'teamCount')::int; exception when others then v_int := 2; end;
  s := jsonb_set(s, '{teamCount}', to_jsonb(least(12, greatest(2, coalesce(v_int, 2)))));

  if coalesce(s->>'scoring', '') not in ('artist_title', 'title') then
    s := jsonb_set(s, '{scoring}', '"artist_title"');
  end if;
  if coalesce(s->>'roomStyle', '') not in ('all', 'host') then
    s := jsonb_set(s, '{roomStyle}', '"all"');
  end if;
  if coalesce(s->>'answerMode', '') not in ('spoken', 'typed') then
    s := jsonb_set(s, '{answerMode}', '"spoken"');
  end if;
  -- "Todos jogam": sem apresentador, as respostas são sempre digitadas
  if s->>'roomStyle' = 'all' then
    s := jsonb_set(s, '{answerMode}', '"typed"');
  end if;
  begin v_int := (s->>'lockSeconds')::int; exception when others then v_int := 15; end;
  if v_int is null or v_int not in (10, 15, 20, 30) then v_int := 15; end if;
  s := jsonb_set(s, '{lockSeconds}', to_jsonb(v_int));
  if jsonb_typeof(s->'sounds') <> 'boolean' then
    s := jsonb_set(s, '{sounds}', 'true');
  end if;
  if coalesce(s->>'teamMode', '') not in ('teams', 'solo') then
    s := jsonb_set(s, '{teamMode}', '"teams"');
  end if;
  if coalesce(s->>'modeSelection', '') not in ('fixed', 'random') then
    s := jsonb_set(s, '{modeSelection}', '"fixed"');
  end if;
  if jsonb_typeof(s->'modePool') <> 'array' or jsonb_array_length(s->'modePool') = 0 then
    s := jsonb_set(s, '{modePool}', jsonb_build_array(coalesce(s->>'mode', 'classic')));
  end if;
  if jsonb_typeof(s->'sources') <> 'array' or jsonb_array_length(s->'sources') = 0 then
    s := jsonb_set(s, '{sources}', public.npl_default_settings()->'sources');
  end if;
  if jsonb_array_length(s->'sources') > 12 then
    s := jsonb_set(s, '{sources}', (select jsonb_agg(e) from (
      select e from jsonb_array_elements(s->'sources') with ordinality as t(e, n) where n <= 12) q));
  end if;
  return s;
end $$;

-- ---------------------------------------------------------------------
-- Quem manda: dono = TV (owner_hash) OU celular do dono (ctrl_hash)
-- ---------------------------------------------------------------------
create or replace function public.npl_require_owner(p_room public.npl_rooms, p_owner_token text)
returns void
language plpgsql
set search_path = public
as $$
begin
  if p_owner_token is null
     or (p_room.owner_hash <> public.npl_hash(p_owner_token)
         and p_room.ctrl_hash is distinct from public.npl_hash(p_owner_token)) then
    raise exception 'npl:not_owner';
  end if;
end $$;

-- Só a TV (quem criou a sala): IDs do Deezer, abrir rodada, QR de dono
create or replace function public.npl_require_host(p_room public.npl_rooms, p_token text)
returns void
language plpgsql
set search_path = public
as $$
begin
  if p_token is null or p_room.owner_hash <> public.npl_hash(p_token) then
    raise exception 'npl:not_host';
  end if;
end $$;

-- Pausa/continua. Ao continuar, o tempo de resposta não corre durante a pausa.
create or replace function public.npl_set_paused(p_room public.npl_rooms, p_paused boolean, p_reason text)
returns boolean
language plpgsql
set search_path = public
as $$
begin
  if p_paused and not p_room.paused then
    update public.npl_rooms set paused = true, paused_at = clock_timestamp(), pause_reason = p_reason
     where id = p_room.id;
    return true;
  elsif p_paused and p_room.paused and p_reason = 'owner' and p_room.pause_reason is distinct from 'owner' then
    -- dono pausou por cima da pausa automática: só ele tira
    update public.npl_rooms set pause_reason = 'owner' where id = p_room.id;
    return true;
  elsif not p_paused and p_room.paused then
    update public.npl_attempts a
       set deadline = a.deadline + (clock_timestamp() - coalesce(p_room.paused_at, clock_timestamp()))
     where a.room_id = p_room.id and a.status = 'open' and a.deadline is not null;
    -- o bloqueio por tempo também fica congelado durante a pausa
    update public.npl_rounds x
       set locks = (select coalesce(jsonb_object_agg(k,
                      to_jsonb((v #>> '{}')::timestamptz + (clock_timestamp() - coalesce(p_room.paused_at, clock_timestamp()))))
                      , '{}'::jsonb)
                      from jsonb_each(x.locks) as e(k, v))
     where x.room_id = p_room.id and x.match_no = p_room.match_no and x.round_no = p_room.round_no
       and x.locks <> '{}'::jsonb;
    update public.npl_rooms set paused = false, paused_at = null, pause_reason = null where id = p_room.id;
    return true;
  end if;
  return false;
end $$;

-- ---------------------------------------------------------------------
-- Leitura (sem hashes) + quem é o dono
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
    'room', to_jsonb(r) - 'owner_hash' - 'ctrl_hash' - 'claim_hash',
    'owner', jsonb_build_object(
      'claimed', r.ctrl_hash is not null,
      'player_id', (select p.id from public.npl_players p where p.room_id = r.id and p.token_hash = r.ctrl_hash)),
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
                  where code = btrim(p_code)
                    and (owner_hash = public.npl_hash(p_owner_token) or ctrl_hash = public.npl_hash(p_owner_token)))
$$;

-- ---------------------------------------------------------------------
-- QR "Sou o dono"
-- ---------------------------------------------------------------------
-- A TV registra um segredo de uso único (vai no QR).
create or replace function public.npl_open_claim(p_code text, p_host_token text, p_claim text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_room public.npl_rooms := public.npl_lock_room(p_code);
begin
  perform public.npl_require_host(v_room, p_host_token);
  if length(coalesce(p_claim, '')) < 16 then raise exception 'npl:bad_token'; end if;
  update public.npl_rooms set claim_hash = public.npl_hash(p_claim) where id = v_room.id;
end $$;

-- O celular que escaneou vira o dono (o token dele passa a valer como chave de dono).
create or replace function public.npl_claim_owner(p_code text, p_claim text, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_room public.npl_rooms := public.npl_lock_room(p_code);
begin
  if length(coalesce(p_token, '')) < 16 then raise exception 'npl:bad_token'; end if;
  if v_room.ctrl_hash is distinct from public.npl_hash(p_token) then
    if v_room.claim_hash is null or v_room.claim_hash <> public.npl_hash(p_claim) then
      raise exception 'npl:bad_claim';
    end if;
    update public.npl_rooms set ctrl_hash = public.npl_hash(p_token), claim_hash = null where id = v_room.id;
    -- o apresentador não joga: se este celular tinha entrado como jogador, sai do time
    if v_room.phase <> 'playing' then
      delete from public.npl_players where room_id = v_room.id and token_hash = public.npl_hash(p_token);
    end if;
    perform public.npl_touch(v_room.id, 'owner');
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- A TV avisa que o celular do dono sumiu/voltou: pausa e retoma sozinho.
create or replace function public.npl_owner_away(p_code text, p_host_token text, p_away boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_room public.npl_rooms := public.npl_lock_room(p_code);
begin
  perform public.npl_require_host(v_room, p_host_token);
  if p_away then
    if v_room.phase = 'playing' and v_room.ctrl_hash is not null
       and public.npl_set_paused(v_room, true, 'owner_away') then
      perform public.npl_touch(v_room.id, 'pause');
    end if;
  elsif v_room.paused and v_room.pause_reason = 'owner_away' then
    perform public.npl_set_paused(v_room, false, null);
    perform public.npl_touch(v_room.id, 'pause');
  end if;
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
  if public.npl_set_paused(v_room, p_paused, 'owner') then
    perform public.npl_touch(v_room.id, 'pause');
  end if;
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
  if v_room.owner_hash <> public.npl_hash(p_token)
     and v_room.ctrl_hash is distinct from public.npl_hash(p_token)
     and not exists (
       select 1 from public.npl_players
        where room_id = v_room.id and token_hash = public.npl_hash(p_token) and team_id = p_team_id) then
    raise exception 'npl:not_allowed';
  end if;
  update public.npl_teams set name = v_name where id = p_team_id and room_id = v_room.id;
  perform public.npl_touch(v_room.id, 'team');
end $$;

-- ---------------------------------------------------------------------
-- Partida
-- ---------------------------------------------------------------------
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
  if v_room.settings->>'roomStyle' = 'host' and v_room.ctrl_hash is null then raise exception 'npl:no_owner'; end if;
  if v_room.phase = 'playing' then raise exception 'npl:match_running'; end if;
  if jsonb_typeof(p_tracks) <> 'array' or jsonb_array_length(p_tracks) < 1 then
    raise exception 'npl:no_tracks';
  end if;

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

  delete from public.npl_teams t
   where t.room_id = v_room.id
     and not exists (select 1 from public.npl_players p where p.team_id = t.id);
  if (select count(*) from public.npl_teams where room_id = v_room.id) < 2 then
    raise exception 'npl:need_two_teams';
  end if;

  v_match := v_room.match_no + 1;
  delete from public.npl_tracks where room_id = v_room.id;
  delete from public.npl_rounds where room_id = v_room.id;
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
         phase = 'playing', paused = false, paused_at = null, pause_reason = null
   where id = v_room.id;
  insert into public.npl_rounds (room_id, match_no, round_no, mode)
  values (v_room.id, v_match, 1, public.npl_pick_mode(v_room.settings));

  perform public.npl_recalc_scores(v_room.id);
  perform public.npl_touch(v_room.id, 'start');
  return jsonb_build_object('match_no', v_match, 'total_rounds', v_count);
end $$;

-- IDs Deezer da rodada atual e da próxima: SÓ a TV (o dono pode estar jogando)
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
  perform public.npl_require_host(r, p_owner_token);
  return coalesce((
    select jsonb_agg(jsonb_build_object('round_no', t.position, 'deezer_id', t.deezer_id) order by t.position)
      from public.npl_tracks t
     where t.room_id = r.id and t.match_no = r.match_no
       and t.position between r.round_no and r.round_no + 1), '[]'::jsonb);
end $$;

-- A TV carregou o áudio: abre a rodada no estágio 1, SEM tocar (o dono toca).
-- p_offsets: segundo de início de cada trecho, sorteado pela TV (fica guardado).
drop function if exists public.npl_round_begin(text, text, uuid, jsonb);
create or replace function public.npl_round_begin(p_code text, p_owner_token text, p_round_id uuid,
                                                  p_artists jsonb default '[]'::jsonb,
                                                  p_offsets jsonb default '[]'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.npl_rooms := public.npl_lock_room(p_code);
  v_round public.npl_rounds;
  v_offsets jsonb := '[]'::jsonb;
begin
  perform public.npl_require_host(v_room, p_owner_token);
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

  if jsonb_typeof(p_offsets) = 'array' then
    select coalesce(jsonb_agg(to_jsonb(least(60, greatest(0, round((e #>> '{}')::numeric, 2)))) order by n), '[]'::jsonb)
      into v_offsets
      from jsonb_array_elements(p_offsets) with ordinality as x(e, n)
     where jsonb_typeof(e) = 'number' and n <= 12;
  end if;

  update public.npl_rounds
     set status = 'playing', stage = 1, stage_started_at = clock_timestamp(), started_at = now(),
         offsets = v_offsets, play_seq = 0, played_stage = 0, play_at = null
   where id = v_round.id
  returning * into v_round;
  perform public.npl_touch(v_room.id, 'round');
  return to_jsonb(v_round);
end $$;

-- Nada avança sozinho: o avanço automático de estágio deixa de existir.
drop function if exists public.npl_advance_stage(text, text, uuid, int);

-- "Tocar"/"Repetir" (p_advance = false) ou "Próximo trecho" (p_advance = true).
-- p_stage = estágio que o celular está vendo (evita avanço duplo).
create or replace function public.npl_play(p_code text, p_owner_token text, p_round_id uuid, p_stage int,
                                           p_advance boolean default false)
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
  if v_room.paused or v_round.status <> 'playing' or v_round.stage <> p_stage
     or (coalesce(p_advance, false) and v_round.stage >= public.npl_stage_count(v_round.mode)) then
    return jsonb_build_object('ok', false, 'round', to_jsonb(v_round));
  end if;
  update public.npl_rounds
     set stage = stage + case when coalesce(p_advance, false) then 1 else 0 end,
         played_stage = stage + case when coalesce(p_advance, false) then 1 else 0 end,
         play_seq = play_seq + 1,
         play_at = clock_timestamp(),
         stage_started_at = clock_timestamp()
   where id = v_round.id
  returning * into v_round;
  perform public.npl_touch(v_room.id, 'play', jsonb_build_object('seq', v_round.play_seq));
  return jsonb_build_object('ok', true, 'round', to_jsonb(v_round));
end $$;

-- Pular música (sem pontos, marcada como pulada) ou revelar (p_skipped = false:
-- "ninguém acertou", usado depois do último trecho).
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
  perform public.npl_set_paused(v_room, false, null);
  perform public.npl_recalc_scores(v_room.id);
  perform public.npl_touch(v_room.id, 'reveal');
end $$;

create or replace function public.npl_end_round(p_code text, p_owner_token text, p_round_id uuid)
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
  if not found or v_round.status in ('loading', 'revealed', 'scoreboard') then return; end if;
  update public.npl_attempts set status = 'cancelled', points = 0, decided_at = now()
   where round_id = v_round.id and status in ('open', 'doubt');
  perform public.npl_reveal_round(v_round.id, false);
  perform public.npl_set_paused(v_room, false, null);
  perform public.npl_recalc_scores(v_room.id);
  perform public.npl_touch(v_room.id, 'reveal');
end $$;

-- Avançar sempre funciona, com ou sem pausa (e tira a pausa).
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
  if found then
    perform public.npl_set_paused(v_room, false, null);
    perform public.npl_touch(v_room.id, 'scoreboard');
  end if;
end $$;

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
  perform public.npl_set_paused(v_room, false, null);
  if v_room.round_no >= v_room.total_rounds then
    update public.npl_rooms set phase = 'finished', paused = false, pause_reason = null where id = v_room.id;
    perform public.npl_touch(v_room.id, 'finished');
    return;
  end if;
  update public.npl_rooms set round_no = round_no + 1 where id = v_room.id;
  insert into public.npl_rounds (room_id, match_no, round_no, mode)
  values (v_room.id, v_room.match_no, v_room.round_no + 1, public.npl_pick_mode(v_room.settings));
  perform public.npl_touch(v_room.id, 'next');
end $$;

-- ---------------------------------------------------------------------
-- Pontuação por partes
--   Artista = 50% dos pontos do estágio, Música = 100% (as duas = 150%).
--   "Só a música": música = 100%.
--   Roubo vale os pontos normais (a etiqueta "steal" fica só como estatística).
--   Errar uma parte que o time TENTOU (ou errar/estourar o tempo) = penalidade.
--   Cada parte vale só para a primeira tentativa que a acertou.
-- ---------------------------------------------------------------------
create or replace function public.npl_rescore_round(p_round_id uuid)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  v_round public.npl_rounds;
  v_room public.npl_rooms;
  v_track public.npl_tracks;
  v_scoring text;
  v_pen int;
  v_art boolean := false;
  v_tit boolean := false;
  v_art_team uuid;
  v_tit_team uuid;
  v_total int := 0;
  v_pts numeric;
  v_err boolean;
  v_final int;
  a public.npl_attempts;
begin
  select * into v_round from public.npl_rounds where id = p_round_id;
  select * into v_room from public.npl_rooms where id = v_round.room_id;
  select * into v_track from public.npl_tracks
   where room_id = v_round.room_id and match_no = v_round.match_no and position = v_round.round_no;
  v_scoring := coalesce(v_room.settings->>'scoring', 'artist_title');
  v_pen := coalesce((v_room.settings->>'penalty')::int, 0);

  for a in select * from public.npl_attempts
            where round_id = p_round_id and kind = 'turn' and status in ('correct', 'wrong', 'timeout')
            order by created_at
  loop
    v_pts := 0;
    if v_scoring = 'artist_title' and a.artist_result = 'ok' and not v_art then
      v_pts := v_pts + a.stage_points * 0.5;
      v_art := true;
      v_art_team := a.team_id;
    end if;
    if a.title_result = 'ok' and not v_tit then
      v_pts := v_pts + a.stage_points;
      v_tit := true;
      v_tit_team := a.team_id;
    end if;
    v_err := a.status <> 'correct'
          or coalesce(a.artist_result, '') = 'wrong'
          or coalesce(a.title_result, '') = 'wrong';
    v_final := round(v_pts)::int - case when v_err then v_pen else 0 end;
    if v_final is distinct from a.points then
      update public.npl_attempts set points = v_final where id = a.id;
    end if;
    v_total := v_total + round(v_pts)::int;
  end loop;

  update public.npl_rounds
     set artist_team_id = v_art_team,
         title_team_id = v_tit_team,
         winner_team_id = coalesce(v_tit_team, v_art_team),
         points = v_total,
         found = jsonb_strip_nulls(jsonb_build_object(
           'artist', case when v_art then v_track.artist end,
           'title', case when v_tit then v_track.title end))
   where id = p_round_id;
  return v_tit and (v_art or v_scoring <> 'artist_title');
end $$;

-- Fecha uma tentativa com as partes já marcadas (ok | wrong | empty | null).
-- Retorna: correct (rodada completa) | partial (acertou parte, rodada continua) | wrong | timeout
create or replace function public.npl_finalize_attempt(p_attempt_id uuid, p_status_if_wrong text, p_decided_by text)
returns text
language plpgsql
set search_path = public
as $$
declare
  v_att public.npl_attempts;
  v_ok boolean;
  v_err boolean;
  v_complete boolean;
begin
  -- uma parte que ficou "quase" (dúvida) sem correção conta como erro
  update public.npl_attempts
     set artist_result = case when artist_result = 'doubt' then 'wrong' else artist_result end,
         title_result  = case when title_result  = 'doubt' then 'wrong' else title_result end
   where id = p_attempt_id;
  select * into v_att from public.npl_attempts where id = p_attempt_id;
  v_ok := coalesce(v_att.artist_result, '') = 'ok' or coalesce(v_att.title_result, '') = 'ok';
  v_err := not v_ok or coalesce(v_att.artist_result, '') = 'wrong' or coalesce(v_att.title_result, '') = 'wrong';
  update public.npl_attempts
     set status = case when v_ok then 'correct' else p_status_if_wrong end,
         decided_by = p_decided_by, decided_at = now()
   where id = v_att.id;

  v_complete := public.npl_rescore_round(v_att.round_id);
  if v_complete then
    update public.npl_attempts set status = 'cancelled', points = 0
     where round_id = v_att.round_id and status in ('open', 'doubt') and id <> v_att.id;
    perform public.npl_reveal_round(v_att.round_id, false);
  else
    -- volta a esperar (tocar / repetir / próximo trecho); quem errou fica bloqueado por
    -- alguns segundos (horário de liberação gravado aqui, o relógio que vale é o do servidor)
    update public.npl_rounds r
       set status = 'playing', current_attempt_id = null,
           locks = case when v_err then r.locks || jsonb_build_object(v_att.team_id::text,
                     clock_timestamp() + make_interval(secs => coalesce((
                       select (settings->>'lockSeconds')::int from public.npl_rooms where id = v_att.room_id), 15)))
                   else r.locks end,
           had_error = had_error or v_err
     where id = v_att.round_id;
  end if;
  perform public.npl_recalc_scores(v_att.room_id);
  return case when v_complete then 'correct' when v_ok then 'partial' else p_status_if_wrong end;
end $$;

-- Resposta DIGITADA: confere só as partes que ainda faltam.
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
  v_need_artist boolean;
  v_need_title boolean;
  v_artist_res text;
  v_title_res text;
  v_res text;
begin
  if coalesce(v_room.settings->>'answerMode', 'spoken') <> 'typed' then
    return jsonb_build_object('ok', false, 'reason', 'spoken');
  end if;
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

  v_need_artist := v_scoring = 'artist_title' and not (v_round.found ? 'artist');
  v_need_title := not (v_round.found ? 'title');
  v_artist_res := case when v_need_artist then public.npl_classify(p_artist,
                    array(select jsonb_array_elements_text(v_track.artists)) || v_track.artist, false)
                  else 'empty' end;
  v_title_res := case when v_need_title then public.npl_classify(p_title,
                   array[v_track.title, coalesce(v_track.title_short, v_track.title)], true)
                 else 'empty' end;

  if v_artist_res = 'empty' and v_title_res = 'empty' then
    return jsonb_build_object('ok', false, 'reason', 'empty');
  end if;

  update public.npl_attempts
     set answer_artist = case when v_need_artist then nullif(left(btrim(coalesce(p_artist, '')), 120), '') end,
         answer_title = case when v_need_title then nullif(left(btrim(coalesce(p_title, '')), 120), '') end,
         artist_result = v_artist_res,
         title_result = v_title_res,
         answered_by = v_player.id
   where id = v_att.id;

  -- zona de dúvida
  if (v_artist_res = 'doubt' or v_title_res = 'doubt') and v_room.settings->>'roomStyle' <> 'host' then
    -- "Todos jogam": "Quase! Confira a escrita". A vez continua aberta (o tempo segue
    -- correndo) e o time pode corrigir e reenviar. Nada aparece na TV.
    return jsonb_build_object('ok', true, 'result', 'almost',
      'artist', v_artist_res, 'title', v_title_res);
  end if;
  if v_artist_res = 'doubt' or v_title_res = 'doubt' then
    -- "Com apresentador": ele decide pelo celular
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

-- Resposta FALADA (ou qualquer tentativa aberta): o dono marca o que valeu.
-- p_artist / p_title = "Artista certo" / "Música certa"; os dois falsos = "Errou".
create or replace function public.npl_decide(p_code text, p_owner_token text, p_attempt_id uuid, p_artist boolean, p_title boolean)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.npl_rooms := public.npl_lock_room(p_code);
  v_att public.npl_attempts;
  v_round public.npl_rounds;
  v_scoring text := coalesce(v_room.settings->>'scoring', 'artist_title');
  v_a boolean;
  v_t boolean;
  v_res text;
begin
  perform public.npl_require_owner(v_room, p_owner_token);
  select * into v_att from public.npl_attempts
   where id = p_attempt_id and room_id = v_room.id and kind = 'turn' for update;
  if not found or v_att.status not in ('open', 'doubt') then return null; end if;
  select * into v_round from public.npl_rounds where id = v_att.round_id for update;
  if v_round.current_attempt_id is distinct from v_att.id then return null; end if;

  v_a := v_scoring = 'artist_title' and coalesce(p_artist, false) and not (v_round.found ? 'artist');
  v_t := coalesce(p_title, false) and not (v_round.found ? 'title');
  update public.npl_attempts
     set artist_result = case when v_a then 'ok'
                              when coalesce(artist_result, 'empty') = 'empty' then artist_result
                              else 'wrong' end,
         title_result  = case when v_t then 'ok'
                              when coalesce(title_result, 'empty') = 'empty' then title_result
                              else 'wrong' end
   where id = v_att.id;
  v_res := public.npl_finalize_attempt(v_att.id, 'wrong', 'owner');
  perform public.npl_touch(v_room.id, 'answer', jsonb_build_object('result', v_res));
  return v_res;
end $$;

-- "Inverter decisão": o dono define quais partes a tentativa acertou e o placar é refeito.
drop function if exists public.npl_override(text, text, uuid, boolean);
create or replace function public.npl_override_parts(p_code text, p_owner_token text, p_attempt_id uuid,
                                                     p_artist boolean, p_title boolean)
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
  v_a boolean;
  v_t boolean;
begin
  perform public.npl_require_owner(v_room, p_owner_token);
  select * into v_att from public.npl_attempts
   where id = p_attempt_id and room_id = v_room.id and kind = 'turn'
     and status in ('correct', 'wrong', 'timeout') for update;
  if not found then raise exception 'npl:attempt_not_found'; end if;
  select * into v_round from public.npl_rounds where id = v_att.round_id for update;

  v_a := v_scoring = 'artist_title' and coalesce(p_artist, false);
  v_t := coalesce(p_title, false);
  update public.npl_attempts
     set artist_result = case when v_a then 'ok'
                              when artist_result in ('ok', 'doubt', 'wrong') then 'wrong'
                              else artist_result end,
         title_result  = case when v_t then 'ok'
                              when title_result in ('ok', 'doubt', 'wrong') then 'wrong'
                              else title_result end,
         status = case when v_a or v_t then 'correct'
                       when status = 'timeout' then 'timeout'
                       else 'wrong' end,
         overridden = true, decided_by = 'owner', decided_at = now()
   where id = v_att.id;

  if public.npl_rescore_round(v_round.id) and v_round.status in ('loading', 'playing', 'answering', 'doubt') then
    update public.npl_attempts set status = 'cancelled', points = 0
     where round_id = v_round.id and status in ('open', 'doubt');
    perform public.npl_reveal_round(v_round.id, false);
  end if;
  perform public.npl_recalc_scores(v_room.id);
  perform public.npl_touch(v_room.id, 'override');
end $$;

-- Resposta certa para o celular do apresentador (estilo "Com apresentador").
-- No estilo "Todos jogam" só depois da revelação.
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
  if not found then return null; end if;
  -- o apresentador não joga: vê a resposta desde o início da rodada
  if r.settings->>'roomStyle' <> 'host' and v_round.status not in ('revealed', 'scoreboard') then
    return null;
  end if;
  select * into v_track from public.npl_tracks
   where room_id = r.id and match_no = r.match_no and position = r.round_no;
  return jsonb_build_object('round_id', v_round.id, 'title', v_track.title, 'artist', v_track.artist,
                            'artists', v_track.artists);
end $$;

-- ---------------------------------------------------------------------
-- O botão "EU SEI!" com bloqueio por tempo (cada time tem o seu)
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
  v_until timestamptz;
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

  -- já existe tentativa em andamento: registra o toque atrasado (para mostrar a ordem)
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

  if v_round.status <> 'playing' then
    if v_expired then perform public.npl_touch(v_room.id, 'timeout'); end if;
    return jsonb_build_object('ok', false, 'reason', 'closed');
  end if;
  if v_room.paused then return jsonb_build_object('ok', false, 'reason', 'paused'); end if;

  -- bloqueio por tempo depois de um erro
  v_until := (v_round.locks->>v_player.team_id::text)::timestamptz;
  if v_until is not null and v_until > v_now then
    if v_expired then perform public.npl_touch(v_room.id, 'timeout'); end if;
    return jsonb_build_object('ok', false, 'reason', 'locked', 'until', v_until);
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

-- ---------------------------------------------------------------------
-- Funções internas: ninguém de fora executa
-- ---------------------------------------------------------------------
revoke execute on function
  public.npl_require_owner(public.npl_rooms, text),
  public.npl_require_host(public.npl_rooms, text),
  public.npl_set_paused(public.npl_rooms, boolean, text),
  public.npl_rescore_round(uuid),
  public.npl_finalize_attempt(uuid, text, text),
  public.npl_clean_settings(jsonb)
  from public, anon, authenticated;
