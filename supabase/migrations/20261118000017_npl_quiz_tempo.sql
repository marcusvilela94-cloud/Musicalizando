-- =====================================================================
-- Musicalizando — 017: o Quiz de alternativas segue o "Tempo de resposta".
-- Aplicar DEPOIS da 016. Pode rodar mais de uma vez.
--
-- npl_rounds.quiz (alternativas) ganha "secs" = prazo de referência da
-- pontuação (answerSeconds; "Sem limite" = 30). deadline só existe com prazo;
-- sem prazo a pergunta fecha quando todos os times respondem (ou "Revelar").
-- Pontos: 50 + 50 * (1 - ms / (secs * 1000)), de 100 a 50.
--
-- Penalidade (tabela da configuração): vale em Clássico, Só pela letra,
-- Continuar a letra e Quiz no botão, só em "Quem sabe primeiro".
-- =====================================================================

create or replace function public.npl_quiz_view_t(p_quiz jsonb, p_mode text, p_now timestamptz, p_secs int)
returns jsonb
language sql immutable
set search_path = public
as $$
  select public.npl_quiz_view(p_quiz, p_mode, p_now) - 'deadline'
         || case when p_mode = 'quiz_choice' then jsonb_strip_nulls(jsonb_build_object(
              'secs', case when coalesce(p_secs, 0) > 0 then p_secs else 30 end,
              'deadline', case when coalesce(p_secs, 0) > 0
                               then to_jsonb(p_now + make_interval(secs => 3 + p_secs)) end))
            else '{}'::jsonb end
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
           'title', case when v_tit then case when v_round.mode = 'quiz_open' then v_track.quiz->>'answer'
                                              else v_track.title end end))
   where id = p_round_id;
  return v_tit and (v_art or v_scoring <> 'artist_title');
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
  if not found or v_round.mode <> 'quiz_choice' or v_round.status <> 'playing' or not (v_round.quiz ? 'starts_at') then
    return jsonb_build_object('ok', false, 'reason', 'closed');
  end if;
  if v_player.active_from_round > v_round.round_no then
    return jsonb_build_object('ok', false, 'reason', 'not_yet');
  end if;
  if v_room.paused then return jsonb_build_object('ok', false, 'reason', 'paused'); end if;
  v_start := (v_round.quiz->>'starts_at')::timestamptz;
  if v_now < v_start then return jsonb_build_object('ok', false, 'reason', 'early'); end if;
  if v_round.quiz ? 'deadline' and v_now > (v_round.quiz->>'deadline')::timestamptz + interval '0.5 seconds' then
    perform public.npl_quiz_close(v_round.id);
    perform public.npl_touch(v_room.id, 'reveal');
    return jsonb_build_object('ok', false, 'reason', 'closed');
  end if;
  if p_choice is null or p_choice < 0 or p_choice >= coalesce((v_round.quiz->>'n')::int, 0) then
    return jsonb_build_object('ok', false, 'reason', 'bad_choice');
  end if;
  v_ms := least(1000 * coalesce((v_round.quiz->>'secs')::int, 15), greatest(0, floor(extract(epoch from (v_now - v_start)) * 1000)))::int;
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
             'starts_at', (x.quiz->>'starts_at')::timestamptz + v_shift)
           || case when x.quiz ? 'deadline'
                   then jsonb_build_object('deadline', (x.quiz->>'deadline')::timestamptz + v_shift)
                   else '{}'::jsonb end
     where x.room_id = p_room.id and x.match_no = p_room.match_no and x.round_no = p_room.round_no
       and x.mode = 'quiz_choice' and x.status = 'playing' and x.quiz ? 'starts_at';
    update public.npl_rooms set paused = false, paused_at = null, pause_reason = null where id = p_room.id;
    return true;
  end if;
  return false;
end $$;

revoke execute on function
  public.npl_quiz_view_t(jsonb, text, timestamptz, int),
  public.npl_rescore_round(uuid),
  public.npl_set_paused(public.npl_rooms, boolean, text)
  from public, anon, authenticated;

notify pgrst, 'reload schema';
