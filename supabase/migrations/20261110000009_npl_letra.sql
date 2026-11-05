-- =====================================================================
-- Musicalizando — 009: modo "Só pela letra".
-- Aplicar DEPOIS das migrações 001–008. Pode rodar mais de uma vez.
--
-- A rota do Next busca as letras (LRCLIB) ao montar a lista e já manda os
-- trechos prontos em p_tracks[i].lyrics = {masked: [[linha, linha], …],
-- plain: [[…], …]} (masked = título/artista trocados por "___"; o último
-- trecho é o refrão). Fica em npl_tracks.lyrics, que os clientes NÃO leem.
--
-- npl_rounds.lyrics ({} fora do modo) é o que todo mundo vê:
--   total   quantos trechos a música tem (3 a 5)
--   shown   trechos já revelados (masked), em ordem
--   plain   só depois da revelação: os trechos sem "___"
-- Pontos pelo nº de trechos revelados no EU SEI!: 100, 75, 50, 30, 15.
-- "Próximo verso" = npl_play(p_advance = true); o bloqueio após erro começa
-- a contar quando o próximo verso aparece.
-- =====================================================================

alter table public.npl_tracks add column if not exists lyrics jsonb;
alter table public.npl_rounds add column if not exists lyrics jsonb not null default '{}'::jsonb;

-- Pontos do modo letra
create or replace function public.npl_stage_count(p_mode text)
returns int
language sql immutable
set search_path = public
as $$ select case p_mode when 'lyrics' then 5 else 6 end $$;

create or replace function public.npl_stage_points(p_mode text, p_stage int)
returns int
language sql immutable
set search_path = public
as $$
  select case p_mode
    when 'lyrics' then (array[100, 75, 50, 30, 15])[greatest(1, least(5, p_stage))]
    else (array[100, 80, 60, 40, 25, 10])[greatest(1, least(6, p_stage))]
  end
$$;

-- Modo da rodada: sorteia como antes, mas música sem letra não cai no modo letra
create or replace function public.npl_round_mode(p_room_id uuid, p_match int, p_pos int, p_settings jsonb)
returns text
language plpgsql volatile
set search_path = public
as $$
declare
  v_mode text := public.npl_pick_mode(p_settings);
  v_others text[];
begin
  if v_mode = 'lyrics' and not exists (
       select 1 from public.npl_tracks
        where room_id = p_room_id and match_no = p_match and position = p_pos
          and jsonb_typeof(lyrics->'masked') = 'array' and jsonb_array_length(lyrics->'masked') >= 3) then
    select array_agg(m) into v_others
      from jsonb_array_elements_text(coalesce(p_settings->'modePool', '[]'::jsonb)) as m
     where m <> 'lyrics';
    v_mode := coalesce(v_others[1 + floor(random() * coalesce(cardinality(v_others), 0))::int], 'classic');
  end if;
  return v_mode;
end $$;

-- Limpa trechos vindos do cliente: até 5 trechos, até 4 linhas de até 200 caracteres
create or replace function public.npl_clean_verses(p jsonb)
returns jsonb
language sql immutable
set search_path = public
as $$
  select coalesce(jsonb_agg(
           coalesce((select jsonb_agg(to_jsonb(left(l #>> '{}', 200)) order by m)
                       from jsonb_array_elements(case when jsonb_typeof(seg) = 'array' then seg else '[]'::jsonb end)
                            with ordinality as y(l, m)
                      where jsonb_typeof(l) = 'string' and m <= 4), '[]'::jsonb)
           order by n), '[]'::jsonb)
    from jsonb_array_elements(p) with ordinality as x(seg, n)
   where n <= 5
$$;

-- Trechos que a rodada mostra: total + os primeiros p_n trechos (masked)
create or replace function public.npl_lyrics_view(p_track public.npl_tracks, p_n int)
returns jsonb
language sql immutable
set search_path = public
as $$
  select jsonb_build_object(
    'total', jsonb_array_length(p_track.lyrics->'masked'),
    'shown', coalesce((select jsonb_agg(e order by n) from jsonb_array_elements(p_track.lyrics->'masked')
                        with ordinality as x(e, n) where n <= p_n), '[]'::jsonb))
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
  if coalesce(s->>'mode', '') not in ('classic', 'auction', 'lyrics') then
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
            where jsonb_typeof(e) = 'string' and e #>> '{}' in ('classic', 'auction', 'lyrics')
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


drop function if exists public.npl_start_match(text, text, jsonb);
-- p_rounds: quantas rodadas jogar (null = a configuração). No modo letra a TV
-- manda menos quando não achou letra para todas ("Só encontramos X…").
create or replace function public.npl_start_match(p_code text, p_owner_token text, p_tracks jsonb,
                                                  p_rounds int default null)
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

  insert into public.npl_tracks (room_id, match_no, position, deezer_id, title, title_short, artist, artists, cover, album, lyrics)
  select v_room.id, v_match, n::int,
         (e->>'deezer_id')::bigint,
         left(coalesce(e->>'title', '?'), 300),
         left(e->>'title_short', 300),
         left(coalesce(e->>'artist', '?'), 300),
         case when jsonb_typeof(e->'artists') = 'array' then e->'artists'
              else jsonb_build_array(coalesce(e->>'artist', '?')) end,
         left(e->>'cover', 500),
         left(e->>'album', 300),
         case when jsonb_typeof(e->'lyrics'->'masked') = 'array' and jsonb_typeof(e->'lyrics'->'plain') = 'array'
                   and jsonb_array_length(e->'lyrics'->'masked') between 3 and 5
                   and jsonb_array_length(e->'lyrics'->'plain') = jsonb_array_length(e->'lyrics'->'masked')
              then jsonb_build_object('masked', public.npl_clean_verses(e->'lyrics'->'masked'),
                                      'plain', public.npl_clean_verses(e->'lyrics'->'plain')) end
    from jsonb_array_elements(p_tracks) with ordinality as x(e, n)
   where n <= 40;
  get diagnostics v_count = row_count;
  v_rounds := least(v_count, greatest(1, coalesce(p_rounds, (v_room.settings->>'rounds')::int, v_count)));

  update public.npl_players set active_from_round = 0, wants_rematch = false where room_id = v_room.id;
  update public.npl_rooms
     set match_no = v_match, round_no = 1, total_rounds = v_rounds,
         phase = 'playing', paused = false, paused_at = null, pause_reason = null
   where id = v_room.id;
  insert into public.npl_rounds (room_id, match_no, round_no, mode)
  values (v_room.id, v_match, 1, public.npl_round_mode(v_room.id, v_match, 1, v_room.settings));

  perform public.npl_recalc_scores(v_room.id);
  perform public.npl_touch(v_room.id, 'start');
  return jsonb_build_object('match_no', v_match, 'total_rounds', v_rounds, 'reserve', v_count - v_rounds);
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
  values (v_room.id, v_room.match_no, v_room.round_no + 1,
          public.npl_round_mode(v_room.id, v_room.match_no, v_room.round_no + 1, v_room.settings));
  perform public.npl_touch(v_room.id, 'next');
end $$;


-- A TV carregou o áudio (a prévia toca na revelação): abre a rodada.
-- Modo letra: o 1º verso já aparece. Sem letra guardada -> vira clássico.
create or replace function public.npl_round_begin(p_code text, p_owner_token text, p_round_id uuid,
                                                  p_artists jsonb default '[]'::jsonb,
                                                  p_offsets jsonb default '[]'::jsonb,
                                                  p_meta jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.npl_rooms := public.npl_lock_room(p_code);
  v_round public.npl_rounds;
  v_offsets jsonb := '[]'::jsonb;
  v_auction jsonb := '{}'::jsonb;
  v_lyrics jsonb := '{}'::jsonb;
  v_track public.npl_tracks;
  v_now timestamptz := clock_timestamp();
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

  if v_round.mode = 'auction' then
    v_auction := public.npl_auction_start(v_round,
                   case when jsonb_typeof(p_meta) = 'object' then p_meta else '{}'::jsonb end, v_now);
  end if;

  if v_round.mode = 'lyrics' then
    select * into v_track from public.npl_tracks
     where room_id = v_room.id and match_no = v_round.match_no and position = v_round.round_no;
    if jsonb_typeof(v_track.lyrics->'masked') = 'array' and jsonb_array_length(v_track.lyrics->'masked') >= 3 then
      v_lyrics := public.npl_lyrics_view(v_track, 1);
    else
      v_round.mode := 'classic';
    end if;
  end if;

  update public.npl_rounds
     set status = 'playing', stage = 1, stage_started_at = v_now, started_at = now(),
         offsets = v_offsets, play_seq = 0,
         played_stage = case when v_round.mode = 'lyrics' then 1 else 0 end,
         play_at = case when v_round.mode = 'lyrics' then v_now end,
         auction = v_auction, lyrics = v_lyrics, mode = v_round.mode
   where id = v_round.id
  returning * into v_round;
  perform public.npl_touch(v_room.id, 'round');
  return to_jsonb(v_round);
end $$;


-- Tocar/Repetir/Próximo trecho. Modo letra: só "Próximo verso" (p_advance),
-- que revela o próximo trecho e começa a contar o bloqueio.
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
  v_track public.npl_tracks;
  v_now timestamptz;
  v_lyrics boolean;
  v_last int;
begin
  perform public.npl_require_owner(v_room, p_owner_token);
  select * into v_round from public.npl_rounds where id = p_round_id and room_id = v_room.id for update;
  if not found then raise exception 'npl:round_not_found'; end if;
  v_lyrics := v_round.mode = 'lyrics';
  v_last := case when v_lyrics then coalesce((v_round.lyrics->>'total')::int, 0)
                 else public.npl_stage_count(v_round.mode) end;
  if v_room.paused or v_round.status <> 'playing' or v_round.stage <> p_stage or v_round.mode = 'auction'
     or (v_lyrics and not coalesce(p_advance, false))
     or (coalesce(p_advance, false) and v_round.stage >= v_last) then
    return jsonb_build_object('ok', false, 'round', to_jsonb(v_round));
  end if;
  v_now := clock_timestamp();
  if v_lyrics then
    select * into v_track from public.npl_tracks
     where room_id = v_room.id and match_no = v_round.match_no and position = v_round.round_no;
    update public.npl_rounds set lyrics = public.npl_lyrics_view(v_track, v_round.stage + 1) where id = v_round.id;
  end if;
  update public.npl_rounds
     set stage = stage + case when coalesce(p_advance, false) then 1 else 0 end,
         played_stage = stage + case when coalesce(p_advance, false) then 1 else 0 end,
         play_seq = play_seq + 1,
         play_at = v_now,
         stage_started_at = v_now,
         locks = public.npl_locks_start(locks, v_now)
   where id = v_round.id
  returning * into v_round;
  perform public.npl_touch(v_room.id, 'play', jsonb_build_object('seq', v_round.play_seq));
  return jsonb_build_object('ok', true, 'round', to_jsonb(v_round));
end $$;


-- Revela a música (e, no modo letra, os trechos sem "___")
create or replace function public.npl_reveal_round(p_round_id uuid, p_skipped boolean default false)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_round public.npl_rounds;
  v_track public.npl_tracks;
begin
  select * into v_round from public.npl_rounds where id = p_round_id;
  select * into v_track from public.npl_tracks
   where room_id = v_round.room_id and match_no = v_round.match_no and position = v_round.round_no;
  update public.npl_rounds
     set status = 'revealed',
         skipped = p_skipped,
         current_attempt_id = null,
         revealed_at = now(),
         reveal = jsonb_build_object(
           'deezer_id', v_track.deezer_id,
           'title', v_track.title,
           'artist', v_track.artist,
           'artists', v_track.artists,
           'cover', v_track.cover,
           'album', v_track.album),
         -- modo letra: os trechos sem "___" só aparecem agora
         lyrics = case when v_round.mode = 'lyrics' and v_round.lyrics ? 'total'
                       then v_round.lyrics || jsonb_build_object('plain', coalesce(v_track.lyrics->'plain', '[]'::jsonb))
                       else v_round.lyrics end
   where id = p_round_id;
end $$;


revoke execute on function
  public.npl_clean_settings(jsonb),
  public.npl_round_mode(uuid, int, int, jsonb),
  public.npl_lyrics_view(public.npl_tracks, int),
  public.npl_clean_verses(jsonb),
  public.npl_reveal_round(uuid, boolean)
  from public, anon, authenticated;
