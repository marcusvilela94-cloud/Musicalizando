-- =====================================================================
-- Musicalizando — 016: "Quiz aberto", "Quiz de alternativas", perguntas de
-- curiosidade e "Formato da vez" (Um time por vez).
-- Aplicar DEPOIS das migrações 001–015. Pode rodar mais de uma vez.
--
-- Pergunta (montada por quem começa a partida, rota /api/game/quiz) vai em
-- p_tracks[i].quiz e fica em npl_tracks.quiz (os clientes NÃO leem):
--   kind      year | album | artist | feat | top | intruder | older | cover | complete | trivia
--   q         texto da pergunta
--   answer    resposta certa (texto)
--   accept    respostas aceitas no quiz aberto (mesma normalização de sempre)
--   options   alternativas (2 a 4, já sorteadas) e correct = índice da certa
--   open      serve para o quiz aberto?
--   year      (kind year) ano certo: no aberto digitado, errar por 1 vale 50
--   cover     (kind cover) capa mostrada desfocada; masked = título com "___"
--   play      a prévia toca? (capa: não)
--   hide_song a prévia é de uma música qualquer: a revelação não a identifica
--   artist_like  conferir como nome de artista; trivia_id  id da curiosidade
-- npl_rounds.quiz mostra a pergunta (sem a resposta) e, no de alternativas,
-- starts_at / deadline (15 s) / answered (times que já responderam). As
-- escolhas ficam em npl_quiz_answers (oculta) até fechar; aí viram tentativas
-- (pontos de 100 a 50 pelo tempo) e quiz ganha counts/correct/answer.
--
-- "Um time por vez" (settings.turnFormat = 'turns'): npl_rounds.turn =
--   {owner, team, order, tried, factor}. A rodada já abre com a vez do time
--   (tentativa aberta, sem EU SEI!). O prazo começa quando o trecho/pista
--   aparece. Errou/tempo: passa para o próximo do rodízio valendo metade
--   (settings.passOnWrong) ou revela.
-- =====================================================================

alter table public.npl_tracks add column if not exists quiz jsonb;
alter table public.npl_rounds add column if not exists quiz jsonb not null default '{}'::jsonb;
alter table public.npl_rounds add column if not exists turn jsonb not null default '{}'::jsonb;
alter table public.npl_rooms add column if not exists trivia_recent jsonb not null default '[]'::jsonb;

-- escolhas do quiz de alternativas (ocultas até fechar a rodada)
create table if not exists public.npl_quiz_answers (
  round_id   uuid not null references public.npl_rounds (id) on delete cascade,
  team_id    uuid not null references public.npl_teams (id) on delete cascade,
  player_id  uuid references public.npl_players (id) on delete set null,
  choice     int  not null,
  ms         int  not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (round_id, team_id)
);
alter table public.npl_quiz_answers enable row level security;
revoke all on public.npl_quiz_answers from anon, authenticated;

-- ---------------------------------------------------------------------
-- Configuração
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
  v_modes text[] := array['classic', 'auction', 'lyrics', 'continue', 'quiz_open', 'quiz_choice'];
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

create or replace function public.npl_stage_count(p_mode text)
returns int
language sql immutable
set search_path = public
as $$ select case p_mode when 'lyrics' then 5 when 'continue' then 1 when 'quiz_open' then 1 when 'quiz_choice' then 1 else 6 end $$;

create or replace function public.npl_stage_points(p_mode text, p_stage int)
returns int
language sql immutable
set search_path = public
as $$
  select case p_mode
    when 'lyrics' then (array[100, 75, 50, 30, 15])[greatest(1, least(5, p_stage))]
    when 'continue' then 100
    when 'quiz_open' then 100
    when 'quiz_choice' then 100
    else (array[100, 80, 60, 40, 25, 10])[greatest(1, least(6, p_stage))]
  end
$$;

-- ---------------------------------------------------------------------
-- Pergunta do quiz
-- ---------------------------------------------------------------------
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
    'trivia_id', left(p->>'trivia_id', 40))) || v_bool;
end $$;

-- O que a rodada mostra (sem a resposta). Alternativas: 3 s para ler, 15 s para responder.
create or replace function public.npl_quiz_view(p_quiz jsonb, p_mode text, p_now timestamptz)
returns jsonb
language sql immutable
set search_path = public
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'kind', p_quiz->'kind',
    'q', p_quiz->'q',
    'play', p_quiz->'play',
    'hide_song', p_quiz->'hide_song',
    'cover', case when p_quiz->>'kind' = 'cover' then p_quiz->'cover' end,
    'masked', p_quiz->'masked',
    'year', case when p_quiz->>'kind' = 'year' then 'true'::jsonb end,
    'options', case when p_mode = 'quiz_choice' then p_quiz->'options' end,
    'n', case when p_mode = 'quiz_choice' then to_jsonb(jsonb_array_length(p_quiz->'options')) end,
    'starts_at', case when p_mode = 'quiz_choice' then to_jsonb(p_now + interval '3 seconds') end,
    'deadline', case when p_mode = 'quiz_choice' then to_jsonb(p_now + interval '18 seconds') end,
    'answered', case when p_mode = 'quiz_choice' then '[]'::jsonb end))
$$;

-- Confere a resposta aberta: ano (exato = ok, ±1 = half) ou as "aceitas"
create or replace function public.npl_classify_quiz(p_answer text, p_quiz jsonb)
returns text
language plpgsql immutable
set search_path = public
as $$
declare
  v_txt text := btrim(coalesce(p_answer, ''));
  v_d text;
  v_y int;
  v_target int;
begin
  if v_txt = '' then return 'empty'; end if;
  if p_quiz->>'kind' = 'year' and jsonb_typeof(p_quiz->'year') = 'number' then
    v_target := (p_quiz->>'year')::int;
    v_d := substring(v_txt from '(\d{4})');
    if v_d is not null then
      v_y := v_d::int;
    else
      v_d := substring(v_txt from '(\d{2})');   -- "94" -> 1994, "08" -> 2008
      if v_d is null then return 'wrong'; end if;
      v_y := (v_target / 100) * 100 + v_d::int;
      if v_y - v_target > 50 then v_y := v_y - 100; elsif v_target - v_y > 50 then v_y := v_y + 100; end if;
    end if;
    if v_y = v_target then return 'ok'; end if;
    if abs(v_y - v_target) = 1 then return 'half'; end if;
    return 'wrong';
  end if;
  return public.npl_classify(v_txt, array(select jsonb_array_elements_text(coalesce(p_quiz->'accept', '[]'::jsonb))),
                             not coalesce((p_quiz->>'artist_like')::boolean, false));
end $$;

-- ---------------------------------------------------------------------
-- Modo de cada rodada (quiz sem pergunta válida cai em outro modo)
-- ---------------------------------------------------------------------
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
    else false end;
  if v_bad then
    select array_agg(m) into v_others
      from jsonb_array_elements_text(coalesce(p_settings->'modePool', '[]'::jsonb)) as m
     where m not in ('continue', 'lyrics', 'quiz_open', 'quiz_choice');
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
         case when e->>'mode' in ('classic', 'auction', 'lyrics', 'continue', 'quiz_open', 'quiz_choice')
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

-- ---------------------------------------------------------------------
-- "Um time por vez"
-- ---------------------------------------------------------------------
create or replace function public.npl_turn_applies(p_settings jsonb, p_round public.npl_rounds)
returns boolean
language sql immutable
set search_path = public
as $$
  select coalesce(p_settings->>'turnFormat', 'buzz') = 'turns'
     and p_round.mode in ('classic', 'lyrics', 'continue', 'quiz_open')
     and not public.npl_is_tiebreak(p_round)
$$;

-- Abre a vez de um time (sem EU SEI!). p_start: o prazo já começa (trecho/pista à mostra).
create or replace function public.npl_turn_open(p_round_id uuid, p_team uuid, p_factor numeric, p_start boolean)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_round public.npl_rounds;
  v_room public.npl_rooms;
  v_secs int;
  v_now timestamptz := clock_timestamp();
  v_id uuid;
begin
  select * into v_round from public.npl_rounds where id = p_round_id;
  select * into v_room from public.npl_rooms where id = v_round.room_id;
  v_secs := coalesce((v_room.settings->>'answerSeconds')::int, 20);
  insert into public.npl_attempts (room_id, round_id, team_id, player_id, kind, status, created_at, deadline,
                                   stage, stage_points, ms_into_stage, steal)
  values (v_room.id, v_round.id, p_team, null, 'turn', 'open', v_now,
          case when p_start and v_secs > 0 then v_now + make_interval(secs => v_secs) end,
          greatest(1, v_round.stage),
          round(public.npl_stage_points(v_round.mode, greatest(1, v_round.stage)) * p_factor)::int,
          0, p_factor < 1)
  returning id into v_id;
  update public.npl_rounds
     set status = 'answering', current_attempt_id = v_id,
         turn = turn || jsonb_build_object('team', p_team, 'factor', p_factor)
   where id = p_round_id;
  return v_id;
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
      v_quiz := public.npl_quiz_view(v_track.quiz, v_round.mode, v_now);
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
  v_turn boolean;
  v_secs int := coalesce((v_room.settings->>'answerSeconds')::int, 20);
begin
  perform public.npl_require_owner(v_room, p_owner_token);
  select * into v_round from public.npl_rounds where id = p_round_id and room_id = v_room.id for update;
  if not found then raise exception 'npl:round_not_found'; end if;
  v_lyrics := v_round.mode = 'lyrics';
  -- um time por vez: a música/pista continua enquanto o time da vez responde
  v_turn := v_round.turn ? 'team' and v_round.status = 'answering';
  v_last := case when v_lyrics then coalesce((v_round.lyrics->>'total')::int, 0)
                 when v_round.mode = 'continue' then coalesce((v_round.cont->>'max')::int, 1)
                 else public.npl_stage_count(v_round.mode) end;
  if v_room.paused or not (v_round.status = 'playing' or v_turn) or v_round.stage <> p_stage
     or v_round.mode in ('auction', 'quiz_choice')
     or (v_round.mode = 'quiz_open' and not coalesce((v_round.quiz->>'play')::boolean, true))
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
  if v_turn then
    -- o prazo começa quando o trecho é mostrado; o valor segue o estágio atual
    update public.npl_attempts
       set deadline = case when deadline is null and v_secs > 0 then v_now + make_interval(secs => v_secs) else deadline end,
           stage = v_round.stage,
           stage_points = round(public.npl_stage_points(v_round.mode, v_round.stage)
                                * coalesce((v_round.turn->>'factor')::numeric, 1))::int
     where id = v_round.current_attempt_id and status = 'open';
  end if;
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
                     then v_round.cont || jsonb_build_object('reveal', v_track.cont->'hidden',
                                                             'after', coalesce(v_track.cont->'after', '[]'::jsonb))
                     else v_round.cont end,
         -- quiz: a resposta (e a alternativa certa) só aparece agora
         quiz = case when v_round.mode in ('quiz_open', 'quiz_choice') and v_round.quiz ? 'q'
                     then v_round.quiz || jsonb_strip_nulls(jsonb_build_object(
                            'answer', v_track.quiz->'answer',
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
    when p_round.mode in ('continue', 'quiz_open', 'quiz_choice') then p_part = 'title'
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
  -- quiz aberto: vale a resposta (a penalidade vale)
  if v_round.mode = 'quiz_open' then
    v_scoring := 'title';
  end if;

  -- quiz de alternativas: de 100 (na hora) a 50 (no último segundo), sem penalidade
  if v_round.mode = 'quiz_choice' then
    for a in select * from public.npl_attempts
              where round_id = p_round_id and kind = 'turn' and status in ('correct', 'wrong', 'timeout')
              order by ms_into_stage, created_at
    loop
      v_final := case when a.title_result = 'ok'
                      then 50 + round(50 * greatest(0, least(1, 1 - a.ms_into_stage / 15000.0)))::int
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
           'title', case when v_tit then case when v_round.mode = 'quiz_open' then v_track.quiz->>'answer'
                                              else v_track.title end end))
   where id = p_round_id;
  return v_tit and (v_art or v_scoring <> 'artist_title');
end $$;

create or replace function public.npl_finalize_attempt(p_attempt_id uuid, p_status_if_wrong text, p_decided_by text)
returns text
language plpgsql
set search_path = public
as $$
declare
  v_att public.npl_attempts;
  v_round public.npl_rounds;
  v_settings jsonb;
  v_ok boolean;
  v_err boolean;
  v_complete boolean;
  v_next int;
  v_out jsonb;
  v_left jsonb;
  v_tried jsonb;
  v_team uuid;
  v_lock int;
begin
  -- uma parte que ficou "quase" (dúvida) sem correção conta como erro
  update public.npl_attempts
     set artist_result = case when artist_result = 'doubt' then 'wrong' else artist_result end,
         title_result  = case when title_result  = 'doubt' then 'wrong' else title_result end
   where id = p_attempt_id;
  select * into v_att from public.npl_attempts where id = p_attempt_id;
  select settings into v_settings from public.npl_rooms where id = v_att.room_id;
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
  elsif v_round.turn ? 'team' then
    -- um time por vez: passa a vez (metade dos pontos) ou revela
    v_tried := coalesce(v_round.turn->'tried', '[]'::jsonb);
    if v_att.team_id is not null and not (v_tried ? v_att.team_id::text) then
      v_tried := v_tried || to_jsonb(v_att.team_id::text);
    end if;
    v_team := null;
    if coalesce((v_settings->>'passOnWrong')::boolean, true) then
      select (e #>> '{}')::uuid into v_team
        from jsonb_array_elements(coalesce(v_round.turn->'order', '[]'::jsonb)) with ordinality as x(e, n)
       where not (v_tried ? (e #>> '{}'))
         and exists (select 1 from public.npl_teams t where t.id = (e #>> '{}')::uuid)
       order by n limit 1;
    end if;
    update public.npl_rounds
       set turn = turn || jsonb_build_object('tried', v_tried), had_error = had_error or v_err,
           current_attempt_id = null
     where id = v_att.round_id;
    if v_team is null then
      perform public.npl_reveal_round(v_att.round_id, false);
    else
      -- a música/pista continua de onde parou: se já estava à mostra, o prazo corre já
      perform public.npl_turn_open(v_att.round_id, v_team, 0.5,
                                   v_round.played_stage > 0 or v_round.mode in ('lyrics', 'quiz_open'));
    end if;
  else
    -- volta a esperar (tocar / repetir / próximo trecho). Quem errou fica bloqueado;
    -- a contagem só começa quando a música voltar a tocar (npl_play). No quiz aberto
    -- a pergunta está na tela: a contagem começa na hora.
    v_lock := coalesce((v_settings->>'lockSeconds')::int, 15);
    update public.npl_rounds r
       set status = 'playing', current_attempt_id = null,
           locks = case when v_err then jsonb_build_object(v_att.team_id::text,
                     case when r.mode = 'quiz_open'
                          then jsonb_build_object('secs', v_lock, 'started_at', clock_timestamp(),
                                                  'until', clock_timestamp() + make_interval(secs => v_lock))
                          else jsonb_build_object('secs', v_lock, 'started_at', null, 'until', null) end)
                   else r.locks end,
           had_error = had_error or v_err
     where id = v_att.round_id;
  end if;
  perform public.npl_recalc_scores(v_att.room_id);
  return case when v_complete then 'correct'
              when v_ok and v_round.mode <> 'auction' then 'partial'
              else p_status_if_wrong end;
end $$;

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
  if v_round.mode in ('auction', 'quiz_choice') or v_round.turn ? 'team' then
    if v_expired then perform public.npl_touch(v_room.id, 'timeout'); end if;
    return jsonb_build_object('ok', false, 'reason',
      case when v_round.mode = 'auction' then 'auction' when v_round.mode = 'quiz_choice' then 'choice' else 'turns' end);
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
                      when v_round.mode = 'quiz_open' then public.npl_classify_quiz(p_title, v_track.quiz)
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
                            'quiz', case when v_round.mode in ('quiz_open', 'quiz_choice') then
                                      jsonb_strip_nulls(jsonb_build_object('q', v_track.quiz->'q',
                                        'answer', v_track.quiz->'answer', 'kind', v_track.quiz->'kind',
                                        'hide_song', v_track.quiz->'hide_song')) end);
end $$;

-- ---------------------------------------------------------------------
-- Quiz de alternativas
-- ---------------------------------------------------------------------
-- Fecha as respostas: as escolhas viram tentativas (pontos pelo tempo) e revela.
create or replace function public.npl_quiz_close(p_round_id uuid)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_round public.npl_rounds;
  v_track public.npl_tracks;
  v_correct int;
  v_n int;
  v_counts jsonb;
begin
  select * into v_round from public.npl_rounds where id = p_round_id;
  if not found or v_round.mode <> 'quiz_choice' or v_round.status <> 'playing' then return; end if;
  select * into v_track from public.npl_tracks
   where room_id = v_round.room_id and match_no = v_round.match_no and position = v_round.round_no;
  v_correct := (v_track.quiz->>'correct')::int;
  v_n := coalesce(jsonb_array_length(v_track.quiz->'options'), 0);
  insert into public.npl_attempts (room_id, round_id, team_id, player_id, kind, status, created_at, deadline,
                                   stage, stage_points, ms_into_stage, steal, answered_by, answer_title,
                                   artist_result, title_result, points, decided_by, decided_at)
  select v_round.room_id, v_round.id, a.team_id, a.player_id, 'turn',
         case when a.choice = v_correct then 'correct' else 'wrong' end,
         a.created_at, null, 1, 100, a.ms, false, a.player_id,
         chr(65 + a.choice) || ') ' || coalesce(v_track.quiz->'options'->>a.choice, '?'),
         'empty', case when a.choice = v_correct then 'ok' else 'wrong' end, 0, 'auto', now()
    from public.npl_quiz_answers a
   where a.round_id = p_round_id
   order by a.created_at;
  select coalesce(jsonb_agg(to_jsonb((select count(*) from public.npl_quiz_answers a
                                       where a.round_id = p_round_id and a.choice = i)) order by i), '[]'::jsonb)
    into v_counts
    from generate_series(0, greatest(0, v_n - 1)) as i;
  update public.npl_rounds set quiz = quiz || jsonb_build_object('counts', v_counts) where id = p_round_id;
  perform public.npl_rescore_round(p_round_id);
  perform public.npl_reveal_round(p_round_id, false);
  perform public.npl_recalc_scores(v_round.room_id);
end $$;

create or replace function public.npl_quiz_choose(p_code text, p_token text, p_round_id uuid, p_choice int)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.npl_rooms := public.npl_lock_room(p_code);
  v_player public.npl_players := public.npl_player_by_token(v_room.id, p_token);
  v_round public.npl_rounds;
  v_now timestamptz := clock_timestamp();
  v_start timestamptz;
  v_ms int;
  v_teams int;
  v_done int;
begin
  if v_player.team_id is null then return jsonb_build_object('ok', false, 'reason', 'no_team'); end if;
  select * into v_round from public.npl_rounds
   where id = p_round_id and room_id = v_room.id and match_no = v_room.match_no and round_no = v_room.round_no
   for update;
  if not found or v_round.mode <> 'quiz_choice' or v_round.status <> 'playing' or not (v_round.quiz ? 'deadline') then
    return jsonb_build_object('ok', false, 'reason', 'closed');
  end if;
  if v_player.active_from_round > v_round.round_no then
    return jsonb_build_object('ok', false, 'reason', 'not_yet');
  end if;
  if v_room.paused then return jsonb_build_object('ok', false, 'reason', 'paused'); end if;
  v_start := (v_round.quiz->>'starts_at')::timestamptz;
  if v_now < v_start then return jsonb_build_object('ok', false, 'reason', 'early'); end if;
  if v_now > (v_round.quiz->>'deadline')::timestamptz + interval '0.5 seconds' then
    perform public.npl_quiz_close(v_round.id);
    perform public.npl_touch(v_room.id, 'reveal');
    return jsonb_build_object('ok', false, 'reason', 'closed');
  end if;
  if p_choice is null or p_choice < 0 or p_choice >= coalesce((v_round.quiz->>'n')::int, 0) then
    return jsonb_build_object('ok', false, 'reason', 'bad_choice');
  end if;
  v_ms := least(15000, greatest(0, floor(extract(epoch from (v_now - v_start)) * 1000)))::int;
  insert into public.npl_quiz_answers (round_id, team_id, player_id, choice, ms, created_at)
  values (v_round.id, v_player.team_id, v_player.id, p_choice, v_ms, v_now)
  on conflict (round_id, team_id) do nothing;
  if not found then return jsonb_build_object('ok', false, 'reason', 'already'); end if;
  update public.npl_rounds
     set quiz = jsonb_set(quiz, '{answered}', coalesce(quiz->'answered', '[]'::jsonb) || to_jsonb(v_player.team_id::text))
   where id = v_round.id;

  -- todos os times que jogam esta rodada responderam: fecha
  select count(*) into v_teams from public.npl_teams t
   where t.room_id = v_room.id
     and exists (select 1 from public.npl_players p where p.team_id = t.id and p.active_from_round <= v_round.round_no);
  select count(*) into v_done from public.npl_quiz_answers where round_id = v_round.id;
  if v_done >= v_teams then
    perform public.npl_quiz_close(v_round.id);
    perform public.npl_touch(v_room.id, 'reveal');
  else
    perform public.npl_touch(v_room.id, 'choice');
  end if;
  return jsonb_build_object('ok', true, 'choice', p_choice, 'ms', v_ms);
end $$;

create or replace function public.npl_expire_overdue(p_room public.npl_rooms)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  v_round public.npl_rounds;
  v_att public.npl_attempts;
begin
  if p_room.phase <> 'playing' or p_room.paused then return false; end if;
  select * into v_round from public.npl_rounds
   where room_id = p_room.id and match_no = p_room.match_no and round_no = p_room.round_no;
  if not found then return false; end if;

  if v_round.mode = 'auction' and v_round.status = 'playing' and v_round.auction->>'phase' = 'bidding' then
    if clock_timestamp() < (v_round.auction->>'turn_deadline')::timestamptz + interval '0.5 seconds' then
      return false;
    end if;
    update public.npl_rounds
       set auction = public.npl_auction_apply(auction, (auction->>'turn')::uuid, null, clock_timestamp())
     where id = v_round.id;
    return true;
  end if;

  -- quiz de alternativas: acabou o prazo, fecha e revela
  if v_round.mode = 'quiz_choice' and v_round.status = 'playing' and v_round.quiz ? 'deadline' then
    if clock_timestamp() < (v_round.quiz->>'deadline')::timestamptz + interval '0.5 seconds' then
      return false;
    end if;
    perform public.npl_quiz_close(v_round.id);
    return true;
  end if;

  if v_round.status <> 'answering' then return false; end if;
  select * into v_att from public.npl_attempts where id = v_round.current_attempt_id;
  if not found or v_att.status <> 'open' or v_att.deadline is null
     or clock_timestamp() < v_att.deadline + interval '1.5 seconds' then
    return false;
  end if;
  perform public.npl_finalize_attempt(v_att.id, 'timeout', 'auto');
  return true;
end $$;

create or replace function public.npl_set_paused(p_room public.npl_rooms, p_paused boolean, p_reason text)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  v_shift interval;
  v_paused_at timestamptz;
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
    v_paused_at := coalesce(p_room.paused_at, clock_timestamp());
    v_shift := clock_timestamp() - v_paused_at;
    update public.npl_attempts a
       set deadline = a.deadline + v_shift
     where a.room_id = p_room.id and a.status = 'open' and a.deadline is not null;
    -- o bloqueio por tempo também fica congelado durante a pausa
    update public.npl_rounds x
       set locks = (select coalesce(jsonb_object_agg(k,
                      case when v->>'until' is null then v
                           else v || jsonb_build_object('until', (v->>'until')::timestamptz + v_shift) end)
                      , '{}'::jsonb)
                      from jsonb_each(x.locks) as e(k, v))
     where x.room_id = p_room.id and x.match_no = p_room.match_no and x.round_no = p_room.round_no
       and x.locks <> '{}'::jsonb;
    -- turno do leilão (e o início dos lances, se ainda não tinha começado)
    update public.npl_rounds x
       set auction = x.auction || jsonb_build_object(
             'turn_deadline', (x.auction->>'turn_deadline')::timestamptz + v_shift,
             'starts_at', case when (x.auction->>'starts_at')::timestamptz > v_paused_at
                               then (x.auction->>'starts_at')::timestamptz + v_shift
                               else (x.auction->>'starts_at')::timestamptz end)
     where x.room_id = p_room.id and x.match_no = p_room.match_no and x.round_no = p_room.round_no
       and x.mode = 'auction' and x.auction->>'phase' = 'bidding';
    -- quiz de alternativas: o relógio (e a contagem dos pontos) para durante a pausa
    update public.npl_rounds x
       set quiz = x.quiz || jsonb_build_object(
             'starts_at', (x.quiz->>'starts_at')::timestamptz + v_shift,
             'deadline', (x.quiz->>'deadline')::timestamptz + v_shift)
     where x.room_id = p_room.id and x.match_no = p_room.match_no and x.round_no = p_room.round_no
       and x.mode = 'quiz_choice' and x.status = 'playing' and x.quiz ? 'deadline';
    update public.npl_rooms set paused = false, paused_at = null, pause_reason = null where id = p_room.id;
    return true;
  end if;
  return false;
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
  if v_round.mode = 'quiz_choice' and v_round.status = 'playing' then
    -- "Encerrar respostas": vale o que já foi respondido
    perform public.npl_quiz_close(v_round.id);
  else
    update public.npl_attempts set status = 'cancelled', points = 0, decided_at = now()
     where round_id = v_round.id and status in ('open', 'doubt');
    perform public.npl_reveal_round(v_round.id, false);
  end if;
  perform public.npl_set_paused(v_room, false, null);
  perform public.npl_recalc_scores(v_room.id);
  perform public.npl_touch(v_room.id, 'reveal');
end $$;

revoke execute on function
  public.npl_clean_settings(jsonb),
  public.npl_clean_quiz(jsonb),
  public.npl_quiz_view(jsonb, text, timestamptz),
  public.npl_classify_quiz(text, jsonb),
  public.npl_round_mode(uuid, int, int, jsonb),
  public.npl_turn_applies(jsonb, public.npl_rounds),
  public.npl_turn_open(uuid, uuid, numeric, boolean),
  public.npl_reveal_round(uuid, boolean),
  public.npl_part_counts(public.npl_rounds, text, text),
  public.npl_rescore_round(uuid),
  public.npl_finalize_attempt(uuid, text, text),
  public.npl_quiz_close(uuid),
  public.npl_expire_overdue(public.npl_rooms),
  public.npl_set_paused(public.npl_rooms, boolean, text)
  from public, anon, authenticated;
