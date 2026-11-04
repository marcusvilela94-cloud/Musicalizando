-- =====================================================================
-- Musicalizando — 007: modo "Leilão".
-- Aplicar DEPOIS das migrações 001–006. Pode rodar mais de uma vez.
--
-- Estado do leilão em npl_rounds.auction (só nas rodadas de leilão):
--   hint            "artist" (TV mostra o artista, vale a MÚSICA)
--                   | "genre" (TV mostra gênero + ano, vale o ARTISTA)
--   artist/artists  créditos (só na dica "artist")
--   genre/year      (só na dica "genre")
--   phase           "bidding" (lances) | "proving" (prova em fila)
--   starts_at       quando os lances começam (a dica aparece antes)
--   order           times na ordem do rodízio (quem abre primeiro)
--   turn            time da vez; turn_deadline = fim do turno (15 s)
--   low/low_team    menor lance atual (começa em 20 s, sem dono)
--   bids            {team_id: segundos} (último lance de cada time)
--   passes          times que disseram "Pode tocar!" desde o último lance
--   log             [{team, secs (null = "Pode tocar!"), at}]
--   queue           fila de prova [{team, secs}] (menor lance primeiro)
--   qidx            posição atual da fila; played = última posição já tocada
--   winner          quem venceu o leilão (menor lance), null se ninguém deu lance
-- =====================================================================

alter table public.npl_rounds add column if not exists auction jsonb not null default '{}'::jsonb;

-- ---------------------------------------------------------------------
-- Configuração: mode / modePool aceitam "classic" e "auction"
-- ---------------------------------------------------------------------
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
-- Qual parte vale nesta rodada?
--   Clássico: música sempre; artista só em "Artista e música".
--   Leilão: dica "artist" -> só a música; dica "genre" -> só o artista.
-- ---------------------------------------------------------------------
create or replace function public.npl_part_counts(p_round public.npl_rounds, p_scoring text, p_part text)
returns boolean
language sql immutable
set search_path = public
as $$
  select coalesce(case
    when p_round.mode = 'auction' then
      case when p_part = 'artist' then p_round.auction->>'hint' = 'genre'
           else p_round.auction->>'hint' = 'artist' end
    when p_part = 'artist' then coalesce(p_scoring, 'artist_title') = 'artist_title'
    else true end, false)
$$;

-- ---------------------------------------------------------------------
-- Leilão: início, lance/"Pode tocar!" e fechamento (funções internas)
-- ---------------------------------------------------------------------
-- Monta o leilão quando a rodada abre. p_meta (da TV, via Deezer):
-- {genre, year, compilation}. Sem gênero/ano confiável -> dica "artist".
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

-- Fecha o leilão: fila do menor lance para o maior; quem nunca deu lance
-- entra no fim, com 20 s, na ordem do rodízio.
create or replace function public.npl_auction_close(a jsonb)
returns jsonb
language plpgsql immutable
set search_path = public
as $$
declare
  v_bids jsonb := coalesce(a->'bids', '{}'::jsonb);
  v_queue jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object('team', k, 'secs', v::int) order by v::int, k), '[]'::jsonb)
    into v_queue
    from jsonb_each_text(v_bids) as b(k, v);
  v_queue := v_queue || coalesce((
    select jsonb_agg(jsonb_build_object('team', o, 'secs', 20) order by n)
      from jsonb_array_elements_text(coalesce(a->'order', '[]'::jsonb)) with ordinality as t(o, n)
     where not (v_bids ? o)), '[]'::jsonb);
  return a || jsonb_build_object(
    'phase', 'proving', 'turn', null, 'turn_deadline', null,
    'queue', v_queue, 'qidx', 0, 'played', -1, 'winner', a->'low_team');
end $$;

-- Aplica a ação do time da vez: lance (p_secs) ou "Pode tocar!" (p_secs null).
-- Fecha quando, depois do último lance, todos os outros disseram "Pode tocar!"
-- (sem lance nenhum: quando todos disseram). Lance de 1 s fecha na hora.
create or replace function public.npl_auction_apply(a jsonb, p_team uuid, p_secs int, p_now timestamptz)
returns jsonb
language plpgsql immutable
set search_path = public
as $$
declare
  v_t text := p_team::text;
  v_order text[] := array(select jsonb_array_elements_text(coalesce(a->'order', '[]'::jsonb)));
  v_n int := cardinality(v_order);
  v_low_team text;
  v_passes int;
  v_i int;
  v_k int;
  v_next text;
begin
  a := jsonb_set(a, '{log}', coalesce(a->'log', '[]'::jsonb)
         || jsonb_build_array(jsonb_build_object('team', v_t, 'secs', p_secs, 'at', p_now)));
  if p_secs is not null then
    a := a || jsonb_build_object(
      'bids', coalesce(a->'bids', '{}'::jsonb) || jsonb_build_object(v_t, p_secs),
      'low', p_secs, 'low_team', v_t, 'passes', '[]'::jsonb);
  elsif not (coalesce(a->'passes', '[]'::jsonb) ? v_t) then
    a := jsonb_set(a, '{passes}', coalesce(a->'passes', '[]'::jsonb) || to_jsonb(v_t));
  end if;

  v_low_team := a->>'low_team';
  v_passes := jsonb_array_length(coalesce(a->'passes', '[]'::jsonb));
  if (v_low_team is null and v_passes >= v_n)
     or (v_low_team is not null and ((a->>'low')::int <= 1 or v_passes >= v_n - 1)) then
    return public.npl_auction_close(a);
  end if;

  -- próximo na ordem do rodízio (quem tem o menor lance não joga contra si mesmo)
  v_i := coalesce(array_position(v_order, v_t), 0);
  for v_k in 1..v_n loop
    v_next := v_order[((v_i - 1 + v_k) % v_n) + 1];
    exit when v_next is distinct from v_low_team;
  end loop;
  return a || jsonb_build_object('turn', v_next, 'turn_deadline', p_now + interval '15 seconds');
end $$;

-- ---------------------------------------------------------------------
-- Pausa: além do tempo de resposta e do bloqueio, o turno do leilão
-- também fica congelado.
-- ---------------------------------------------------------------------
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
    update public.npl_rooms set paused = false, paused_at = null, pause_reason = null where id = p_room.id;
    return true;
  end if;
  return false;
end $$;

-- ---------------------------------------------------------------------
-- A TV carregou o áudio: abre a rodada. No leilão, monta a dica e os lances.
-- p_meta = {genre, year, compilation} do álbum (Deezer).
-- ---------------------------------------------------------------------
drop function if exists public.npl_round_begin(text, text, uuid, jsonb, jsonb);
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

  update public.npl_rounds
     set status = 'playing', stage = 1, stage_started_at = v_now, started_at = now(),
         offsets = v_offsets, play_seq = 0, played_stage = 0, play_at = null,
         auction = v_auction
   where id = v_round.id
  returning * into v_round;
  perform public.npl_touch(v_room.id, 'round');
  return to_jsonb(v_round);
end $$;

-- ---------------------------------------------------------------------
-- Lance (p_secs = 1..19, menor que o atual) ou "Pode tocar!" (p_secs null).
-- Só o time da vez; vale o primeiro envio de qualquer pessoa do time.
-- ---------------------------------------------------------------------
create or replace function public.npl_auction_bid(p_code text, p_token text, p_round_id uuid, p_secs int default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.npl_rooms := public.npl_lock_room(p_code);
  v_player public.npl_players := public.npl_player_by_token(v_room.id, p_token);
  v_round public.npl_rounds;
  v_a jsonb;
  v_now timestamptz;
begin
  if v_player.team_id is null then return jsonb_build_object('ok', false, 'reason', 'no_team'); end if;

  -- um turno vencido conta como "Pode tocar!" antes de olhar este envio
  if public.npl_expire_overdue(v_room) then
    perform public.npl_touch(v_room.id, 'timeout');
  end if;

  select * into v_round from public.npl_rounds
   where id = p_round_id and room_id = v_room.id and match_no = v_room.match_no and round_no = v_room.round_no
   for update;
  if not found or v_round.mode <> 'auction' or v_round.status <> 'playing'
     or coalesce(v_round.auction->>'phase', '') <> 'bidding' then
    return jsonb_build_object('ok', false, 'reason', 'closed');
  end if;
  if v_room.paused then return jsonb_build_object('ok', false, 'reason', 'paused'); end if;
  if v_player.active_from_round > v_round.round_no then
    return jsonb_build_object('ok', false, 'reason', 'not_yet');
  end if;

  v_a := v_round.auction;
  v_now := clock_timestamp();
  if v_now < (v_a->>'starts_at')::timestamptz then
    return jsonb_build_object('ok', false, 'reason', 'not_started');
  end if;
  if v_a->>'turn' is distinct from v_player.team_id::text then
    return jsonb_build_object('ok', false, 'reason', 'not_your_turn');
  end if;
  if p_secs is not null and (p_secs < 1 or p_secs > 19 or p_secs >= (v_a->>'low')::int) then
    return jsonb_build_object('ok', false, 'reason', 'bad_bid', 'low', (v_a->>'low')::int);
  end if;

  v_a := public.npl_auction_apply(v_a, v_player.team_id, p_secs, v_now);
  update public.npl_rounds set auction = v_a where id = v_round.id;
  perform public.npl_touch(v_room.id, 'bid', jsonb_build_object('team_id', v_player.team_id, 'secs', p_secs));
  return jsonb_build_object('ok', true, 'phase', v_a->>'phase');
end $$;

-- ---------------------------------------------------------------------
-- Prova em fila: "Tocar" para o time da vez (uma vez só por time).
-- Cria a vez de resposta já com o prazo = trecho + tempo de resposta.
-- p_idx = posição da fila que quem comanda está vendo (evita toque duplo).
-- ---------------------------------------------------------------------
create or replace function public.npl_auction_play(p_code text, p_owner_token text, p_round_id uuid, p_idx int)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.npl_rooms := public.npl_lock_room(p_code);
  v_round public.npl_rounds;
  v_entry jsonb;
  v_secs int;
  v_ans int := coalesce((v_room.settings->>'answerSeconds')::int, 20);
  v_att public.npl_attempts;
  v_now timestamptz;
begin
  perform public.npl_require_owner(v_room, p_owner_token);
  select * into v_round from public.npl_rounds where id = p_round_id and room_id = v_room.id for update;
  if not found then raise exception 'npl:round_not_found'; end if;
  if v_room.paused or v_round.mode <> 'auction' or v_round.status <> 'playing'
     or coalesce(v_round.auction->>'phase', '') <> 'proving'
     or (v_round.auction->>'qidx')::int is distinct from p_idx
     or coalesce((v_round.auction->>'played')::int, -1) >= p_idx then
    return jsonb_build_object('ok', false);
  end if;
  v_entry := v_round.auction->'queue'->p_idx;
  if v_entry is null then return jsonb_build_object('ok', false); end if;
  v_secs := least(20, greatest(1, (v_entry->>'secs')::int));
  v_now := clock_timestamp();

  insert into public.npl_attempts (room_id, round_id, team_id, player_id, kind, status, created_at, deadline,
                                   stage, stage_points, ms_into_stage, steal)
  values (v_room.id, v_round.id, (v_entry->>'team')::uuid, null, 'turn', 'open', v_now,
          case when v_ans > 0 then v_now + make_interval(secs => v_secs + v_ans) end,
          v_secs, 100, 0, p_idx > 0)
  returning * into v_att;

  update public.npl_rounds
     set status = 'answering', current_attempt_id = v_att.id,
         play_seq = play_seq + 1, play_at = v_now, played_stage = 1, stage = 1, stage_started_at = v_now,
         auction = jsonb_set(auction, '{played}', to_jsonb(p_idx))
   where id = v_round.id;
  perform public.npl_touch(v_room.id, 'play', jsonb_build_object('team_id', v_att.team_id));
  return jsonb_build_object('ok', true, 'attempt_id', v_att.id);
end $$;

-- ---------------------------------------------------------------------
-- Clássico: "Tocar"/"Próximo trecho" e "EU SEI!" não valem no leilão
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
  if v_room.paused or v_round.status <> 'playing' or v_round.stage <> p_stage or v_round.mode = 'auction'
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
-- Prazos vencidos: turno do leilão (= "Pode tocar!") e tempo de resposta
-- ---------------------------------------------------------------------
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

  if v_round.status <> 'answering' then return false; end if;
  select * into v_att from public.npl_attempts where id = v_round.current_attempt_id;
  if not found or v_att.status <> 'open' or v_att.deadline is null
     or clock_timestamp() < v_att.deadline + interval '1.5 seconds' then
    return false;
  end if;
  perform public.npl_finalize_attempt(v_att.id, 'timeout', 'auto');
  return true;
end $$;

-- ---------------------------------------------------------------------
-- Pontuação. Leilão: 100 pontos fixos para o primeiro que acertou a parte
-- que vale; sem penalidade por erro.
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

-- Fecha a tentativa. Leilão: errou/tempo esgotado -> a vez passa para o
-- próximo da fila (que ouve o próprio lance); fim da fila -> revelação.
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

-- ---------------------------------------------------------------------
-- Respostas: conferem só as partes que valem nesta rodada
-- ---------------------------------------------------------------------
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

  v_a := public.npl_part_counts(v_round, v_scoring, 'artist') and coalesce(p_artist, false) and not (v_round.found ? 'artist');
  v_t := public.npl_part_counts(v_round, v_scoring, 'title') and coalesce(p_title, false) and not (v_round.found ? 'title');
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

  v_a := public.npl_part_counts(v_round, v_scoring, 'artist') and coalesce(p_artist, false);
  v_t := public.npl_part_counts(v_round, v_scoring, 'title') and coalesce(p_title, false);
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

-- ---------------------------------------------------------------------
-- Funções internas: ninguém de fora executa
-- ---------------------------------------------------------------------
revoke execute on function
  public.npl_clean_settings(jsonb),
  public.npl_part_counts(public.npl_rounds, text, text),
  public.npl_auction_start(public.npl_rounds, jsonb, timestamptz),
  public.npl_auction_close(jsonb),
  public.npl_auction_apply(jsonb, uuid, int, timestamptz),
  public.npl_set_paused(public.npl_rooms, boolean, text),
  public.npl_expire_overdue(public.npl_rooms),
  public.npl_rescore_round(uuid),
  public.npl_finalize_attempt(uuid, text, text)
  from public, anon, authenticated;
