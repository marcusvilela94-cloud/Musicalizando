-- =====================================================================
-- Musicalizando — 005: bloqueio que só conta com a música tocando,
-- liberação quando outro time erra, opção de 5 s e volume dos efeitos.
-- Aplicar DEPOIS das migrações 001–004. Pode rodar mais de uma vez.
--
-- Novo formato de npl_rounds.locks (um objeto por time bloqueado):
--   { "<team_id>": { "secs": 15, "started_at": null | ts, "until": null | ts } }
--   started_at/until = null  -> errou, aguardando a música voltar a tocar
--   started_at/until != null -> contagem correndo (relógio do servidor)
-- =====================================================================

-- Bloqueios no formato antigo ({team_id: horário}) são descartados.
update public.npl_rounds
   set locks = '{}'::jsonb
 where locks <> '{}'::jsonb
   and exists (select 1 from jsonb_each(locks) e where jsonb_typeof(e.value) <> 'object');

-- ---------------------------------------------------------------------
-- Configuração: lockSeconds aceita 5; sfxVolume (low | medium | high)
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
    'lockSeconds', 15,              -- bloqueio após erro: 5 | 10 | 15 | 20 | 30
    'sounds', true,                 -- efeitos sonoros na TV
    'sfxVolume', 'high',            -- volume dos efeitos: low | medium | high
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
-- Ajudantes do bloqueio
-- ---------------------------------------------------------------------
-- Bloqueio ativo? (aguardando a música ou com contagem ainda correndo)
create or replace function public.npl_lock_active(p_lock jsonb, p_now timestamptz)
returns boolean
language sql immutable
set search_path = public
as $$
  select p_lock is not null and jsonb_typeof(p_lock) = 'object'
     and (p_lock->>'until' is null or (p_lock->>'until')::timestamptz > p_now)
$$;

-- A música voltou a tocar: quem estava aguardando começa a contar agora.
create or replace function public.npl_locks_start(p_locks jsonb, p_now timestamptz)
returns jsonb
language sql immutable
set search_path = public
as $$
  select coalesce(jsonb_object_agg(k,
           case when v->>'started_at' is null then
             v || jsonb_build_object('started_at', p_now,
                                     'until', p_now + make_interval(secs => coalesce((v->>'secs')::int, 15)))
           else v end), '{}'::jsonb)
    from jsonb_each(coalesce(p_locks, '{}'::jsonb)) as e(k, v)
   where public.npl_lock_active(v, p_now)
$$;

-- ---------------------------------------------------------------------
-- Pausa: contagens que estão correndo andam junto com a pausa
-- ---------------------------------------------------------------------
create or replace function public.npl_set_paused(p_room public.npl_rooms, p_paused boolean, p_reason text)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  v_shift interval;
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
    v_shift := clock_timestamp() - coalesce(p_room.paused_at, clock_timestamp());
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
    update public.npl_rooms set paused = false, paused_at = null, pause_reason = null where id = p_room.id;
    return true;
  end if;
  return false;
end $$;

-- ---------------------------------------------------------------------
-- "Tocar"/"Repetir"/"Próximo trecho": inicia a contagem de quem aguardava
-- ---------------------------------------------------------------------
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
  v_now timestamptz;
begin
  perform public.npl_require_owner(v_room, p_owner_token);
  select * into v_round from public.npl_rounds where id = p_round_id and room_id = v_room.id for update;
  if not found then raise exception 'npl:round_not_found'; end if;
  if v_room.paused or v_round.status <> 'playing' or v_round.stage <> p_stage
     or (coalesce(p_advance, false) and v_round.stage >= public.npl_stage_count(v_round.mode)) then
    return jsonb_build_object('ok', false, 'round', to_jsonb(v_round));
  end if;
  v_now := clock_timestamp();
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

-- ---------------------------------------------------------------------
-- Fecha a tentativa: quem errou fica bloqueado (aguardando a música) e
-- qualquer outro time bloqueado é liberado na hora.
-- ---------------------------------------------------------------------
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
  return case when v_complete then 'correct' when v_ok then 'partial' else p_status_if_wrong end;
end $$;

-- ---------------------------------------------------------------------
-- O botão "EU SEI!" com bloqueio (aguardando a música ou contando)
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
-- Funções internas: ninguém de fora executa
-- ---------------------------------------------------------------------
revoke execute on function
  public.npl_set_paused(public.npl_rooms, boolean, text),
  public.npl_finalize_attempt(uuid, text, text),
  public.npl_clean_settings(jsonb),
  public.npl_lock_active(jsonb, timestamptz),
  public.npl_locks_start(jsonb, timestamptz)
  from public, anon, authenticated;
