-- =====================================================================
-- Musicalizando — 026: ritmo controlado por botão.
-- Aplicar DEPOIS da 025. Pode rodar mais de uma vez.
--
-- Nada avança sozinho:
--   * npl_round_begin (TV carregou o áudio) deixa a rodada em status 'intro':
--     tela de apresentação (modo, como funciona, de quem é a vez, pontos).
--     npl_round_go ("Começar rodada") abre a rodada.
--   * Quizzes: a pergunta aparece sem tempo correndo; npl_quiz_go ("Valendo!")
--     liga quiz.live, começa o prazo e libera os botões (e a música, se houver).
--   * "Um time por vez": quando a vez passa (erro/tempo), turn.wait = true e a
--     tela "Vez do time X!" espera npl_turn_continue ("Continuar").
--   * Clássico / Obra / Instrumentos no "Um time por vez": o controlador toca os
--     trechos e o time da vez aperta "Responder agora" (npl_turn_claim; com
--     apresentador também npl_turn_claim_host = "Vai responder"). Os pontos
--     valem pelo trecho daquele momento. Errou com "passa a vez": o próximo
--     segue do trecho seguinte, valendo metade. Sem passar a vez: o mesmo time
--     pede mais trechos e tenta de novo (com penalidade, se ligada).
--   * Continuar a letra: EU SEI! / resposta só depois que a música para antes
--     da linha escondida (npl_cont_stopped, pelo relógio do servidor).
-- =====================================================================

-- status 'intro' (apresentação da rodada)
do $$
declare c record;
begin
  for c in select conname from pg_constraint
            where conrelid = 'public.npl_rounds'::regclass and contype = 'c'
              and pg_get_constraintdef(oid) ilike '%status%' loop
    execute format('alter table public.npl_rounds drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.npl_rounds add constraint npl_rounds_status_check
  check (status in ('loading', 'intro', 'playing', 'answering', 'doubt', 'revealed', 'scoreboard'));

-- ---------------------------------------------------------------------
-- Auxiliares
-- ---------------------------------------------------------------------
-- Modos em que, no "Um time por vez", o time escolhe a hora de responder ("Responder agora")
create or replace function public.npl_turn_claims(p_mode text)
returns boolean
language sql immutable
set search_path = public
as $$
  select coalesce(p_mode, '') in ('classic', 'obra', 'stems')
$$;

-- Quantos estágios (trechos / versos / linhas / camadas) a rodada tem
create or replace function public.npl_round_stages(p_round public.npl_rounds)
returns int
language sql immutable
set search_path = public
as $$
  select greatest(1, case
    when p_round.mode = 'lyrics' then coalesce((p_round.lyrics->>'total')::int, 1)
    when p_round.mode = 'continue' then coalesce((p_round.cont->>'max')::int, 1)
    when p_round.mode = 'stems' then jsonb_array_length(coalesce(p_round.stems->'points', '[]'::jsonb))
    else public.npl_stage_count(p_round.mode) end)
$$;

-- Continuar a letra: quando o trecho tocado para (0,3 s antes da linha escondida); null = não tocou
create or replace function public.npl_cont_stop_at(p_round public.npl_rounds)
returns timestamptz
language sql immutable
set search_path = public
as $$
  select case when p_round.mode = 'continue' and p_round.play_at is not null and p_round.played_stage > 0
                   and p_round.cont ? 'hidden' then
    p_round.play_at + make_interval(secs => greatest(0.5,
      coalesce((p_round.cont->'hidden'->>'start')::numeric, 0) - 0.3
      - greatest(0, coalesce((p_round.cont->'lines'->0->>'start')::numeric, 0)))::double precision)
  end
$$;

-- A música já parou? (com 0,3 s de folga para o atraso da TV)
create or replace function public.npl_cont_stopped(p_round public.npl_rounds, p_now timestamptz)
returns boolean
language sql immutable
set search_path = public
as $$
  select coalesce(p_now >= public.npl_cont_stop_at(p_round) - interval '0.3 seconds', false)
$$;

-- ---------------------------------------------------------------------
-- "Começar rodada": sai da apresentação
-- ---------------------------------------------------------------------
create or replace function public.npl_round_go(p_code text, p_owner_token text, p_round_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.npl_rooms := public.npl_lock_room(p_code);
  v_round public.npl_rounds;
  v_now timestamptz := clock_timestamp();
  v_auto boolean;
begin
  perform public.npl_require_owner(v_room, p_owner_token);
  select * into v_round from public.npl_rounds where id = p_round_id and room_id = v_room.id for update;
  if not found then raise exception 'npl:round_not_found'; end if;
  if v_round.status <> 'intro' or v_room.round_no <> v_round.round_no then
    return jsonb_build_object('ok', false, 'round', to_jsonb(v_round));
  end if;
  -- letra: o 1º verso aparece já (não há "Tocar")
  v_auto := v_round.mode = 'lyrics';
  update public.npl_rounds
     set status = 'playing', stage_started_at = v_now, started_at = now(),
         play_seq = case when v_auto then play_seq + 1 else play_seq end,
         played_stage = case when v_auto then 1 else played_stage end,
         play_at = case when v_auto then v_now else play_at end,
         -- leilão: os lances começam agora
         auction = case when mode = 'auction' and auction ? 'starts_at'
                        then auction || jsonb_build_object('starts_at', v_now, 'turn_deadline', v_now + interval '15 seconds')
                        else auction end
   where id = v_round.id
  returning * into v_round;

  -- um time por vez: letra / continuar / quiz no botão abrem a vez direto
  -- (prazo já correndo só na letra; continuar espera a música parar; quiz espera o "Valendo!")
  if v_round.turn ? 'team' and not public.npl_turn_claims(v_round.mode) then
    perform public.npl_turn_open(v_round.id, (v_round.turn->>'team')::uuid, 1, v_round.mode = 'lyrics');
  end if;
  perform public.npl_set_paused(v_room, false, null);
  perform public.npl_touch(v_room.id, 'go');
  select * into v_round from public.npl_rounds where id = v_round.id;
  return jsonb_build_object('ok', true, 'round', to_jsonb(v_round));
end $$;

-- ---------------------------------------------------------------------
-- Quizzes: "Valendo!" (a pergunta já está na tela)
-- ---------------------------------------------------------------------
create or replace function public.npl_quiz_go(p_code text, p_owner_token text, p_round_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.npl_rooms := public.npl_lock_room(p_code);
  v_round public.npl_rounds;
  v_now timestamptz := clock_timestamp();
  v_secs int := coalesce((v_room.settings->>'answerSeconds')::int, 20);
  v_play boolean;
begin
  perform public.npl_require_owner(v_room, p_owner_token);
  select * into v_round from public.npl_rounds where id = p_round_id and room_id = v_room.id for update;
  if not found then raise exception 'npl:round_not_found'; end if;
  if v_round.mode not in ('quiz_open', 'quiz_choice') or v_round.status not in ('playing', 'answering')
     or coalesce((v_round.quiz->>'live')::boolean, false) or v_room.paused
     or coalesce((v_round.turn->>'wait')::boolean, false) then
    return jsonb_build_object('ok', false);
  end if;
  v_play := coalesce((v_round.quiz->>'play')::boolean, true);
  update public.npl_rounds
     set quiz = quiz || jsonb_build_object('live', true)
                || case when mode = 'quiz_choice' then jsonb_strip_nulls(jsonb_build_object(
                     'starts_at', v_now,
                     'deadline', case when v_secs > 0 then v_now + make_interval(secs => v_secs) end))
                   else '{}'::jsonb end,
         stage_started_at = v_now,
         -- a música (se a pergunta tem) começa junto
         play_seq = case when v_play then play_seq + 1 else play_seq end,
         played_stage = case when v_play then greatest(1, stage) else played_stage end,
         play_at = case when v_play then v_now else play_at end
   where id = v_round.id
  returning * into v_round;
  -- um time por vez (quiz no botão): o prazo do time da vez começa agora
  if v_secs > 0 then
    update public.npl_attempts set deadline = v_now + make_interval(secs => v_secs)
     where id = v_round.current_attempt_id and status = 'open' and deadline is null;
  end if;
  perform public.npl_touch(v_room.id, 'live', jsonb_build_object('seq', v_round.play_seq));
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------
-- "Um time por vez": "Continuar" depois de "Vez do time X!"
-- ---------------------------------------------------------------------
create or replace function public.npl_turn_continue(p_code text, p_owner_token text, p_round_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.npl_rooms := public.npl_lock_room(p_code);
  v_round public.npl_rounds;
  v_now timestamptz := clock_timestamp();
begin
  perform public.npl_require_owner(v_room, p_owner_token);
  select * into v_round from public.npl_rounds where id = p_round_id and room_id = v_room.id for update;
  if not found then raise exception 'npl:round_not_found'; end if;
  if v_round.status <> 'playing' or not (v_round.turn ? 'team')
     or not coalesce((v_round.turn->>'wait')::boolean, false) then
    return jsonb_build_object('ok', false);
  end if;
  update public.npl_rounds
     set turn = turn || jsonb_build_object('wait', false), stage_started_at = v_now
   where id = v_round.id
  returning * into v_round;
  if not public.npl_turn_claims(v_round.mode) then
    -- letra / quiz (já valendo) / continuar (música já parou): o prazo corre já
    perform public.npl_turn_open(v_round.id, (v_round.turn->>'team')::uuid,
      coalesce((v_round.turn->>'factor')::numeric, 0.5),
      v_round.mode = 'lyrics'
      or (v_round.mode = 'quiz_open' and coalesce((v_round.quiz->>'live')::boolean, false))
      or (v_round.mode = 'continue' and public.npl_cont_stopped(v_round, v_now)));
  end if;
  perform public.npl_set_paused(v_room, false, null);
  perform public.npl_touch(v_room.id, 'turn');
  return jsonb_build_object('ok', true);
end $$;

-- "Responder agora" (Clássico / Obra / Instrumentos no "Um time por vez")
create or replace function public.npl_turn_claim_do(p_room public.npl_rooms, p_round public.npl_rounds,
                                                    p_team uuid, p_player uuid)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_id uuid;
  v_att public.npl_attempts;
begin
  if p_round.status <> 'playing' or not (p_round.turn ? 'team') or not public.npl_turn_claims(p_round.mode) then
    return jsonb_build_object('ok', false, 'reason', 'closed');
  end if;
  if coalesce((p_round.turn->>'wait')::boolean, false) then
    return jsonb_build_object('ok', false, 'reason', 'wait');
  end if;
  if p_team is distinct from (p_round.turn->>'team')::uuid then
    return jsonb_build_object('ok', false, 'reason', 'turns');
  end if;
  if p_round.played_stage < 1 then
    return jsonb_build_object('ok', false, 'reason', 'not_played');
  end if;
  if p_room.paused then return jsonb_build_object('ok', false, 'reason', 'paused'); end if;
  -- vale o trecho atual (metade depois de passar a vez); o prazo começa agora
  v_id := public.npl_turn_open(p_round.id, p_team, coalesce((p_round.turn->>'factor')::numeric, 1), true);
  update public.npl_attempts
     set player_id = p_player,
         ms_into_stage = greatest(0, floor(extract(epoch from (created_at - coalesce(p_round.stage_started_at, created_at))) * 1000))::int
   where id = v_id
  returning * into v_att;
  perform public.npl_touch(p_room.id, 'buzz', jsonb_build_object('team_id', p_team, 'attempt_id', v_id));
  return jsonb_build_object('ok', true, 'attempt_id', v_id, 'deadline', v_att.deadline, 'team_id', p_team);
end $$;

create or replace function public.npl_turn_claim(p_code text, p_token text, p_round_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.npl_rooms := public.npl_lock_room(p_code);
  v_player public.npl_players := public.npl_player_by_token(v_room.id, p_token);
  v_round public.npl_rounds;
begin
  if v_player.team_id is null then return jsonb_build_object('ok', false, 'reason', 'no_team'); end if;
  select * into v_round from public.npl_rounds
   where id = p_round_id and room_id = v_room.id and match_no = v_room.match_no and round_no = v_room.round_no
   for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'closed'); end if;
  if v_player.active_from_round > v_round.round_no then
    return jsonb_build_object('ok', false, 'reason', 'not_yet');
  end if;
  return public.npl_turn_claim_do(v_room, v_round, v_player.team_id, v_player.id);
end $$;

-- Com apresentador: "Vai responder" (o time falou que sabe)
create or replace function public.npl_turn_claim_host(p_code text, p_owner_token text, p_round_id uuid)
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
  select * into v_round from public.npl_rounds
   where id = p_round_id and room_id = v_room.id and match_no = v_room.match_no and round_no = v_room.round_no
   for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'closed'); end if;
  return public.npl_turn_claim_do(v_room, v_round, (v_round.turn->>'team')::uuid, null);
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
  v_stems jsonb := '{}'::jsonb;
  v_track public.npl_tracks;
  v_now timestamptz := clock_timestamp();
  v_order jsonb;
  v_n int;
  v_k int;
  v_owner uuid;
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
      -- o relógio das alternativas só começa no "Valendo!" (npl_quiz_go)
      v_quiz := public.npl_quiz_view_t(v_track.quiz, v_round.mode, v_now,
                                        coalesce((v_room.settings->>'answerSeconds')::int, 20)) - 'starts_at' - 'deadline';
    else
      v_round.mode := 'classic';
    end if;
  end if;

  -- Instrumentos: camadas/instrumento e o endereço das faixas separadas (cache)
  if v_round.mode = 'stems' then
    if coalesce(v_track.stems ? 'key', false) then
      v_stems := public.npl_stems_view(v_track.stems);
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

  -- tudo pronto, mas nada começa: tela de apresentação até o "Começar rodada" (npl_round_go)
  update public.npl_rounds
     set status = 'intro', stage = 1, stage_started_at = v_now,
         offsets = v_offsets, play_seq = 0, played_stage = 0, play_at = null,
         auction = v_auction, lyrics = v_lyrics, cont = v_cont, quiz = v_quiz, stems = v_stems, turn = '{}'::jsonb,
         mode = v_round.mode
   where id = v_round.id
  returning * into v_round;

  -- um time por vez: a apresentação já mostra de quem é a vez
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
                                       'tried', '[]'::jsonb, 'last', '[]'::jsonb, 'factor', 1, 'wait', false)
       where id = v_round.id
      returning * into v_round;
    end if;
  end if;

  perform public.npl_touch(v_room.id, 'round');
  return to_jsonb(v_round);
end $$;


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
  v_aw numeric := 0.5;  -- peso do artista
  v_tw numeric := 1;    -- peso da música
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
  -- um time por vez: sem penalidade quando a vez passa (errou, passa valendo metade);
  -- sem passar a vez o time tenta de novo e a penalidade (se ligada) vale
  if public.npl_turn_applies(v_room.settings, v_round) and coalesce((v_room.settings->>'passOnWrong')::boolean, true) then
    v_pen := 0;
  end if;
  -- Instrumentos, só a voz: o artista vale inteiro e a música é bônus (metade)
  if v_round.mode = 'stems' and v_round.stems->>'instrument' = 'vocals' then
    v_scoring := 'artist_title';
    v_aw := 1;
    v_tw := 0.5;
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
      v_pts := v_pts + a.stage_points * v_aw;
      v_art := true;
      v_art_team := a.team_id;
    end if;
    if a.title_result = 'ok' and not v_tit then
      v_pts := v_pts + a.stage_points * v_tw;
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
  -- quiz no botão: a pergunta está na tela, mas só vale depois do "Valendo!"
  if v_round.mode = 'quiz_open' and not coalesce((v_round.quiz->>'live')::boolean, false) then
    return jsonb_build_object('ok', false, 'reason', 'not_live');
  end if;
  -- continuar a letra: só depois que a música para antes da linha escondida
  if v_round.mode = 'continue' and not public.npl_cont_stopped(v_round, clock_timestamp()) then
    return jsonb_build_object('ok', false, 'reason', 'music');
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
          v_round.stage, public.npl_round_points(v_round),
          greatest(0, floor(extract(epoch from (v_now - coalesce(v_round.stage_started_at, v_now))) * 1000))::int,
          v_round.had_error)
  returning * into v_att;

  update public.npl_rounds set status = 'answering', current_attempt_id = v_att.id where id = v_round.id;
  perform public.npl_touch(v_room.id, 'buzz', jsonb_build_object('team_id', v_att.team_id, 'attempt_id', v_att.id));
  return jsonb_build_object('ok', true, 'attempt_id', v_att.id, 'deadline', v_att.deadline, 'team_id', v_att.team_id);
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
  -- (Clássico, Obra e Instrumentos: o time escolhe a hora de responder e a música para)
  v_turn := v_round.turn ? 'team' and v_round.status = 'answering' and not public.npl_turn_claims(v_round.mode);
  v_last := case when v_lyrics then coalesce((v_round.lyrics->>'total')::int, 0)
                 when v_round.mode = 'continue' then coalesce((v_round.cont->>'max')::int, 1)
                 when v_round.mode = 'stems' then greatest(1, jsonb_array_length(coalesce(v_round.stems->'points', '[]'::jsonb)))
                 else public.npl_stage_count(v_round.mode) end;
  if v_room.paused or not (v_round.status = 'playing' or v_turn) or v_round.stage <> p_stage
     or v_round.mode in ('auction', 'quiz_choice')
     -- "Vez do time X!": espera o "Continuar"
     or coalesce((v_round.turn->>'wait')::boolean, false)
     -- quizzes: a música só toca depois do "Valendo!"
     or (v_round.mode = 'quiz_open' and not coalesce((v_round.quiz->>'live')::boolean, false))
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
       set deadline = case when v_secs <= 0 then deadline
                           -- continuar a letra: o prazo começa quando a música para
                           when v_round.mode = 'continue'
                             then public.npl_cont_stop_at(v_round) + make_interval(secs => v_secs)
                           when deadline is null then v_now + make_interval(secs => v_secs)
                           else deadline end,
           stage = v_round.stage,
           stage_points = round(public.npl_round_points(v_round)
                                * coalesce((v_round.turn->>'factor')::numeric, 1))::int
     where id = v_round.current_attempt_id and status = 'open';
  end if;
  perform public.npl_touch(v_room.id, 'play', jsonb_build_object('seq', v_round.play_seq));
  return jsonb_build_object('ok', true, 'round', to_jsonb(v_round));
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

  -- continuar a letra: nada de responder com a música tocando
  if v_round.mode = 'continue' and not public.npl_cont_stopped(v_round, clock_timestamp()) then
    return jsonb_build_object('ok', false, 'reason', 'music');
  end if;
  if v_round.mode = 'quiz_open' and not coalesce((v_round.quiz->>'live')::boolean, false) then
    return jsonb_build_object('ok', false, 'reason', 'not_live');
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
  v_claim boolean;
  v_pass boolean;
  v_lastst int;
  v_lastt jsonb;
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
    v_tried := coalesce(v_round.turn->'tried', '[]'::jsonb);
    if v_att.team_id is not null and not (v_tried ? v_att.team_id::text) then
      v_tried := v_tried || to_jsonb(v_att.team_id::text);
    end if;
    v_claim := public.npl_turn_claims(v_round.mode);
    v_lastst := public.npl_round_stages(v_round);
    v_pass := coalesce((v_settings->>'passOnWrong')::boolean, true);
    v_team := null;
    v_lastt := coalesce(v_round.turn->'last', '[]'::jsonb);
    if v_claim then
      -- Clássico / Obra / Instrumentos: quem errou no último trecho não tenta de novo
      if v_round.stage >= v_lastst and v_att.team_id is not null and not (v_lastt ? v_att.team_id::text) then
        v_lastt := v_lastt || to_jsonb(v_att.team_id::text);
      end if;
      if v_pass then
        -- a vez passa para o próximo do rodízio (dá a volta), que segue do trecho seguinte;
        -- no último trecho, só quem ainda não tentou nele
        select (e #>> '{}')::uuid into v_team
          from jsonb_array_elements(coalesce(v_round.turn->'order', '[]'::jsonb)) with ordinality as x(e, n)
         where exists (select 1 from public.npl_teams t where t.id = (e #>> '{}')::uuid)
           and (e #>> '{}') is distinct from v_att.team_id::text
           and not (least(v_round.stage + 1, v_lastst) >= v_lastst and v_lastt ? (e #>> '{}'))
         order by (n - 1 - coalesce((select m - 1 from jsonb_array_elements_text(v_round.turn->'order')
                                                     with ordinality as y(id, m)
                                      where y.id = v_att.team_id::text), 0)
                   + jsonb_array_length(v_round.turn->'order')) % jsonb_array_length(v_round.turn->'order')
         limit 1;
      end if;
    elsif v_pass then
      select (e #>> '{}')::uuid into v_team
        from jsonb_array_elements(coalesce(v_round.turn->'order', '[]'::jsonb)) with ordinality as x(e, n)
       where not (v_tried ? (e #>> '{}'))
         and exists (select 1 from public.npl_teams t where t.id = (e #>> '{}')::uuid)
       order by n limit 1;
    end if;
    update public.npl_rounds
       set turn = turn || jsonb_build_object('tried', v_tried, 'last', v_lastt), had_error = had_error or v_err,
           current_attempt_id = null
     where id = v_att.round_id;
    if v_team is not null then
      -- "Vez do time X!": nada corre até o controlador apertar "Continuar" (npl_turn_continue)
      update public.npl_rounds
         set status = 'playing',
             turn = turn || jsonb_build_object('team', v_team, 'factor', 0.5, 'wait', true),
             stage = case when v_claim then least(stage + 1, v_lastst) else stage end,
             stage_started_at = clock_timestamp()
       where id = v_att.round_id;
    elsif v_claim and not v_pass and v_round.stage < v_lastst then
      -- sem passar a vez: o mesmo time pede mais trechos e tenta de novo
      update public.npl_rounds set status = 'playing' where id = v_att.round_id;
    else
      perform public.npl_reveal_round(v_att.round_id, false);
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


revoke execute on function
  public.npl_turn_claims(text),
  public.npl_round_stages(public.npl_rounds),
  public.npl_cont_stop_at(public.npl_rounds),
  public.npl_cont_stopped(public.npl_rounds, timestamptz),
  public.npl_turn_claim_do(public.npl_rooms, public.npl_rounds, uuid, uuid),
  public.npl_rescore_round(uuid),
  public.npl_finalize_attempt(uuid, text, text)
  from public, anon, authenticated;

notify pgrst, 'reload schema';
