-- =====================================================================
-- Musicalizando — 008: desempate (morte súbita), filtro de versões e
-- ano "original" na dica do Leilão.
-- Aplicar DEPOIS das migrações 001–007. Pode rodar mais de uma vez.
--
-- Configuração nova:
--   tiebreak       "sudden" (morte súbita, padrão) | "accept" (aceitar empate)
--   versionFilter  true (padrão) | false — usado ao montar a lista (rota do Next)
--
-- Morte súbita (só empate no 1º lugar): ao fim da última música, se houver
-- empate, entra uma rodada extra no modo clássico (música reserva sorteada
-- no início da partida) em que só os times empatados apertam.
--   npl_rounds.tiebreak = {} fora do desempate; senão:
--     teams     times que disputam esta rodada
--     out       times que erraram (fora do desempate, sem bloqueio por tempo)
--     survivor  sobrou um só time (os outros erraram): ele vence
--     n         nº da música de desempate (1, 2, …)
--   O primeiro que acertar a MÚSICA vence. Os pontos não entram no placar.
--   Ninguém acertou: outra música extra com os times que ainda estão no páreo.
-- =====================================================================

alter table public.npl_rounds add column if not exists tiebreak jsonb not null default '{}'::jsonb;

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
    'lockSeconds', 15,              -- bloqueio após erro: 5 | 10 | 15 | 20 | 30
    'sounds', true,                 -- efeitos sonoros na TV
    'sfxVolume', 'high',            -- volume dos efeitos: low | medium | high
    'clipMode', 'sequence',         -- trechos: sequence (todos do início) | alternate (pontos sorteados)
    'tiebreak', 'sudden',           -- empate no 1º lugar: sudden (morte súbita) | accept (aceitar empate)
    'versionFilter', true,          -- descarta ao vivo, acústico, remix, coletâneas… ao montar a lista
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
  if v_int is null or v_int not in (5, 10, 15, 20, 30) then v_int := 15; end if;
  s := jsonb_set(s, '{lockSeconds}', to_jsonb(v_int));
  if jsonb_typeof(s->'sounds') <> 'boolean' then
    s := jsonb_set(s, '{sounds}', 'true');
  end if;
  if coalesce(s->>'sfxVolume', '') not in ('low', 'medium', 'high') then
    s := jsonb_set(s, '{sfxVolume}', '"high"');
  end if;
  if coalesce(s->>'clipMode', '') not in ('sequence', 'alternate') then
    s := jsonb_set(s, '{clipMode}', '"sequence"');
  end if;
  if coalesce(s->>'tiebreak', '') not in ('sudden', 'accept') then
    s := jsonb_set(s, '{tiebreak}', '"sudden"');
  end if;
  if coalesce(jsonb_typeof(s->'versionFilter'), '') <> 'boolean' then
    s := jsonb_set(s, '{versionFilter}', 'true');
  end if;
  if coalesce(s->>'teamMode', '') not in ('teams', 'solo') then
    s := jsonb_set(s, '{teamMode}', '"teams"');
  end if;
  -- modos de jogo conhecidos
  if coalesce(s->>'mode', '') not in ('classic', 'auction') then
    s := jsonb_set(s, '{mode}', '"classic"');
  end if;
  if coalesce(s->>'modeSelection', '') not in ('fixed', 'random') then
    s := jsonb_set(s, '{modeSelection}', '"fixed"');
  end if;
  s := jsonb_set(s, '{modePool}', coalesce((
         select jsonb_agg(m order by first_n) from (
           select e #>> '{}' as m, min(n) as first_n
             from jsonb_array_elements(case when jsonb_typeof(s->'modePool') = 'array' then s->'modePool'
                                            else '[]'::jsonb end) with ordinality as t(e, n)
            where jsonb_typeof(e) = 'string' and e #>> '{}' in ('classic', 'auction')
            group by e #>> '{}') q), '[]'::jsonb));
  if jsonb_array_length(s->'modePool') = 0 then
    s := jsonb_set(s, '{modePool}', jsonb_build_array(s->>'mode'));
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
-- Desempate: ajudantes
-- ---------------------------------------------------------------------
create or replace function public.npl_is_tiebreak(p_round public.npl_rounds)
returns boolean
language sql immutable
set search_path = public
as $$ select coalesce(p_round.tiebreak ? 'teams', false) $$;

-- Times que ainda estão no páreo (teams - out)
create or replace function public.npl_tiebreak_left(p_round public.npl_rounds)
returns jsonb
language sql immutable
set search_path = public
as $$
  select coalesce(jsonb_agg(e order by n), '[]'::jsonb)
    from jsonb_array_elements(coalesce(p_round.tiebreak->'teams', '[]'::jsonb)) with ordinality as t(e, n)
   where not (coalesce(p_round.tiebreak->'out', '[]'::jsonb) @> jsonb_build_array(e))
$$;

-- Qual parte vale nesta rodada? Desempate: só a MÚSICA.
create or replace function public.npl_part_counts(p_round public.npl_rounds, p_scoring text, p_part text)
returns boolean
language sql immutable
set search_path = public
as $$
  select coalesce(case
    when public.npl_is_tiebreak(p_round) then p_part = 'title'
    when p_round.mode = 'auction' then
      case when p_part = 'artist' then p_round.auction->>'hint' = 'genre'
           else p_round.auction->>'hint' = 'artist' end
    when p_part = 'artist' then coalesce(p_scoring, 'artist_title') = 'artist_title'
    else true end, false)
$$;

-- Leilão: p_meta agora traz também track_year (ano do álbum da faixa que
-- toca). "year" = menor ano encontrado no Deezer para a mesma música
-- (sem coletâneas, ao vivo, remix…). Sem ano confiável -> dica "artist".
create or replace function public.npl_auction_start(p_round public.npl_rounds, p_meta jsonb, p_now timestamptz)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_track public.npl_tracks;
  v_count int;
  v_prev text;
  v_hint text;
  v_genre text;
  v_year int;
  v_track_year int;
  v_order jsonb;
  v_n int;
  v_shift int;
  v_starts timestamptz := p_now + interval '5 seconds';  -- a dica aparece antes dos lances
begin
  select * into v_track from public.npl_tracks
   where room_id = p_round.room_id and match_no = p_round.match_no and position = p_round.round_no;

  -- rodadas de leilão anteriores nesta partida: alterna a dica e gira quem abre
  select count(*), (array_agg(x.auction->>'hint' order by x.round_no desc))[1]
    into v_count, v_prev
    from public.npl_rounds x
   where x.room_id = p_round.room_id and x.match_no = p_round.match_no
     and x.round_no < p_round.round_no and x.mode = 'auction' and x.auction ? 'hint';

  v_hint := case when v_prev = 'artist' then 'genre' else 'artist' end;
  v_genre := nullif(btrim(left(coalesce(p_meta->>'genre', ''), 60)), '');
  begin v_year := (p_meta->>'year')::int; exception when others then v_year := null; end;
  begin v_track_year := (p_meta->>'track_year')::int; exception when others then v_track_year := null; end;
  if v_track_year < 1900 or v_track_year > extract(year from p_now)::int + 1 then v_track_year := null; end if;
  if v_hint = 'genre' and (v_genre is null or v_year is null or v_year < 1900
       or v_year > extract(year from p_now)::int + 1
       or coalesce(p_meta->>'compilation', 'false') = 'true') then
    v_hint := 'artist';
  end if;

  select coalesce(jsonb_agg(to_jsonb(t.id::text) order by t.idx), '[]'::jsonb) into v_order
    from public.npl_teams t where t.room_id = p_round.room_id;
  v_n := jsonb_array_length(v_order);
  if v_n > 1 then
    v_shift := v_count % v_n;
    select jsonb_agg(e order by ((n - 1 - v_shift + v_n) % v_n)) into v_order
      from jsonb_array_elements(v_order) with ordinality as x(e, n);
  end if;

  return jsonb_build_object(
    'hint', v_hint,
    'artist', case when v_hint = 'artist' then v_track.artist end,
    'artists', case when v_hint = 'artist' then v_track.artists end,
    'genre', case when v_hint = 'genre' then v_genre end,
    'year', case when v_hint = 'genre' then v_year end,
    'track_year', case when v_hint = 'genre' then v_track_year end,
    'phase', 'bidding',
    'starts_at', v_starts,
    'order', v_order,
    'turn', v_order->>0,
    'turn_deadline', v_starts + interval '15 seconds',
    'low', 20,
    'low_team', null,
    'bids', '{}'::jsonb,
    'passes', '[]'::jsonb,
    'log', '[]'::jsonb,
    'queue', '[]'::jsonb,
    'qidx', 0,
    'played', -1,
    'winner', null);
end $$;

-- ---------------------------------------------------------------------
-- Início da partida: as músicas além de "rounds" ficam de reserva para
-- a morte súbita (posições total_rounds + 1, + 2, …).
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
  v_rounds int;
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
   where n <= 40;
  get diagnostics v_count = row_count;
  v_rounds := least(v_count, coalesce((v_room.settings->>'rounds')::int, v_count));

  update public.npl_players set active_from_round = 0, wants_rematch = false where room_id = v_room.id;
  update public.npl_rooms
     set match_no = v_match, round_no = 1, total_rounds = v_rounds,
         phase = 'playing', paused = false, paused_at = null, pause_reason = null
   where id = v_room.id;
  insert into public.npl_rounds (room_id, match_no, round_no, mode)
  values (v_room.id, v_match, 1, public.npl_pick_mode(v_room.settings));

  perform public.npl_recalc_scores(v_room.id);
  perform public.npl_touch(v_room.id, 'start');
  return jsonb_build_object('match_no', v_match, 'total_rounds', v_rounds, 'reserve', v_count - v_rounds);
end $$;

-- ---------------------------------------------------------------------
-- Próxima música. Depois da última: empate no 1º lugar + "Morte súbita"
-- -> rodada extra de desempate (clássico, só os empatados).
-- ---------------------------------------------------------------------
create or replace function public.npl_next_round(p_code text, p_owner_token text, p_from_round int)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.npl_rooms := public.npl_lock_room(p_code);
  v_round public.npl_rounds;
  v_teams jsonb := null;   -- não nulo = próxima rodada é de desempate (com estes times)
  v_n int := 0;
  v_top int;
begin
  perform public.npl_require_owner(v_room, p_owner_token);
  if v_room.phase <> 'playing' or v_room.round_no <> p_from_round then return; end if;
  select * into v_round from public.npl_rounds
   where room_id = v_room.id and match_no = v_room.match_no and round_no = v_room.round_no;
  if found and v_round.status not in ('revealed', 'scoreboard') then return; end if;
  perform public.npl_set_paused(v_room, false, null);

  if found and public.npl_is_tiebreak(v_round) then
    -- desempate decidido (acertou ou sobrou um só)? fim. Senão, mais uma música
    -- com quem ainda está no páreo.
    if v_round.winner_team_id is null and v_round.tiebreak->>'survivor' is null
       and jsonb_array_length(public.npl_tiebreak_left(v_round)) >= 2 then
      v_teams := public.npl_tiebreak_left(v_round);
      v_n := coalesce((v_round.tiebreak->>'n')::int, 1);
    end if;
  elsif v_room.round_no >= v_room.total_rounds and v_room.settings->>'tiebreak' = 'sudden' then
    -- fim da última música: empate no 1º lugar -> morte súbita
    perform public.npl_recalc_scores(v_room.id);
    select max(score) into v_top from public.npl_teams where room_id = v_room.id;
    select jsonb_agg(to_jsonb(id::text) order by idx) into v_teams
      from public.npl_teams where room_id = v_room.id and score = v_top;
    if jsonb_array_length(coalesce(v_teams, '[]'::jsonb)) < 2 then v_teams := null; end if;
  end if;

  if v_teams is not null then
    -- precisa de uma música reserva que ainda não saiu
    if exists (select 1 from public.npl_tracks
                where room_id = v_room.id and match_no = v_room.match_no and position = v_room.round_no + 1) then
      update public.npl_rooms set round_no = round_no + 1 where id = v_room.id;
      insert into public.npl_rounds (room_id, match_no, round_no, mode, tiebreak)
      values (v_room.id, v_room.match_no, v_room.round_no + 1, 'classic',
              jsonb_build_object('teams', v_teams, 'out', '[]'::jsonb, 'survivor', null, 'n', v_n + 1));
      perform public.npl_touch(v_room.id, 'sudden');
      return;
    end if;
    -- acabaram as reservas: fica o empate
  end if;

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
-- EU SEI!: no desempate só os times que ainda estão no páreo
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
  v_lock jsonb;
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
  if v_round.mode = 'auction' then
    if v_expired then perform public.npl_touch(v_room.id, 'timeout'); end if;
    return jsonb_build_object('ok', false, 'reason', 'auction');
  end if;
  if v_player.active_from_round > v_round.round_no then
    if v_expired then perform public.npl_touch(v_room.id, 'timeout'); end if;
    return jsonb_build_object('ok', false, 'reason', 'not_yet');
  end if;
  -- desempate: só os times empatados que ainda não erraram
  if public.npl_is_tiebreak(v_round)
     and not (public.npl_tiebreak_left(v_round) ? v_player.team_id::text) then
    if v_expired then perform public.npl_touch(v_room.id, 'timeout'); end if;
    return jsonb_build_object('ok', false, 'reason', 'tiebreak');
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

  -- bloqueio depois de um erro (aguardando a música ou contagem correndo)
  v_lock := v_round.locks->v_player.team_id::text;
  if public.npl_lock_active(v_lock, v_now) then
    if v_expired then perform public.npl_touch(v_room.id, 'timeout'); end if;
    return jsonb_build_object('ok', false, 'reason', 'locked', 'until', v_lock->'until');
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
-- Pontuação: rodada de desempate não vale pontos (só define o 1º lugar)
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
  v_need_art boolean;
  v_need_tit boolean;
  v_done boolean := false;
  v_win uuid;
  a public.npl_attempts;
begin
  select * into v_round from public.npl_rounds where id = p_round_id;
  select * into v_room from public.npl_rooms where id = v_round.room_id;
  select * into v_track from public.npl_tracks
   where room_id = v_round.room_id and match_no = v_round.match_no and position = v_round.round_no;
  v_scoring := coalesce(v_room.settings->>'scoring', 'artist_title');
  v_pen := coalesce((v_room.settings->>'penalty')::int, 0);

  -- desempate: o primeiro que acertar a música vence; nada entra no placar
  if public.npl_is_tiebreak(v_round) then
    for a in select * from public.npl_attempts
              where round_id = p_round_id and kind = 'turn' and status in ('correct', 'wrong', 'timeout')
              order by created_at
    loop
      if not v_done and a.title_result = 'ok' then
        v_done := true;
        v_win := a.team_id;
      end if;
      if a.points <> 0 then
        update public.npl_attempts set points = 0 where id = a.id;
      end if;
    end loop;
    update public.npl_rounds
       set artist_team_id = null,
           title_team_id = v_win,
           winner_team_id = v_win,
           points = 0,
           found = case when v_done then jsonb_build_object('title', v_track.title) else '{}'::jsonb end
     where id = p_round_id;
    return v_done;
  end if;

  if v_round.mode = 'auction' then
    v_need_art := public.npl_part_counts(v_round, v_scoring, 'artist');
    v_need_tit := public.npl_part_counts(v_round, v_scoring, 'title');
    for a in select * from public.npl_attempts
              where round_id = p_round_id and kind = 'turn' and status in ('correct', 'wrong', 'timeout')
              order by created_at
    loop
      v_final := 0;
      if not v_done and ((v_need_art and a.artist_result = 'ok') or (v_need_tit and a.title_result = 'ok')) then
        v_final := 100;
        v_done := true;
        v_win := a.team_id;
      end if;
      if v_final is distinct from a.points then
        update public.npl_attempts set points = v_final where id = a.id;
      end if;
    end loop;
    update public.npl_rounds
       set artist_team_id = case when v_need_art then v_win end,
           title_team_id = case when v_need_tit then v_win end,
           winner_team_id = v_win,
           points = case when v_done then 100 else 0 end,
           found = case when v_done then jsonb_strip_nulls(jsonb_build_object(
                     'artist', case when v_need_art then v_track.artist end,
                     'title', case when v_need_tit then v_track.title end))
                   else '{}'::jsonb end
     where id = p_round_id;
    return v_done;
  end if;

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

-- ---------------------------------------------------------------------
-- Fecha a tentativa. Desempate: errou/tempo esgotado -> fora do desempate.
-- ---------------------------------------------------------------------
create or replace function public.npl_finalize_attempt(p_attempt_id uuid, p_status_if_wrong text, p_decided_by text)
returns text
language plpgsql
set search_path = public
as $$
declare
  v_att public.npl_attempts;
  v_round public.npl_rounds;
  v_ok boolean;
  v_err boolean;
  v_complete boolean;
  v_next int;
  v_out jsonb;
  v_left jsonb;
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
  select * into v_round from public.npl_rounds where id = v_att.round_id;
  if v_complete then
    update public.npl_attempts set status = 'cancelled', points = 0
     where round_id = v_att.round_id and status in ('open', 'doubt') and id <> v_att.id;
    perform public.npl_reveal_round(v_att.round_id, false);
  elsif public.npl_is_tiebreak(v_round) then
    -- desempate: quem errou está fora (sem bloqueio por tempo); se sobrar um só, ele vence
    v_out := coalesce(v_round.tiebreak->'out', '[]'::jsonb);
    if v_att.team_id is not null and not (v_out ? v_att.team_id::text) then
      v_out := v_out || jsonb_build_array(v_att.team_id::text);
    end if;
    update public.npl_rounds
       set tiebreak = tiebreak || jsonb_build_object('out', v_out)
     where id = v_att.round_id
    returning * into v_round;
    v_left := public.npl_tiebreak_left(v_round);
    if jsonb_array_length(v_left) <= 1 then
      update public.npl_rounds
         set tiebreak = tiebreak || jsonb_build_object('survivor', v_left->0)
       where id = v_att.round_id;
      perform public.npl_reveal_round(v_att.round_id, false);
    else
      update public.npl_rounds
         set status = 'playing', current_attempt_id = null, had_error = true, locks = '{}'::jsonb
       where id = v_att.round_id;
    end if;
  elsif v_round.mode = 'auction' then
    v_next := coalesce((v_round.auction->>'qidx')::int, 0) + 1;
    if v_next >= jsonb_array_length(coalesce(v_round.auction->'queue', '[]'::jsonb)) then
      perform public.npl_reveal_round(v_att.round_id, false);   -- todos erraram: revela sem pontos
    else
      update public.npl_rounds
         set status = 'playing', current_attempt_id = null, had_error = true,
             auction = jsonb_set(auction, '{qidx}', to_jsonb(v_next))
       where id = v_att.round_id;
    end if;
  else
    -- volta a esperar (tocar / repetir / próximo trecho). Quem errou fica bloqueado;
    -- a contagem só começa quando a música voltar a tocar (npl_play).
    update public.npl_rounds r
       set status = 'playing', current_attempt_id = null,
           locks = case when v_err then jsonb_build_object(v_att.team_id::text, jsonb_build_object(
                     'secs', coalesce((select (settings->>'lockSeconds')::int from public.npl_rooms
                                        where id = v_att.room_id), 15),
                     'started_at', null,
                     'until', null))
                   else r.locks end,
           had_error = had_error or v_err
     where id = v_att.round_id;
  end if;
  perform public.npl_recalc_scores(v_att.room_id);
  return case when v_complete then 'correct'
              when v_ok and v_round.mode <> 'auction' then 'partial'
              else p_status_if_wrong end;
end $$;


revoke execute on function
  public.npl_clean_settings(jsonb),
  public.npl_is_tiebreak(public.npl_rounds),
  public.npl_tiebreak_left(public.npl_rounds),
  public.npl_part_counts(public.npl_rounds, text, text),
  public.npl_auction_start(public.npl_rounds, jsonb, timestamptz),
  public.npl_rescore_round(uuid),
  public.npl_finalize_attempt(uuid, text, text)
  from public, anon, authenticated;
