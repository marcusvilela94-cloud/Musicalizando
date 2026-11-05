-- =====================================================================
-- Musicalizando — 013: modo "Continuar a letra".
-- Aplicar DEPOIS das migrações 001–012. Pode rodar mais de uma vez.
--
-- Quem monta a partida analisa cada música (LRCLIB com syncedLyrics + Groq,
-- como em /lab/sync), escolhe a linha escondida e manda em p_tracks[i].cont:
--   {lines: [{text, start, end}, …]  linhas antes da escondida (2 a 4), em ordem,
--    hidden: {text, start, end}}     tempos em segundos da PRÉVIA
-- Fica em npl_tracks.cont (os clientes NÃO leem). npl_rounds.cont mostra:
--   title/artist/artists  (a TV mostra desde o início)
--   lines   as últimas ctx linhas de contexto (texto + início)
--   hidden  {words: nº de palavras, start}   (sem o texto!)
--   ctx     2 | 3 | 4 linhas de contexto (estágio 1 | 2 | 3 = 100 | 70 | 40)
--   max     quantos estágios esta música tem
--   reveal  só na revelação: {text, start, end} da linha escondida
-- Resposta digitada: palavras certas na ordem >= 70% = acerto; 50–70% =
-- "Quase!"; menos = erro. "O que vale" e penalidade não se aplicam.
-- =====================================================================

alter table public.npl_tracks add column if not exists cont jsonb;
alter table public.npl_rounds add column if not exists cont jsonb not null default '{}'::jsonb;

-- Limpa o que veio do cliente (números, textos curtos, 2 a 4 linhas de contexto)
create or replace function public.npl_clean_cont(p jsonb)
returns jsonb
language plpgsql immutable
set search_path = public
as $$
declare
  v_lines jsonb;
  v_h jsonb := p->'hidden';
begin
  if jsonb_typeof(p) <> 'object' or jsonb_typeof(p->'lines') <> 'array' or jsonb_typeof(v_h) <> 'object'
     or jsonb_typeof(v_h->'start') <> 'number' or jsonb_typeof(v_h->'end') <> 'number'
     or coalesce(btrim(v_h->>'text'), '') = '' then
    return null;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('text', left(e->>'text', 200),
                                               'start', (e->>'start')::numeric,
                                               'end', (e->>'end')::numeric) order by n), '[]'::jsonb)
    into v_lines
    from jsonb_array_elements(p->'lines') with ordinality as x(e, n)
   where n <= 4 and jsonb_typeof(e->'start') = 'number' and jsonb_typeof(e->'end') = 'number'
     and coalesce(btrim(e->>'text'), '') <> '';
  if jsonb_array_length(v_lines) < 2 then return null; end if;
  return jsonb_build_object('lines', v_lines,
    'hidden', jsonb_build_object('text', left(v_h->>'text', 200),
                                 'start', (v_h->>'start')::numeric, 'end', (v_h->>'end')::numeric));
end $$;

-- O que a rodada mostra com p_ctx linhas de contexto (sem o texto da linha escondida)
create or replace function public.npl_cont_view(p_track public.npl_tracks, p_ctx int)
returns jsonb
language sql immutable
set search_path = public
as $$
  with l as (
    select e, n, jsonb_array_length(p_track.cont->'lines') as total
      from jsonb_array_elements(p_track.cont->'lines') with ordinality as x(e, n)
  )
  select jsonb_build_object(
    -- neste modo a TV mostra música e artista desde o início
    'title', coalesce(p_track.title_short, p_track.title),
    'artist', p_track.artist,
    'artists', p_track.artists,
    'ctx', least(greatest(p_ctx, 2), max(total)),
    'max', least(3, max(total) - 1),
    'lines', coalesce(jsonb_agg(jsonb_build_object('text', e->>'text', 'start', e->'start') order by n)
                        filter (where n > total - least(greatest(p_ctx, 2), total)), '[]'::jsonb),
    'hidden', jsonb_build_object(
      'start', p_track.cont->'hidden'->'start',
      'words', coalesce(array_length(regexp_split_to_array(btrim(p_track.cont->'hidden'->>'text'), '\s+'), 1), 0)))
  from l
$$;

-- Confere a linha: palavras certas NA ORDEM (LCS tolerante a erro de digitação)
create or replace function public.npl_classify_line(p_answer text, p_target text)
returns text
language plpgsql immutable
set search_path = public
as $$
declare
  a text[];
  b text[];
  n int;
  m int;
  dp int[];
  prev int[];
  i int;
  j int;
  ok boolean;
  ratio numeric;
  norm_line text;
begin
  a := regexp_split_to_array(btrim(regexp_replace(lower(translate(coalesce(p_answer, ''),
         'ÁÀÂÃÄÅáàâãäåÉÈÊËéèêëÍÌÎÏíìîïÓÒÔÕÖØóòôõöøÚÙÛÜúùûüÇçÑñÝýÿ',
         'AAAAAAaaaaaaEEEEeeeeIIIIiiiiOOOOOOooooooUUUUuuuuCcNnYyy')), '[^a-z0-9]+', ' ', 'g')), ' ');
  norm_line := btrim(regexp_replace(lower(translate(regexp_replace(coalesce(p_target, ''), '[''’`´]', '', 'g'),
         'ÁÀÂÃÄÅáàâãäåÉÈÊËéèêëÍÌÎÏíìîïÓÒÔÕÖØóòôõöøÚÙÛÜúùûüÇçÑñÝýÿ',
         'AAAAAAaaaaaaEEEEeeeeIIIIiiiiOOOOOOooooooUUUUuuuuCcNnYyy')), '[^a-z0-9]+', ' ', 'g'));
  b := regexp_split_to_array(norm_line, ' ');
  a := array(select x from unnest(a) as x where x <> '');
  b := array(select x from unnest(b) as x where x <> '');
  n := coalesce(cardinality(a), 0);
  m := coalesce(cardinality(b), 0);
  if n = 0 then return 'empty'; end if;
  if m = 0 then return 'wrong'; end if;
  -- apóstrofo da resposta também sai ("don't" = "dont")
  a := array(select regexp_replace(x, '[''’`´]', '', 'g') from unnest(a) as x);
  prev := array_fill(0, array[m + 1]);
  for i in 1..n loop
    dp := array_fill(0, array[m + 1]);
    for j in 1..m loop
      ok := a[i] = b[j]
            or (length(b[j]) >= 4 and public.npl_levenshtein(a[i], b[j]) <= greatest(1, length(b[j]) / 4));
      dp[j + 1] := case when ok then prev[j] + 1 else greatest(prev[j + 1], dp[j]) end;
    end loop;
    prev := dp;
  end loop;
  ratio := prev[m + 1]::numeric / m;
  return case when ratio >= 0.7 then 'ok' when ratio >= 0.5 then 'doubt' else 'wrong' end;
end $$;

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
  -- ordem dos modos quando há 2 ou mais ligados
  if coalesce(s->>'modeOrder', '') not in ('alternate', 'random', 'blocks') then
    s := jsonb_set(s, '{modeOrder}', '"alternate"');
  end if;
  if coalesce(s->>'theme', '') not in ('party', 'neon', 'retro', 'beach', 'xmas') then
    s := jsonb_set(s, '{theme}', '"party"');
  end if;
  if coalesce(s->>'teamMode', '') not in ('teams', 'solo') then
    s := jsonb_set(s, '{teamMode}', '"teams"');
  end if;
  -- modos de jogo conhecidos
  if coalesce(s->>'mode', '') not in ('classic', 'auction', 'lyrics', 'continue') then
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
            where jsonb_typeof(e) = 'string' and e #>> '{}' in ('classic', 'auction', 'lyrics', 'continue')
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

create or replace function public.npl_stage_count(p_mode text)
returns int
language sql immutable
set search_path = public
as $$ select case p_mode when 'lyrics' then 5 when 'continue' then 3 else 6 end $$;

create or replace function public.npl_stage_points(p_mode text, p_stage int)
returns int
language sql immutable
set search_path = public
as $$
  select case p_mode
    when 'lyrics' then (array[100, 75, 50, 30, 15])[greatest(1, least(5, p_stage))]
    when 'continue' then (array[100, 70, 40])[greatest(1, least(3, p_stage))]
    else (array[100, 80, 60, 40, 25, 10])[greatest(1, least(6, p_stage))]
  end
$$;

create or replace function public.npl_round_mode(p_room_id uuid, p_match int, p_pos int, p_settings jsonb)
returns text
language plpgsql volatile
set search_path = public
as $$
declare
  v_track public.npl_tracks;
  v_mode text;
  v_others text[];
begin
  select * into v_track from public.npl_tracks
   where room_id = p_room_id and match_no = p_match and position = p_pos;
  v_mode := coalesce(v_track.mode, public.npl_pick_mode(p_settings));
  if v_mode = 'continue' and not coalesce(jsonb_typeof(v_track.cont->'lines') = 'array'
                                           and jsonb_array_length(v_track.cont->'lines') >= 2, false) then
    select array_agg(m) into v_others
      from jsonb_array_elements_text(coalesce(p_settings->'modePool', '[]'::jsonb)) as m
     where m not in ('continue', 'lyrics');
    v_mode := coalesce(v_others[1 + floor(random() * coalesce(cardinality(v_others), 0))::int], 'classic');
  end if;
  if v_mode = 'lyrics' and not coalesce(jsonb_typeof(v_track.lyrics->'masked') = 'array'
                                         and jsonb_array_length(v_track.lyrics->'masked') >= 3, false) then
    select array_agg(m) into v_others
      from jsonb_array_elements_text(coalesce(p_settings->'modePool', '[]'::jsonb)) as m
     where m <> 'lyrics';
    v_mode := coalesce(v_others[1 + floor(random() * coalesce(cardinality(v_others), 0))::int], 'classic');
  end if;
  return v_mode;
end $$;

drop function if exists public.npl_start_match(text, text, jsonb);
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

  insert into public.npl_tracks (room_id, match_no, position, deezer_id, title, title_short, artist, artists, cover, album, lyrics, mode, cont)
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
                                      'plain', public.npl_clean_verses(e->'lyrics'->'plain')) end,
         -- modo planejado para esta posição (só se for um dos modos ligados)
         case when e->>'mode' in ('classic', 'auction', 'lyrics', 'continue')
                   and coalesce(v_room.settings->'modePool', '[]'::jsonb) ? (e->>'mode')
              then e->>'mode' end,
         public.npl_clean_cont(e->'cont')
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
  v_cont jsonb := '{}'::jsonb;
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

  if v_round.mode = 'continue' then
    select * into v_track from public.npl_tracks
     where room_id = v_room.id and match_no = v_round.match_no and position = v_round.round_no;
    if jsonb_typeof(v_track.cont->'lines') = 'array' and jsonb_array_length(v_track.cont->'lines') >= 2 then
      v_cont := public.npl_cont_view(v_track, 2);
    else
      v_round.mode := 'classic';
    end if;
  end if;

  update public.npl_rounds
     set status = 'playing', stage = 1, stage_started_at = v_now, started_at = now(),
         offsets = v_offsets, play_seq = 0,
         played_stage = case when v_round.mode = 'lyrics' then 1 else 0 end,
         play_at = case when v_round.mode = 'lyrics' then v_now end,
         auction = v_auction, lyrics = v_lyrics, cont = v_cont, mode = v_round.mode
   where id = v_round.id
  returning * into v_round;
  perform public.npl_touch(v_room.id, 'round');
  return to_jsonb(v_round);
end $$;

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
                 when v_round.mode = 'continue' then coalesce((v_round.cont->>'max')::int, 1)
                 else public.npl_stage_count(v_round.mode) end;
  if v_room.paused or v_round.status <> 'playing' or v_round.stage <> p_stage or v_round.mode = 'auction'
     or (v_lyrics and not coalesce(p_advance, false))
     or (coalesce(p_advance, false) and v_round.stage >= v_last) then
    return jsonb_build_object('ok', false, 'round', to_jsonb(v_round));
  end if;
  v_now := clock_timestamp();
  if v_round.mode = 'continue' and coalesce(p_advance, false) then
    -- "Mais contexto": começa uma linha mais cedo
    select * into v_track from public.npl_tracks
     where room_id = v_room.id and match_no = v_round.match_no and position = v_round.round_no;
    update public.npl_rounds set cont = public.npl_cont_view(v_track, v_round.stage + 2) where id = v_round.id;
  end if;
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
                       else v_round.lyrics end,
         -- continuar a letra: a linha escondida (com início e fim) só aparece agora
         cont = case when v_round.mode = 'continue' and v_round.cont ? 'hidden'
                     then v_round.cont || jsonb_build_object('reveal', v_track.cont->'hidden')
                     else v_round.cont end
   where id = p_round_id;
end $$;

create or replace function public.npl_part_counts(p_round public.npl_rounds, p_scoring text, p_part text)
returns boolean
language sql immutable
set search_path = public
as $$
  select coalesce(case
    when public.npl_is_tiebreak(p_round) then p_part = 'title'
    when p_round.mode = 'continue' then p_part = 'title'
    when p_round.mode = 'auction' then
      case when p_part = 'artist' then p_round.auction->>'hint' = 'genre'
           else p_round.auction->>'hint' = 'artist' end
    when p_part = 'artist' then coalesce(p_scoring, 'artist_title') = 'artist_title'
    else true end, false)
$$;

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
  -- continuar a letra: vale só a linha ("O que vale" e penalidade não se aplicam)
  if v_round.mode = 'continue' then
    v_scoring := 'title';
    v_pen := 0;
  end if;

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

  v_need_artist := public.npl_part_counts(v_round, v_scoring, 'artist') and not (v_round.found ? 'artist');
  v_need_title := public.npl_part_counts(v_round, v_scoring, 'title') and not (v_round.found ? 'title');
  v_artist_res := case when v_need_artist then public.npl_classify(p_artist,
                    array(select jsonb_array_elements_text(v_track.artists)) || v_track.artist, false)
                  else 'empty' end;
  v_title_res := case when not v_need_title then 'empty'
                      when v_round.mode = 'continue' then public.npl_classify_line(p_title, v_track.cont->'hidden'->>'text')
                      else public.npl_classify(p_title,
                             array[v_track.title, coalesce(v_track.title_short, v_track.title)], true) end;

  if v_artist_res = 'empty' and v_title_res = 'empty' then
    return jsonb_build_object('ok', false, 'reason', 'empty');
  end if;

  update public.npl_attempts
     set answer_artist = case when v_need_artist then nullif(left(btrim(coalesce(p_artist, '')), 120), '') end,
         answer_title = case when v_need_title then nullif(left(btrim(coalesce(p_title, '')), 200), '') end,
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
                            'artists', v_track.artists,
                            'line', case when v_round.mode = 'continue' then v_track.cont->'hidden'->>'text' end);
end $$;

revoke execute on function
  public.npl_clean_settings(jsonb),
  public.npl_clean_cont(jsonb),
  public.npl_cont_view(public.npl_tracks, int),
  public.npl_classify_line(text, text),
  public.npl_round_mode(uuid, int, int, jsonb),
  public.npl_reveal_round(uuid, boolean),
  public.npl_part_counts(public.npl_rounds, text, text),
  public.npl_rescore_round(uuid)
  from public, anon, authenticated;
