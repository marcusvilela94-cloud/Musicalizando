-- =====================================================================
-- Musicalizando — 018: modo "Qual é a obra?" (pacotes temáticos).
-- Aplicar DEPOIS da 017. Pode rodar mais de uma vez.
--
-- Joga como o Clássico (trechos, EU SEI!, bloqueio, penalidade, Formato da
-- vez), mas a resposta é a OBRA (filme, anime, novela). A música vem dos
-- pacotes (data/pacotes-resolvidos.json), escolhida por quem começa a partida:
--   p_tracks[i].mode = 'obra' e p_tracks[i].quiz = {kind: 'obra', q, answer
--   (a obra), accept (nomes aceitos), pack, emoji, tipo (novelas)}.
-- npl_tracks.quiz guarda tudo (oculto); npl_rounds.quiz mostra só o pacote
-- ({kind, q, pack, emoji}); a obra (e o tipo) aparecem na revelação.
-- settings.obraPacks = pacotes ligados (cinema | anime | novelas).
-- =====================================================================

create or replace function public.npl_default_settings()
returns jsonb
language sql immutable
set search_path = public
as $$
  select jsonb_build_object(
    'mode', 'classic',
    'modeSelection', 'fixed',
    'modePool', jsonb_build_array('classic'),
    'modeOrder', 'alternate',       -- com 2+ modos: alternate | random | blocks
    'rounds', 10,
    'answerSeconds', 20,
    'penalty', 0,
    'scoring', 'artist_title',
    'roomStyle', 'all',
    'answerMode', 'spoken',
    'lockSeconds', 15,
    'sounds', true,
    'sfxVolume', 'high',
    'clipMode', 'sequence',
    'tiebreak', 'sudden',
    'versionFilter', true,
    'theme', 'party',               -- visual: party | neon | retro | beach | xmas
    'curiosities', true,            -- perguntas de curiosidade nos quizzes
    'turnFormat', 'buzz',           -- buzz = quem sabe primeiro | turns = um time por vez
    'passOnWrong', true,            -- um time por vez: errou, passa a vez (metade dos pontos)
    'obraPacks', jsonb_build_array('cinema', 'anime', 'novelas'), -- "Qual é a obra?": pacotes ligados
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
  v_modes text[] := array['classic', 'auction', 'lyrics', 'continue', 'quiz_open', 'quiz_choice', 'obra'];
  v_packs text[] := array['cinema', 'anime', 'novelas'];
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
  if coalesce(jsonb_typeof(s->'curiosities'), '') <> 'boolean' then
    s := jsonb_set(s, '{curiosities}', 'true');
  end if;
  if coalesce(s->>'turnFormat', '') not in ('buzz', 'turns') then
    s := jsonb_set(s, '{turnFormat}', '"buzz"');
  end if;
  if coalesce(jsonb_typeof(s->'passOnWrong'), '') <> 'boolean' then
    s := jsonb_set(s, '{passOnWrong}', 'true');
  end if;
  -- "Qual é a obra?": pacotes conhecidos, sem repetir (nenhum = todos)
  s := jsonb_set(s, '{obraPacks}', coalesce((
         select jsonb_agg(m order by first_n) from (
           select e #>> '{}' as m, min(n) as first_n
             from jsonb_array_elements(case when jsonb_typeof(s->'obraPacks') = 'array' then s->'obraPacks'
                                            else '[]'::jsonb end) with ordinality as t(e, n)
            where jsonb_typeof(e) = 'string' and e #>> '{}' = any (v_packs)
            group by e #>> '{}') q), '[]'::jsonb));
  if jsonb_array_length(s->'obraPacks') = 0 then
    s := jsonb_set(s, '{obraPacks}', to_jsonb(v_packs));
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
  if not (coalesce(s->>'mode', '') = any (v_modes)) then
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
            where jsonb_typeof(e) = 'string' and e #>> '{}' = any (v_modes)
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

create or replace function public.npl_clean_quiz(p jsonb)
returns jsonb
language plpgsql immutable
set search_path = public
as $$
declare
  v_opts jsonb;
  v_acc jsonb;
  v_correct int;
  v_bool jsonb;
begin
  if jsonb_typeof(p) <> 'object' or coalesce(btrim(p->>'q'), '') = '' or coalesce(btrim(p->>'answer'), '') = '' then
    return null;
  end if;
  select coalesce(jsonb_agg(to_jsonb(left(e #>> '{}', 200)) order by n), '[]'::jsonb) into v_opts
    from jsonb_array_elements(case when jsonb_typeof(p->'options') = 'array' then p->'options' else '[]'::jsonb end)
         with ordinality as x(e, n)
   where n <= 4 and jsonb_typeof(e) = 'string' and btrim(e #>> '{}') <> '';
  select coalesce(jsonb_agg(to_jsonb(left(e #>> '{}', 200)) order by n), '[]'::jsonb) into v_acc
    from jsonb_array_elements(case when jsonb_typeof(p->'accept') = 'array' then p->'accept' else '[]'::jsonb end)
         with ordinality as x(e, n)
   where n <= 12 and jsonb_typeof(e) = 'string' and btrim(e #>> '{}') <> '';
  begin v_correct := (p->>'correct')::int; exception when others then v_correct := null; end;
  -- alternativa inválida no meio desalinharia o índice da certa: descarta todas
  if jsonb_array_length(v_opts) < 2 or v_correct is null or v_correct < 0 or v_correct >= jsonb_array_length(v_opts)
     or jsonb_array_length(v_opts) <> (case when jsonb_typeof(p->'options') = 'array'
                                            then jsonb_array_length(p->'options') else 0 end) then
    v_opts := '[]'::jsonb;
    v_correct := null;
  end if;
  if jsonb_array_length(v_acc) = 0 then v_acc := jsonb_build_array(left(p->>'answer', 200)); end if;
  v_bool := jsonb_build_object(
    'open', jsonb_typeof(p->'open') = 'boolean' and (p->>'open')::boolean,
    'play', not (jsonb_typeof(p->'play') = 'boolean' and not (p->>'play')::boolean),
    'hide_song', jsonb_typeof(p->'hide_song') = 'boolean' and (p->>'hide_song')::boolean,
    'artist_like', jsonb_typeof(p->'artist_like') = 'boolean' and (p->>'artist_like')::boolean);
  return jsonb_strip_nulls(jsonb_build_object(
    'kind', left(coalesce(p->>'kind', 'trivia'), 20),
    'q', left(p->>'q', 300),
    'answer', left(p->>'answer', 200),
    'accept', v_acc,
    'options', v_opts,
    'correct', v_correct,
    'year', case when jsonb_typeof(p->'year') = 'number' then (p->>'year')::int end,
    'cover', case when p->>'cover' ~ '^https://' then left(p->>'cover', 500) end,
    'masked', left(p->>'masked', 300),
    'trivia_id', left(p->>'trivia_id', 40),
    -- "Qual é a obra?": pacote (dica na TV) e, nas novelas, se era abertura ou tema
    'pack', case when p->>'pack' in ('cinema', 'anime', 'novelas') then p->>'pack' end,
    'emoji', left(p->>'emoji', 8),
    'tipo', case when p->>'tipo' in ('abertura', 'tema') then p->>'tipo' end)) || v_bool;
end $$;

create or replace function public.npl_round_mode(p_room_id uuid, p_match int, p_pos int, p_settings jsonb)
returns text
language plpgsql volatile
set search_path = public
as $$
declare
  v_track public.npl_tracks;
  v_mode text;
  v_others text[];
  v_bad boolean;
begin
  select * into v_track from public.npl_tracks
   where room_id = p_room_id and match_no = p_match and position = p_pos;
  v_mode := coalesce(v_track.mode, public.npl_pick_mode(p_settings));
  v_bad := case v_mode
    when 'continue' then not coalesce(jsonb_typeof(v_track.cont->'lines') = 'array'
                                      and jsonb_array_length(v_track.cont->'lines') >= 2, false)
    when 'lyrics' then not coalesce(jsonb_typeof(v_track.lyrics->'masked') = 'array'
                                    and jsonb_array_length(v_track.lyrics->'masked') >= 3, false)
    when 'quiz_open' then not coalesce((v_track.quiz->>'open')::boolean, false)
    when 'quiz_choice' then not coalesce(jsonb_array_length(v_track.quiz->'options') >= 2, false)
    when 'obra' then coalesce(v_track.quiz->>'kind', '') <> 'obra'
    else false end;
  if v_bad then
    select array_agg(m) into v_others
      from jsonb_array_elements_text(coalesce(p_settings->'modePool', '[]'::jsonb)) as m
     where m not in ('continue', 'lyrics', 'quiz_open', 'quiz_choice', 'obra');
    v_mode := coalesce(v_others[1 + floor(random() * coalesce(cardinality(v_others), 0))::int], 'classic');
  end if;
  return v_mode;
end $$;

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
  v_recent jsonb;
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

  insert into public.npl_tracks (room_id, match_no, position, deezer_id, title, title_short, artist, artists, cover, album, lyrics, mode, cont, quiz)
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
         case when e->>'mode' in ('classic', 'auction', 'lyrics', 'continue', 'quiz_open', 'quiz_choice', 'obra')
                   and coalesce(v_room.settings->'modePool', '[]'::jsonb) ? (e->>'mode')
              then e->>'mode' end,
         public.npl_clean_cont(e->'cont'),
         public.npl_clean_quiz(e->'quiz')
    from jsonb_array_elements(p_tracks) with ordinality as x(e, n)
   where n <= 40;
  get diagnostics v_count = row_count;
  v_rounds := least(v_count, greatest(1, coalesce(p_rounds, (v_room.settings->>'rounds')::int, v_count)));

  -- curiosidades desta partida entram na frente da lista das recentes (evita repetir na revanche)
  select coalesce(jsonb_agg(v order by o), '[]'::jsonb) into v_recent
    from (select v, min(o) as o from (
            select to_jsonb(quiz->>'trivia_id') as v, 0::bigint as o
              from public.npl_tracks
             where room_id = v_room.id and match_no = v_match and quiz ? 'trivia_id'
            union all
            select e, n from jsonb_array_elements(coalesce(v_room.trivia_recent, '[]'::jsonb)) with ordinality as x(e, n)
             where jsonb_typeof(e) = 'string') a
          group by v order by min(o) limit 80) b;

  update public.npl_players set active_from_round = 0, wants_rematch = false where room_id = v_room.id;
  update public.npl_rooms
     set match_no = v_match, round_no = 1, total_rounds = v_rounds,
         phase = 'playing', paused = false, paused_at = null, pause_reason = null,
         trivia_recent = v_recent
   where id = v_room.id;
  insert into public.npl_rounds (room_id, match_no, round_no, mode)
  values (v_room.id, v_match, 1, public.npl_round_mode(v_room.id, v_match, 1, v_room.settings));

  perform public.npl_recalc_scores(v_room.id);
  perform public.npl_touch(v_room.id, 'start');
  return jsonb_build_object('match_no', v_match, 'total_rounds', v_rounds, 'reserve', v_count - v_rounds);
end $$;

create or replace function public.npl_turn_applies(p_settings jsonb, p_round public.npl_rounds)
returns boolean
language sql immutable
set search_path = public
as $$
  select coalesce(p_settings->>'turnFormat', 'buzz') = 'turns'
     and p_round.mode in ('classic', 'lyrics', 'continue', 'quiz_open', 'obra')
     and not public.npl_is_tiebreak(p_round)
$$;

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
  v_quiz jsonb := '{}'::jsonb;
  v_track public.npl_tracks;
  v_now timestamptz := clock_timestamp();
  v_order jsonb;
  v_n int;
  v_k int;
  v_owner uuid;
  v_auto boolean;
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

  select * into v_track from public.npl_tracks
   where room_id = v_room.id and match_no = v_round.match_no and position = v_round.round_no;

  if v_round.mode = 'auction' then
    v_auction := public.npl_auction_start(v_round,
                   case when jsonb_typeof(p_meta) = 'object' then p_meta else '{}'::jsonb end, v_now);
  end if;

  if v_round.mode = 'lyrics' then
    if jsonb_typeof(v_track.lyrics->'masked') = 'array' and jsonb_array_length(v_track.lyrics->'masked') >= 3 then
      v_lyrics := public.npl_lyrics_view(v_track, 1);
    else
      v_round.mode := 'classic';
    end if;
  end if;

  if v_round.mode = 'continue' then
    if jsonb_typeof(v_track.cont->'lines') = 'array' and jsonb_array_length(v_track.cont->'lines') >= 2 then
      v_cont := public.npl_cont_view(v_track, 2);
    else
      v_round.mode := 'classic';
    end if;
  end if;

  if v_round.mode in ('quiz_open', 'quiz_choice') then
    if (v_round.mode = 'quiz_open' and coalesce((v_track.quiz->>'open')::boolean, false))
       or (v_round.mode = 'quiz_choice' and coalesce(jsonb_array_length(v_track.quiz->'options') >= 2, false)) then
      v_quiz := public.npl_quiz_view_t(v_track.quiz, v_round.mode, v_now,
                                        coalesce((v_room.settings->>'answerSeconds')::int, 20));
    else
      v_round.mode := 'classic';
    end if;
  end if;

  -- "Qual é a obra?": a TV mostra só o pacote (🎬/🍥/📺); a obra fica oculta até revelar
  if v_round.mode = 'obra' then
    if coalesce(v_track.quiz->>'kind', '') = 'obra' then
      v_quiz := jsonb_strip_nulls(jsonb_build_object('kind', 'obra', 'q', 'Qual é a obra?',
                  'pack', v_track.quiz->'pack', 'emoji', v_track.quiz->'emoji'));
    else
      v_round.mode := 'classic';
    end if;
  end if;

  -- sem "Tocar": letra (verso já na tela) e alternativas com prévia (toca sozinha)
  v_auto := v_round.mode = 'lyrics'
         or (v_round.mode = 'quiz_choice' and coalesce((v_quiz->>'play')::boolean, true));

  update public.npl_rounds
     set status = 'playing', stage = 1, stage_started_at = v_now, started_at = now(),
         offsets = v_offsets,
         play_seq = case when v_auto then 1 else 0 end,
         played_stage = case when v_auto then 1 else 0 end,
         play_at = case when v_auto then v_now end,
         auction = v_auction, lyrics = v_lyrics, cont = v_cont, quiz = v_quiz, turn = '{}'::jsonb,
         mode = v_round.mode
   where id = v_round.id
  returning * into v_round;

  -- um time por vez: a rodada já abre com a vez do time do rodízio
  if public.npl_turn_applies(v_room.settings, v_round) then
    select coalesce(jsonb_agg(to_jsonb(id::text) order by idx), '[]'::jsonb) into v_order
      from public.npl_teams where room_id = v_room.id;
    v_n := jsonb_array_length(v_order);
    if v_n >= 1 then
      select count(*) into v_k from public.npl_rounds
       where room_id = v_room.id and match_no = v_round.match_no and round_no < v_round.round_no and turn ? 'owner';
      select jsonb_agg(e order by ((n - 1 - (v_k % v_n) + v_n) % v_n)) into v_order
        from jsonb_array_elements(v_order) with ordinality as x(e, n);
      v_owner := (v_order->>0)::uuid;
      update public.npl_rounds
         set turn = jsonb_build_object('owner', v_owner, 'team', v_owner, 'order', v_order,
                                       'tried', '[]'::jsonb, 'factor', 1)
       where id = v_round.id;
      -- letra e quiz: a pista já está na tela, o prazo começa agora
      perform public.npl_turn_open(v_round.id, v_owner, 1, v_round.mode in ('lyrics', 'quiz_open'));
      select * into v_round from public.npl_rounds where id = v_round.id;
    end if;
  end if;

  perform public.npl_touch(v_room.id, 'round');
  return to_jsonb(v_round);
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
                     then v_round.cont || jsonb_build_object('reveal', v_track.cont->'hidden',
                                                             'after', coalesce(v_track.cont->'after', '[]'::jsonb))
                     else v_round.cont end,
         -- quiz: a resposta (e a alternativa certa) só aparece agora
         quiz = case when v_round.mode in ('quiz_open', 'quiz_choice', 'obra') and v_round.quiz ? 'q'
                     then v_round.quiz || jsonb_strip_nulls(jsonb_build_object(
                            'answer', v_track.quiz->'answer',
                            'tipo', case when v_round.mode = 'obra' then v_track.quiz->'tipo' end,
                            'correct', case when v_round.mode = 'quiz_choice' then v_track.quiz->'correct' end))
                     else v_round.quiz end
   where id = p_round_id;
end $$;

create or replace function public.npl_part_counts(p_round public.npl_rounds, p_scoring text, p_part text)
returns boolean
language sql immutable
set search_path = public
as $$
  select coalesce(case
    when public.npl_is_tiebreak(p_round) then p_part = 'title'
    when p_round.mode in ('continue', 'quiz_open', 'quiz_choice', 'obra') then p_part = 'title'
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
  -- continuar a letra: vale só a linha ("O que vale" não se aplica; a penalidade vale)
  if v_round.mode = 'continue' then
    v_scoring := 'title';
  end if;
  -- um time por vez: sem penalidade (a opção só vale em "Quem sabe primeiro")
  if public.npl_turn_applies(v_room.settings, v_round) then
    v_pen := 0;
  end if;
  -- quiz aberto e "Qual é a obra?": vale a resposta ("O que vale" não se aplica; a penalidade vale)
  if v_round.mode in ('quiz_open', 'obra') then
    v_scoring := 'title';
  end if;

  -- quiz de alternativas: de 100 (na hora) a 50 (no último segundo), sem penalidade
  if v_round.mode = 'quiz_choice' then
    for a in select * from public.npl_attempts
              where round_id = p_round_id and kind = 'turn' and status in ('correct', 'wrong', 'timeout')
              order by ms_into_stage, created_at
    loop
      v_final := case when a.title_result = 'ok'
                      then 50 + round(50 * greatest(0, least(1, 1 - a.ms_into_stage / (1000.0 * coalesce((v_round.quiz->>'secs')::int, 15)))))::int
                      else 0 end;
      if a.title_result = 'ok' and v_win is null then v_win := a.team_id; end if;
      if v_final is distinct from a.points then
        update public.npl_attempts set points = v_final where id = a.id;
      end if;
      v_total := v_total + v_final;
    end loop;
    update public.npl_rounds
       set artist_team_id = null, title_team_id = v_win, winner_team_id = v_win, points = v_total,
           found = case when v_win is not null then jsonb_build_object('title', v_track.quiz->>'answer') else '{}'::jsonb end
     where id = p_round_id;
    return true;
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
           'title', case when v_tit then case when v_round.mode in ('quiz_open', 'obra') then v_track.quiz->>'answer'
                                              else v_track.title end end))
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
  v_half boolean := false;
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
                      when v_round.mode in ('quiz_open', 'obra') and not public.npl_is_tiebreak(v_round)
                        then public.npl_classify_quiz(p_title, v_track.quiz)
                      else public.npl_classify(p_title,
                             array[v_track.title, coalesce(v_track.title_short, v_track.title)], true) end;
  -- quiz aberto, ano errado por 1: acerto parcial (metade) que encerra a rodada
  if v_title_res = 'half' then
    v_title_res := 'ok';
    v_half := true;
  end if;

  if v_artist_res = 'empty' and v_title_res = 'empty' then
    return jsonb_build_object('ok', false, 'reason', 'empty');
  end if;

  update public.npl_attempts
     set answer_artist = case when v_need_artist then nullif(left(btrim(coalesce(p_artist, '')), 120), '') end,
         answer_title = case when v_need_title then nullif(left(btrim(coalesce(p_title, '')), 200), '') end,
         artist_result = v_artist_res,
         title_result = v_title_res,
         answered_by = v_player.id,
         stage_points = case when v_half then round(stage_points * 0.5)::int else stage_points end
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
  return jsonb_build_object('ok', true, 'result', v_res, 'half', v_half,
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
                            'line', case when v_round.mode = 'continue' then v_track.cont->'hidden'->>'text' end,
                            'quiz', case when v_round.mode in ('quiz_open', 'quiz_choice', 'obra') then
                                      jsonb_strip_nulls(jsonb_build_object('q', v_track.quiz->'q',
                                        'answer', v_track.quiz->'answer', 'kind', v_track.quiz->'kind',
                                        'accept', case when v_round.mode = 'obra' then v_track.quiz->'accept' end,
                                        'tipo', v_track.quiz->'tipo', 'emoji', v_track.quiz->'emoji',
                                        'hide_song', v_track.quiz->'hide_song')) end);
end $$;

revoke execute on function
  public.npl_clean_settings(jsonb),
  public.npl_clean_quiz(jsonb),
  public.npl_round_mode(uuid, int, int, jsonb),
  public.npl_turn_applies(jsonb, public.npl_rounds),
  public.npl_reveal_round(uuid, boolean),
  public.npl_part_counts(public.npl_rounds, text, text),
  public.npl_rescore_round(uuid)
  from public, anon, authenticated;

notify pgrst, 'reload schema';
