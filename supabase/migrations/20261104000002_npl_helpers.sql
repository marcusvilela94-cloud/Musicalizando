-- =====================================================================
-- Musicalizando — 002: funções auxiliares internas (não expostas)
-- =====================================================================

-- Paleta de cores dos times (12 cores bem distintas) ------------------
create or replace function public.npl_palette()
returns jsonb
language sql immutable
set search_path = public
as $$
  select '[
    {"name":"Vermelho","color":"#EF4444"},
    {"name":"Azul","color":"#3B82F6"},
    {"name":"Verde","color":"#22C55E"},
    {"name":"Amarelo","color":"#FACC15"},
    {"name":"Roxo","color":"#A855F7"},
    {"name":"Laranja","color":"#F97316"},
    {"name":"Rosa","color":"#F472B6"},
    {"name":"Ciano","color":"#22D3EE"},
    {"name":"Lima","color":"#A3E635"},
    {"name":"Marrom","color":"#A0522D"},
    {"name":"Branco","color":"#F8FAFC"},
    {"name":"Vinho","color":"#9F1239"}
  ]'::jsonb
$$;

-- Configuração padrão + saneamento ------------------------------------
create or replace function public.npl_default_settings()
returns jsonb
language sql immutable
set search_path = public
as $$
  select jsonb_build_object(
    'mode', 'classic',              -- modo fixo da partida
    'modeSelection', 'fixed',       -- fase 2: 'random' sorteia entre modePool a cada rodada
    'modePool', jsonb_build_array('classic'),
    'rounds', 10,
    'answerSeconds', 20,            -- 0 = sem limite
    'penalty', 0,
    'scoring', 'artist_title',      -- artist_title | title
    'teamMode', 'teams',            -- teams | solo (cada um por si)
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

-- Pontos por estágio (por modo; a fase 2 adiciona outros modos aqui) ---
create or replace function public.npl_stage_count(p_mode text)
returns int
language sql immutable
set search_path = public
as $$ select case p_mode when 'classic' then 6 else 6 end $$;

create or replace function public.npl_stage_points(p_mode text, p_stage int)
returns int
language sql immutable
set search_path = public
as $$
  select case p_mode
    when 'classic' then (array[100, 80, 60, 40, 25, 10])[greatest(1, least(6, p_stage))]
    else (array[100, 80, 60, 40, 25, 10])[greatest(1, least(6, p_stage))]
  end
$$;

-- Conferência de respostas --------------------------------------------
-- Título: ignora o que está entre ()/[] , depois de " - " e "feat./ft."
create or replace function public.npl_clean_title(t text)
returns text
language plpgsql immutable
set search_path = public
as $$
declare s text := coalesce(t, '');
begin
  s := regexp_replace(s, '\([^)]*\)', ' ', 'g');
  s := regexp_replace(s, '\[[^\]]*\]', ' ', 'g');
  s := regexp_replace(s, '\s+-\s+.*$', '');
  s := regexp_replace(s, '\s(feat|ft|featuring)\.?\s.*$', '', 'i');
  if btrim(s) = '' then return coalesce(t, ''); end if;
  return s;
end $$;

-- minúsculas, sem acentos, sem pontuação, sem artigo inicial, sem "e/and/&"
create or replace function public.npl_normalize(t text)
returns text
language plpgsql immutable
set search_path = public
as $$
declare s text := coalesce(t, '');
begin
  s := translate(s,
    'ÁÀÂÃÄÅáàâãäåÉÈÊËéèêëÍÌÎÏíìîïÓÒÔÕÖØóòôõöøÚÙÛÜúùûüÇçÑñÝýÿ',
    'AAAAAAaaaaaaEEEEeeeeIIIIiiiiOOOOOOooooooUUUUuuuuCcNnYyy');
  s := lower(s);
  s := replace(s, '&', ' e ');
  s := regexp_replace(s, '[''’`´]', '', 'g');          -- don't -> dont
  s := regexp_replace(s, '[^a-z0-9]+', ' ', 'g');
  s := ' ' || btrim(s) || ' ';
  s := regexp_replace(s, ' (e|and|y) ', ' ', 'g');
  s := regexp_replace(s, ' (e|and|y) ', ' ', 'g');
  s := btrim(regexp_replace(s, '\s+', ' ', 'g'));
  s := regexp_replace(s, '^(o|a|os|as|the) ', '');
  return s;
end $$;

create or replace function public.npl_levenshtein(a text, b text)
returns int
language plpgsql immutable
set search_path = public
as $$
declare
  la int := length(a);
  lb int := length(b);
  prev int[];
  cur int[];
  i int;
  j int;
  cost int;
begin
  if la = 0 then return lb; end if;
  if lb = 0 then return la; end if;
  prev := array(select generate_series(0, lb));
  for i in 1..la loop
    cur := array[i];
    for j in 1..lb loop
      cost := case when substr(a, i, 1) = substr(b, j, 1) then 0 else 1 end;
      cur := cur || least(prev[j + 1] + 1, cur[j] + 1, prev[j] + cost);
    end loop;
    prev := cur;
  end loop;
  return prev[lb + 1];
end $$;

-- diferença normalizada 0..1 entre dois textos já normalizados
create or replace function public.npl_distance(a text, b text)
returns numeric
language plpgsql immutable
set search_path = public
as $$
declare
  d1 numeric;
  d2 numeric;
  a2 text := replace(a, ' ', '');
  b2 text := replace(b, ' ', '');
begin
  if a = b or a2 = b2 then return 0; end if;
  d1 := public.npl_levenshtein(a, b)::numeric / greatest(length(a), length(b), 1);
  d2 := public.npl_levenshtein(a2, b2)::numeric / greatest(length(a2), length(b2), 1);
  return least(d1, d2);
end $$;

-- classifica resposta contra uma lista de respostas certas:
-- ok (<= 20%), doubt (20%..40%), wrong (> 40%), empty (campo vazio)
create or replace function public.npl_classify(p_answer text, p_candidates text[], p_is_title boolean)
returns text
language plpgsql immutable
set search_path = public
as $$
declare
  v_ans text;
  v_c text;
  v_best numeric := 1;
  v_norm text;
begin
  v_ans := left(coalesce(p_answer, ''), 120);
  if p_is_title then v_ans := public.npl_clean_title(v_ans); end if;
  v_ans := public.npl_normalize(v_ans);
  if v_ans = '' then return 'empty'; end if;
  foreach v_c in array coalesce(p_candidates, array[]::text[]) loop
    if p_is_title then v_c := public.npl_clean_title(v_c); end if;
    v_norm := public.npl_normalize(v_c);
    if v_norm <> '' then
      v_best := least(v_best, public.npl_distance(v_ans, v_norm));
    end if;
  end loop;
  if v_best <= 0.20 then return 'ok'; end if;
  if v_best <= 0.40 then return 'doubt'; end if;
  return 'wrong';
end $$;

-- Infra de sala ---------------------------------------------------------
create or replace function public.npl_hash(p_token text)
returns text
language sql immutable
set search_path = public
as $$ select md5('npl:' || coalesce(p_token, '')) $$;

create or replace function public.npl_lock_room(p_code text)
returns public.npl_rooms
language plpgsql
set search_path = public
as $$
declare v public.npl_rooms;
begin
  select * into v from public.npl_rooms where code = btrim(p_code) for update;
  if not found then raise exception 'npl:room_not_found'; end if;
  return v;
end $$;

create or replace function public.npl_require_owner(p_room public.npl_rooms, p_owner_token text)
returns void
language plpgsql
set search_path = public
as $$
begin
  if p_owner_token is null or p_room.owner_hash <> public.npl_hash(p_owner_token) then
    raise exception 'npl:not_owner';
  end if;
end $$;

create or replace function public.npl_player_by_token(p_room_id uuid, p_token text)
returns public.npl_players
language plpgsql
set search_path = public
as $$
declare v public.npl_players;
begin
  select * into v from public.npl_players where room_id = p_room_id and token_hash = public.npl_hash(p_token);
  if not found then raise exception 'npl:player_not_found'; end if;
  return v;
end $$;

-- Avisa os clientes (Supabase Realtime Broadcast, canal público npl_room_<id>).
-- Se o Realtime não estiver disponível os clientes continuam via polling.
create or replace function public.npl_notify(p_room_id uuid, p_kind text, p_extra jsonb default '{}'::jsonb)
returns void
language plpgsql
set search_path = public
as $$
begin
  begin
    perform realtime.send(
      jsonb_build_object('kind', p_kind) || coalesce(p_extra, '{}'::jsonb),
      'sync',
      'npl_room_' || p_room_id::text,
      false);
  exception when others then
    null;
  end;
end $$;

create or replace function public.npl_touch(p_room_id uuid, p_kind text, p_extra jsonb default '{}'::jsonb)
returns void
language plpgsql
set search_path = public
as $$
declare v_version bigint;
begin
  update public.npl_rooms
     set version = version + 1, last_activity_at = now()
   where id = p_room_id
  returning version into v_version;
  perform public.npl_notify(p_room_id, p_kind, coalesce(p_extra, '{}'::jsonb) || jsonb_build_object('v', v_version));
end $$;

-- Placar = soma das tentativas da partida + correções manuais
create or replace function public.npl_recalc_scores(p_room_id uuid)
returns void
language plpgsql
set search_path = public
as $$
declare v_match int;
begin
  select match_no into v_match from public.npl_rooms where id = p_room_id;
  update public.npl_teams t
     set score =
       coalesce((select sum(a.points) from public.npl_attempts a
                   join public.npl_rounds r on r.id = a.round_id
                  where a.team_id = t.id and r.match_no = v_match), 0)
     + coalesce((select sum(s.delta) from public.npl_score_adjustments s
                  where s.team_id = t.id and s.match_no = v_match), 0)
   where t.room_id = p_room_id;
end $$;

-- Cria um time com a próxima cor livre da paleta
create or replace function public.npl_add_team(p_room_id uuid, p_name text default null)
returns public.npl_teams
language plpgsql
set search_path = public
as $$
declare
  v_pal jsonb := public.npl_palette();
  v_idx int;
  v_color jsonb;
  v_team public.npl_teams;
  i int;
begin
  select coalesce(max(idx), -1) + 1 into v_idx from public.npl_teams where room_id = p_room_id;
  v_color := null;
  for i in 0 .. jsonb_array_length(v_pal) - 1 loop
    if not exists (select 1 from public.npl_teams where room_id = p_room_id and color = v_pal->i->>'color') then
      v_color := v_pal->i;
      exit;
    end if;
  end loop;
  if v_color is null then v_color := v_pal->(v_idx % jsonb_array_length(v_pal)); end if;
  insert into public.npl_teams (room_id, idx, name, color)
  values (p_room_id, v_idx,
          coalesce(nullif(btrim(p_name), ''), 'Time ' || (v_color->>'name')),
          v_color->>'color')
  returning * into v_team;
  return v_team;
end $$;

-- Ajusta os times às configurações (nº de times ou "cada um por si")
create or replace function public.npl_apply_team_layout(p_room_id uuid)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_settings jsonb;
  v_count int;
  v_have int;
  v_player record;
  v_team public.npl_teams;
  v_claimed uuid[] := array[]::uuid[];
begin
  select settings into v_settings from public.npl_rooms where id = p_room_id;
  if v_settings->>'teamMode' = 'solo' then
    -- um time por jogador: o mais antigo de cada time fica nele, os outros ganham time próprio
    delete from public.npl_teams t
     where t.room_id = p_room_id
       and not exists (select 1 from public.npl_players p where p.team_id = t.id);
    for v_player in
      select p.* from public.npl_players p where p.room_id = p_room_id order by p.joined_at
    loop
      if v_player.team_id is null or v_player.team_id = any(v_claimed) then
        v_team := public.npl_add_team(p_room_id, v_player.nickname);
        update public.npl_players set team_id = v_team.id where id = v_player.id;
        v_claimed := v_claimed || v_team.id;
      else
        v_claimed := v_claimed || v_player.team_id;
      end if;
    end loop;
  else
    v_count := (v_settings->>'teamCount')::int;
    select count(*) into v_have from public.npl_teams where room_id = p_room_id;
    while v_have < v_count loop
      perform public.npl_add_team(p_room_id, null);
      v_have := v_have + 1;
    end loop;
    if v_have > v_count then
      delete from public.npl_teams
       where id in (select id from public.npl_teams where room_id = p_room_id
                     order by idx desc limit (v_have - v_count));
    end if;
  end if;
end $$;

-- Revela a música da rodada (copia título/artista/capa para a rodada)
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
           'album', v_track.album)
   where id = p_round_id;
end $$;

-- Calcula pontos de uma tentativa a partir dos resultados por campo
create or replace function public.npl_attempt_points(p_attempt public.npl_attempts, p_scoring text)
returns int
language plpgsql immutable
set search_path = public
as $$
declare v_pts numeric := 0;
begin
  if p_attempt.title_result = 'ok' then
    v_pts := case when p_scoring = 'artist_title' then p_attempt.stage_points * 1.5 else p_attempt.stage_points end;
  elsif p_scoring = 'artist_title' and p_attempt.artist_result = 'ok' then
    v_pts := p_attempt.stage_points;
  end if;
  if p_attempt.steal then v_pts := v_pts / 2; end if;
  return round(v_pts)::int;
end $$;

-- Fecha uma tentativa (resultados dos campos já definidos, sem "doubt")
create or replace function public.npl_finalize_attempt(p_attempt_id uuid, p_status_if_wrong text, p_decided_by text)
returns text
language plpgsql
set search_path = public
as $$
declare
  v_att public.npl_attempts;
  v_round public.npl_rounds;
  v_room public.npl_rooms;
  v_pts int;
  v_pen int;
begin
  select * into v_att from public.npl_attempts where id = p_attempt_id;
  select * into v_round from public.npl_rounds where id = v_att.round_id;
  select * into v_room from public.npl_rooms where id = v_att.room_id;
  v_pts := public.npl_attempt_points(v_att, v_room.settings->>'scoring');
  v_pen := coalesce((v_room.settings->>'penalty')::int, 0);

  if v_pts > 0 then
    update public.npl_attempts
       set status = 'correct', points = v_pts, decided_by = p_decided_by, decided_at = now()
     where id = v_att.id;
    update public.npl_rounds
       set winner_team_id = v_att.team_id, points = v_pts
     where id = v_round.id;
    perform public.npl_reveal_round(v_round.id, false);
    perform public.npl_recalc_scores(v_room.id);
    return 'correct';
  else
    update public.npl_attempts
       set status = p_status_if_wrong, points = -v_pen, decided_by = p_decided_by, decided_at = now()
     where id = v_att.id;
    -- só o último time que errou fica bloqueado; a música continua de onde parou
    update public.npl_rounds
       set status = 'playing', current_attempt_id = null,
           locked_team_id = v_att.team_id, had_error = true
     where id = v_round.id;
    perform public.npl_recalc_scores(v_room.id);
    return p_status_if_wrong;
  end if;
end $$;

-- Expira tentativas cujo tempo acabou (tolerância de 1,5 s para a rede)
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
  if not found or v_round.status <> 'answering' then return false; end if;
  select * into v_att from public.npl_attempts where id = v_round.current_attempt_id;
  if not found or v_att.status <> 'open' or v_att.deadline is null
     or clock_timestamp() < v_att.deadline + interval '1.5 seconds' then
    return false;
  end if;
  perform public.npl_finalize_attempt(v_att.id, 'timeout', 'auto');
  return true;
end $$;

-- Funções internas: ninguém de fora executa
revoke execute on function
  public.npl_clean_settings(jsonb),
  public.npl_lock_room(text),
  public.npl_require_owner(public.npl_rooms, text),
  public.npl_player_by_token(uuid, text),
  public.npl_notify(uuid, text, jsonb),
  public.npl_touch(uuid, text, jsonb),
  public.npl_recalc_scores(uuid),
  public.npl_add_team(uuid, text),
  public.npl_apply_team_layout(uuid),
  public.npl_reveal_round(uuid, boolean),
  public.npl_attempt_points(public.npl_attempts, text),
  public.npl_finalize_attempt(uuid, text, text),
  public.npl_expire_overdue(public.npl_rooms)
  from public, anon, authenticated;
