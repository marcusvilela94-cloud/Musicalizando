-- =====================================================================
-- Musicalizando — 020: modo "Instrumentos" (faixas separadas pelo Demucs).
-- Aplicar DEPOIS da 019. Pode rodar mais de uma vez.
--
-- A separação roda FORA do site (separador/, no PC, com a chave service_role):
--   npl_stems_queue  fila de pedidos (pending -> processing -> ready | error)
--   npl_stems_cache  faixas prontas: bucket npl_stems/<key>/<faixa>.mp3
--   npl_stems_worker sinal de vida do separador (a cada 30 s)
-- O jogo NÃO grava no Storage: só pede (npl_stems_request) e lê o cache
-- (npl_stems_status). Trocar o separador (ex.: Hugging Face Space) = outro
-- programa chamando as mesmas RPCs npl_stems_claim/done/fail/heartbeat/evict.
--
-- Rodada (npl_rounds.stems): {variant, key, layers, points, instrument}
--   layers: bateria -> + baixo -> + guitarra (se audível) -> + voz; 100/75/50/20
--   single: um instrumento, trechos de 5/15/30 s valendo 100/60/30
-- =====================================================================


-- ---------------------------------------------------------------------
-- Fila, cache e sinal de vida (só o separador, com service_role, escreve)
-- ---------------------------------------------------------------------
create table if not exists public.npl_stems_queue (
  deezer_id    bigint primary key,
  status       text not null default 'pending' check (status in ('pending', 'processing', 'ready', 'error')),
  requested_at timestamptz not null default now(),
  started_at   timestamptz,
  finished_at  timestamptz,
  attempts     int not null default 0,
  error        text
);
create index if not exists npl_stems_queue_pending on public.npl_stems_queue (status, requested_at);

create table if not exists public.npl_stems_cache (
  deezer_id    bigint primary key,
  key          text not null unique,          -- pasta no bucket (opaca: não revela a música)
  paths        jsonb not null,                -- {"drums": "<key>/drums.mp3", ...}
  bytes        bigint not null default 0,     -- tamanho total das 4 faixas
  audible      jsonb not null,                -- {"drums": true, "guitar": false, ...}
  levels       jsonb not null default '{}'::jsonb, -- RMS (dB) de cada faixa, para conferência
  created_at   timestamptz not null default now(),
  last_used_at timestamptz not null default now()
);
create index if not exists npl_stems_cache_lru on public.npl_stems_cache (last_used_at);

create table if not exists public.npl_stems_worker (
  id        int primary key default 1 check (id = 1),
  last_seen timestamptz,
  info      jsonb not null default '{}'::jsonb
);
insert into public.npl_stems_worker (id) values (1) on conflict do nothing;

alter table public.npl_stems_queue enable row level security;
alter table public.npl_stems_cache enable row level security;
alter table public.npl_stems_worker enable row level security;
revoke all on public.npl_stems_queue, public.npl_stems_cache, public.npl_stems_worker from anon, authenticated;

-- bucket público (só leitura: ninguém além da service_role consegue gravar)
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'buckets') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('npl_stems', 'npl_stems', true, 2097152, array['audio/mpeg'])
    on conflict (id) do update set public = true;
  end if;
end $$;

alter table public.npl_rounds add column if not exists stems jsonb not null default '{}'::jsonb;
alter table public.npl_tracks add column if not exists stems jsonb;

-- ---------------------------------------------------------------------
-- Plano da rodada
-- ---------------------------------------------------------------------
-- p (vindo de quem começa a partida): {key, variant, layers, instrument}
create or replace function public.npl_clean_stems(p jsonb)
returns jsonb
language plpgsql immutable
set search_path = public
as $$
declare
  v_layers jsonb;
  v_variant text := case when p->>'variant' = 'single' then 'single' else 'layers' end;
  v_inst text;
begin
  if jsonb_typeof(p) <> 'object' or coalesce(p->>'key', '') !~ '^[a-z0-9-]{8,64}$' then return null; end if;
  -- camadas na ordem do jogo, sem repetir; a voz (música completa) sempre fecha
  select coalesce(jsonb_agg(to_jsonb(l) order by array_position(array['drums', 'bass', 'guitar', 'vocals'], l)), '[]'::jsonb)
    into v_layers
    from (select distinct e #>> '{}' as l
            from jsonb_array_elements(case when jsonb_typeof(p->'layers') = 'array' then p->'layers' else '[]'::jsonb end) e
           where jsonb_typeof(e) = 'string' and e #>> '{}' in ('drums', 'bass', 'guitar', 'vocals')) q;
  if not v_layers ? 'vocals' then v_layers := v_layers || '["vocals"]'::jsonb; end if;
  v_inst := case when p->>'instrument' in ('drums', 'bass', 'guitar', 'vocals') then p->>'instrument' else 'drums' end;
  return jsonb_build_object('key', p->>'key', 'variant', v_variant, 'layers', v_layers, 'instrument', v_inst);
end $$;

-- O que todos veem na rodada: camadas/instrumento e os pontos de cada estágio
create or replace function public.npl_stems_view(p jsonb)
returns jsonb
language sql immutable
set search_path = public
as $$
  select case when p->>'variant' = 'single' then
    jsonb_build_object('variant', 'single', 'key', p->>'key', 'instrument', p->>'instrument',
                       'secs', '[5, 15, 30]'::jsonb, 'points', '[100, 60, 30]'::jsonb)
  else
    jsonb_build_object('variant', 'layers', 'key', p->>'key', 'layers', p->'layers',
      'points', (select jsonb_agg(to_jsonb(case l when 'drums' then 100 when 'bass' then 75 when 'guitar' then 50 else 20 end) order by n)
                   from jsonb_array_elements_text(p->'layers') with ordinality as x(l, n)))
  end
$$;

-- Pontos do estágio atual da rodada (Instrumentos: do plano; os outros modos: npl_stage_points)
create or replace function public.npl_round_points(p_round public.npl_rounds)
returns int
language sql immutable
set search_path = public
as $$
  select case when p_round.mode = 'stems' and jsonb_typeof(p_round.stems->'points') = 'array'
              then coalesce((p_round.stems->'points'->>(least(greatest(1, p_round.stage),
                              jsonb_array_length(p_round.stems->'points')) - 1))::int, 0)
              else public.npl_stage_points(p_round.mode, greatest(1, p_round.stage)) end
$$;

-- ---------------------------------------------------------------------
-- RPCs do jogo (leem o cache e pedem; não gravam no Storage)
-- ---------------------------------------------------------------------
-- Quais destas músicas já estão prontas, como está a fila e se o separador está ligado
create or replace function public.npl_stems_status(p_ids bigint[])
returns jsonb
language sql stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'worker', (select jsonb_build_object('last_seen', w.last_seen,
                        'alive', coalesce(w.last_seen > now() - interval '1 minute', false),
                        'info', w.info)
                 from public.npl_stems_worker w where w.id = 1),
    'ready', coalesce((select jsonb_agg(jsonb_build_object('deezer_id', c.deezer_id, 'key', c.key, 'audible', c.audible))
                         from public.npl_stems_cache c
                        where c.deezer_id = any (coalesce(p_ids[1:300], '{}'))), '[]'::jsonb),
    'queue', coalesce((select jsonb_object_agg(q.status, q.n) from (
                         select status, count(*) as n from public.npl_stems_queue
                          where deezer_id = any (coalesce(p_ids[1:300], '{}')) and status <> 'ready'
                          group by status) q), '{}'::jsonb),
    'errors', coalesce((select jsonb_agg(jsonb_build_object('deezer_id', q.deezer_id, 'error', q.error))
                          from public.npl_stems_queue q
                         where q.deezer_id = any (coalesce(p_ids[1:300], '{}')) and q.status = 'error'), '[]'::jsonb),
    'cache', (select jsonb_build_object('songs', count(*), 'bytes', coalesce(sum(bytes), 0)) from public.npl_stems_cache))
$$;

-- Coloca na fila as que ainda não estão prontas (as que deram erro voltam para a fila)
create or replace function public.npl_stems_request(p_code text, p_owner_token text, p_ids bigint[])
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.npl_rooms := public.npl_lock_room(p_code);
  v_n int;
begin
  perform public.npl_require_host(v_room, p_owner_token);
  with ids as (
    select distinct i from unnest(coalesce(p_ids[1:150], '{}')) as i
     where i > 0 and not exists (select 1 from public.npl_stems_cache c where c.deezer_id = i)
  ), up as (
    insert into public.npl_stems_queue (deezer_id, status, requested_at)
    select i, 'pending', now() from ids
    on conflict (deezer_id) do update
       set status = 'pending', requested_at = now(), error = null
     where npl_stems_queue.status in ('error', 'ready')
    returning 1
  )
  select count(*) into v_n from up;
  return v_n;
end $$;

-- A partida vai usar estas: atualiza o "último uso" (o separador apaga as mais antigas)
create or replace function public.npl_stems_touch(p_code text, p_owner_token text, p_ids bigint[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.npl_rooms := public.npl_lock_room(p_code);
begin
  perform public.npl_require_host(v_room, p_owner_token);
  update public.npl_stems_cache set last_used_at = now() where deezer_id = any (coalesce(p_ids[1:60], '{}'));
end $$;

-- Segundo plano: põe uma música que ficou pronta numa rodada de Instrumentos que ainda não começou
create or replace function public.npl_fill_stems(p_code text, p_owner_token text, p_match int, p_position int,
                                                 p_track jsonb, p_prep jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.npl_rooms := public.npl_lock_room(p_code);
  v_stems jsonb;
  v_ok boolean := false;
begin
  perform public.npl_require_host(v_room, p_owner_token);
  if v_room.match_no is distinct from p_match or v_room.phase <> 'playing' then
    return jsonb_build_object('ok', false, 'reason', 'match');
  end if;
  if jsonb_typeof(p_track) = 'object' then
    v_stems := public.npl_clean_stems(p_track->'stems');
    if v_stems is not null and p_position > v_room.round_no and p_position <= v_room.total_rounds
       and not exists (select 1 from public.npl_rounds
                        where room_id = v_room.id and match_no = v_room.match_no and round_no = p_position) then
      update public.npl_tracks
         set deezer_id = (p_track->>'deezer_id')::bigint,
             title = left(coalesce(p_track->>'title', '?'), 300),
             title_short = left(p_track->>'title_short', 300),
             artist = left(coalesce(p_track->>'artist', '?'), 300),
             artists = case when jsonb_typeof(p_track->'artists') = 'array' then p_track->'artists'
                            else jsonb_build_array(coalesce(p_track->>'artist', '?')) end,
             cover = left(p_track->>'cover', 500),
             album = left(p_track->>'album', 300),
             lyrics = null, cont = null, quiz = null,
             mode = 'stems',
             stems = v_stems
       where room_id = v_room.id and match_no = v_room.match_no and position = p_position;
      v_ok := found;
      update public.npl_stems_cache set last_used_at = now() where deezer_id = (p_track->>'deezer_id')::bigint;
    end if;
  end if;
  if jsonb_typeof(p_prep) = 'object' then
    update public.npl_rooms
       set prep = jsonb_build_object(
             'active', coalesce((p_prep->>'active')::boolean, false),
             'done', greatest(0, coalesce((p_prep->>'done')::int, 0)),
             'total', greatest(0, coalesce((p_prep->>'total')::int, 0)))
     where id = v_room.id;
  end if;
  perform public.npl_touch(v_room.id, 'prep');
  return jsonb_build_object('ok', v_ok, 'round_no', v_room.round_no);
end $$;

-- ---------------------------------------------------------------------
-- RPCs do separador (só service_role)
-- ---------------------------------------------------------------------
-- Pega o próximo pedido (e retoma os que ficaram "processando" por mais de 10 min)
create or replace function public.npl_stems_claim()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v public.npl_stems_queue;
begin
  select * into v from public.npl_stems_queue
   where status = 'pending' or (status = 'processing' and started_at < now() - interval '10 minutes')
   order by (status = 'processing'), requested_at
   limit 1
   for update skip locked;
  if not found then return null; end if;
  update public.npl_stems_queue
     set status = 'processing', started_at = now(), attempts = attempts + 1, error = null
   where deezer_id = v.deezer_id
  returning * into v;
  return to_jsonb(v);
end $$;

create or replace function public.npl_stems_done(p_deezer_id bigint, p_key text, p_paths jsonb, p_bytes bigint,
                                                 p_audible jsonb, p_levels jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.npl_stems_cache (deezer_id, key, paths, bytes, audible, levels, created_at, last_used_at)
  values (p_deezer_id, p_key, p_paths, greatest(0, coalesce(p_bytes, 0)), p_audible, coalesce(p_levels, '{}'::jsonb), now(), now())
  on conflict (deezer_id) do update
     set key = excluded.key, paths = excluded.paths, bytes = excluded.bytes, audible = excluded.audible,
         levels = excluded.levels, created_at = now(), last_used_at = now();
  update public.npl_stems_queue set status = 'ready', finished_at = now(), error = null where deezer_id = p_deezer_id;
end $$;

create or replace function public.npl_stems_fail(p_deezer_id bigint, p_error text)
returns void
language sql
security definer
set search_path = public
as $$
  update public.npl_stems_queue set status = 'error', finished_at = now(), error = left(p_error, 500)
   where deezer_id = p_deezer_id
$$;

create or replace function public.npl_stems_heartbeat(p_info jsonb)
returns void
language sql
security definer
set search_path = public
as $$
  update public.npl_stems_worker set last_seen = now(), info = coalesce(p_info, '{}'::jsonb) where id = 1
$$;

-- Cache acima do limite: tira as usadas há mais tempo até caber e devolve as chaves para apagar os arquivos
create or replace function public.npl_stems_evict(p_limit_bytes bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total bigint;
  v_out jsonb := '[]'::jsonb;
  r public.npl_stems_cache;
begin
  select coalesce(sum(bytes), 0) into v_total from public.npl_stems_cache;
  for r in select * from public.npl_stems_cache order by last_used_at, created_at loop
    exit when v_total <= p_limit_bytes;
    delete from public.npl_stems_cache where deezer_id = r.deezer_id;
    delete from public.npl_stems_queue where deezer_id = r.deezer_id;
    v_total := v_total - r.bytes;
    v_out := v_out || jsonb_build_object('deezer_id', r.deezer_id, 'key', r.key, 'paths', r.paths);
  end loop;
  return v_out;
end $$;

revoke execute on function
  public.npl_clean_stems(jsonb),
  public.npl_stems_view(jsonb),
  public.npl_round_points(public.npl_rounds),
  public.npl_stems_claim(),
  public.npl_stems_done(bigint, text, jsonb, bigint, jsonb, jsonb),
  public.npl_stems_fail(bigint, text),
  public.npl_stems_heartbeat(jsonb),
  public.npl_stems_evict(bigint)
  from public, anon, authenticated;


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
    'stemsVariant', 'layers',       -- Instrumentos: layers = camadas | single = um instrumento só
    'stemsInstrument', 'random',    -- Instrumentos (um só): drums | bass | guitar | vocals | random
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
  v_modes text[] := array['classic', 'auction', 'lyrics', 'continue', 'quiz_open', 'quiz_choice', 'obra', 'stems'];
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
  -- Instrumentos: variante e instrumento
  if coalesce(s->>'stemsVariant', '') not in ('layers', 'single') then
    s := jsonb_set(s, '{stemsVariant}', '"layers"');
  end if;
  if coalesce(s->>'stemsInstrument', '') not in ('drums', 'bass', 'guitar', 'vocals', 'random') then
    s := jsonb_set(s, '{stemsInstrument}', '"random"');
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
    when 'stems' then not coalesce(v_track.stems ? 'key', false)
    else false end;
  if v_bad then
    select array_agg(m) into v_others
      from jsonb_array_elements_text(coalesce(p_settings->'modePool', '[]'::jsonb)) as m
     where m not in ('continue', 'lyrics', 'quiz_open', 'quiz_choice', 'obra', 'stems');
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

  insert into public.npl_tracks (room_id, match_no, position, deezer_id, title, title_short, artist, artists, cover, album, lyrics, mode, cont, quiz, stems)
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
         case when e->>'mode' in ('classic', 'auction', 'lyrics', 'continue', 'quiz_open', 'quiz_choice', 'obra', 'stems')
                   and coalesce(v_room.settings->'modePool', '[]'::jsonb) ? (e->>'mode')
              then e->>'mode' end,
         public.npl_clean_cont(e->'cont'),
         public.npl_clean_quiz(e->'quiz'),
         public.npl_clean_stems(e->'stems')
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
     and p_round.mode in ('classic', 'lyrics', 'continue', 'quiz_open', 'obra', 'stems')
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
  v_stems jsonb := '{}'::jsonb;
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

  -- sem "Tocar": letra (verso já na tela) e alternativas com prévia (toca sozinha)
  v_auto := v_round.mode = 'lyrics'
         or (v_round.mode = 'quiz_choice' and coalesce((v_quiz->>'play')::boolean, true));

  update public.npl_rounds
     set status = 'playing', stage = 1, stage_started_at = v_now, started_at = now(),
         offsets = v_offsets,
         play_seq = case when v_auto then 1 else 0 end,
         played_stage = case when v_auto then 1 else 0 end,
         play_at = case when v_auto then v_now end,
         auction = v_auction, lyrics = v_lyrics, cont = v_cont, quiz = v_quiz, stems = v_stems, turn = '{}'::jsonb,
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

create or replace function public.npl_part_counts(p_round public.npl_rounds, p_scoring text, p_part text)
returns boolean
language sql immutable
set search_path = public
as $$
  select coalesce(case
    when public.npl_is_tiebreak(p_round) then p_part = 'title'
    when p_round.mode in ('continue', 'quiz_open', 'quiz_choice', 'obra') then p_part = 'title'
    -- Instrumentos, só a voz: vale o artista, com bônus pelo título
    when p_round.mode = 'stems' and p_round.stems->>'instrument' = 'vocals' then true
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
  -- um time por vez: sem penalidade (a opção só vale em "Quem sabe primeiro")
  if public.npl_turn_applies(v_room.settings, v_round) then
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
          round(public.npl_round_points(v_round) * p_factor)::int,
          0, p_factor < 1)
  returning id into v_id;
  update public.npl_rounds
     set status = 'answering', current_attempt_id = v_id,
         turn = turn || jsonb_build_object('team', p_team, 'factor', p_factor)
   where id = p_round_id;
  return v_id;
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
                 when v_round.mode = 'stems' then greatest(1, jsonb_array_length(coalesce(v_round.stems->'points', '[]'::jsonb)))
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
           stage_points = round(public.npl_round_points(v_round)
                                * coalesce((v_round.turn->>'factor')::numeric, 1))::int
     where id = v_round.current_attempt_id and status = 'open';
  end if;
  perform public.npl_touch(v_room.id, 'play', jsonb_build_object('seq', v_round.play_seq));
  return jsonb_build_object('ok', true, 'round', to_jsonb(v_round));
end $$;


revoke execute on function
  public.npl_clean_settings(jsonb),
  public.npl_round_mode(uuid, int, int, jsonb),
  public.npl_turn_applies(jsonb, public.npl_rounds),
  public.npl_part_counts(public.npl_rounds, text, text),
  public.npl_rescore_round(uuid),
  public.npl_turn_open(uuid, uuid, numeric, boolean)
  from public, anon, authenticated;

notify pgrst, 'reload schema';
