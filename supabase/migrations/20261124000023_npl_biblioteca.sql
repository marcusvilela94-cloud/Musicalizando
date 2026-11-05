-- =====================================================================
-- Musicalizando — 023: biblioteca das músicas preparadas + partidas maiores.
-- Aplicar DEPOIS da 022. Pode rodar mais de uma vez.
--
-- Biblioteca (/biblioteca, protegida por senha; as rotas do servidor usam a
-- service_role, então as RPCs npl_lib_* NÃO são liberadas para anon):
--   npl_stems_cache.pinned      fixada: a limpeza automática nunca apaga
--   npl_stems_cache.source      de qual fonte veio ({type, id, label})
--   npl_stems_queue.source      idem, guardada quando entra na fila
--   npl_stems_worker.limit_mb   limite do cache (vale mais que o .env do separador)
--   npl_stems_blocked           nunca mais preparar nem tocar no Instrumentos
--   npl_stems_trash             arquivos para apagar do Storage (o servidor apaga)
--   npl_stems_collections(+_items) coleções ("Rock", "Churrasco"); viram fonte
--
-- Fixadas ocupando o limite inteiro: npl_stems_claim não entrega nada
-- (global.full = true) até liberar espaço.
--
-- Partidas: "Número de músicas" até 100 (antes 30); npl_start_match aceita
-- até 160 faixas (rodadas + reservas).
-- =====================================================================

alter table public.npl_stems_cache add column if not exists pinned boolean not null default false;
alter table public.npl_stems_cache add column if not exists source jsonb;
alter table public.npl_stems_queue add column if not exists source jsonb;
alter table public.npl_stems_worker add column if not exists limit_mb int;

create table if not exists public.npl_stems_blocked (
  deezer_id  bigint primary key,
  meta       jsonb,
  source     jsonb,
  blocked_at timestamptz not null default now()
);

create table if not exists public.npl_stems_trash (
  path       text primary key,
  created_at timestamptz not null default now()
);

create table if not exists public.npl_stems_collections (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(btrim(name)) between 1 and 60),
  created_at timestamptz not null default now()
);

create table if not exists public.npl_stems_collection_items (
  collection_id uuid not null references public.npl_stems_collections (id) on delete cascade,
  deezer_id     bigint not null references public.npl_stems_cache (deezer_id) on delete cascade,
  added_at      timestamptz not null default now(),
  primary key (collection_id, deezer_id)
);
create index if not exists npl_stems_collection_items_song on public.npl_stems_collection_items (deezer_id);

alter table public.npl_stems_blocked enable row level security;
alter table public.npl_stems_trash enable row level security;
alter table public.npl_stems_collections enable row level security;
alter table public.npl_stems_collection_items enable row level security;
revoke all on public.npl_stems_blocked, public.npl_stems_trash, public.npl_stems_collections,
              public.npl_stems_collection_items from anon, authenticated;


-- ---------------------------------------------------------------------
-- Fontes: "collection" (uma coleção da biblioteca)
-- ---------------------------------------------------------------------
create or replace function public.npl_clean_source(s jsonb)
returns jsonb
language sql immutable
set search_path = public
as $$
  select case
    when jsonb_typeof(s) <> 'object'
      or coalesce(s->>'type', '') not in ('preset', 'playlist', 'artist', 'cache', 'collection')
      or coalesce(s->>'id', '') !~ '^[\w-]{1,40}$' then null
    else jsonb_strip_nulls(jsonb_build_object(
      'type', s->>'type',
      'id', s->>'id',
      'label', left(coalesce(nullif(s->>'label', ''), '?'), 200),
      'picture', case when coalesce(s->>'picture', '') ~ '^https://' then left(s->>'picture', 500) end,
      'level', case when s->>'type' = 'artist' and s->>'level' in ('hits', 'known', 'fan') then s->>'level' end,
      'nbTracks', case when coalesce(s->>'nbTracks', '') ~ '^\d{1,6}$' then (s->>'nbTracks')::int end))
  end
$$;

-- só {type, id, label} (a origem guardada de cada música)
create or replace function public.npl_clean_origin(s jsonb)
returns jsonb
language sql immutable
set search_path = public
as $$
  select case when public.npl_clean_source(s) is null then null
              else jsonb_build_object('type', s->>'type', 'id', s->>'id',
                                      'label', left(coalesce(nullif(s->>'label', ''), '?'), 200)) end
$$;


-- ---------------------------------------------------------------------
-- Limite do cache
-- ---------------------------------------------------------------------
-- limite em bytes: o da biblioteca; senão o do separador (sinal de vida); senão 200 MB
create or replace function public.npl_stems_limit_bytes(p_fallback bigint default null)
returns bigint
language sql stable
security definer
set search_path = public
as $$
  select (coalesce(
            (select w.limit_mb::numeric from public.npl_stems_worker w where w.id = 1 and w.limit_mb > 0),
            p_fallback::numeric / 1048576,
            (select case when coalesce(w.info->>'limit_mb', '') ~ '^\d{1,6}(\.\d+)?$' then (w.info->>'limit_mb')::numeric end
               from public.npl_stems_worker w where w.id = 1),
            200) * 1048576)::bigint
$$;

-- fixadas já ocupam o limite (não cabe nem mais uma música do tamanho médio)?
create or replace function public.npl_stems_full()
returns boolean
language sql stable
security definer
set search_path = public
as $$
  select coalesce((select sum(bytes) from public.npl_stems_cache where pinned), 0)
         + coalesce((select avg(bytes)::bigint from public.npl_stems_cache where bytes > 0), 2097152)
         > public.npl_stems_limit_bytes()
$$;


-- ---------------------------------------------------------------------
-- Fila e cache (respeitando bloqueio, fixadas e a origem)
-- ---------------------------------------------------------------------
-- Completa os dados (e a origem) das músicas da fila/cache que ainda não têm (nunca sobrescreve)
create or replace function public.npl_stems_fill_meta(p_tracks jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n int := 0;
  v_m int;
begin
  if jsonb_typeof(p_tracks) <> 'array' then return 0; end if;
  with t as (
    select (x->>'deezer_id')::bigint as id, public.npl_clean_track_meta(x) as meta, public.npl_clean_origin(x->'source') as src
      from jsonb_array_elements(p_tracks) with ordinality as e(x, n)
     where e.n <= 300 and jsonb_typeof(x) = 'object' and coalesce(x->>'deezer_id', '') ~ '^\d{1,15}$'
  ), q as (
    update public.npl_stems_queue s
       set meta = coalesce(s.meta, t.meta), source = coalesce(s.source, t.src)
      from t
     where s.deezer_id = t.id
       and ((s.meta is null and t.meta is not null) or (s.source is null and t.src is not null))
    returning 1
  )
  select count(*) into v_n from q;
  with t as (
    select (x->>'deezer_id')::bigint as id, public.npl_clean_track_meta(x) as meta, public.npl_clean_origin(x->'source') as src
      from jsonb_array_elements(p_tracks) with ordinality as e(x, n)
     where e.n <= 300 and jsonb_typeof(x) = 'object' and coalesce(x->>'deezer_id', '') ~ '^\d{1,15}$'
  ), c as (
    update public.npl_stems_cache s
       set meta = coalesce(s.meta, t.meta), source = coalesce(s.source, t.src)
      from t
     where s.deezer_id = t.id
       and ((s.meta is null and t.meta is not null) or (s.source is null and t.src is not null))
    returning 1
  )
  select count(*) into v_m from c;
  return v_n + v_m;
end $$;

-- Coloca na fila as que ainda não estão prontas (nunca as bloqueadas)
create or replace function public.npl_stems_request(p_code text, p_owner_token text, p_ids bigint[], p_tracks jsonb default null)
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
     where i > 0
       and not exists (select 1 from public.npl_stems_cache c where c.deezer_id = i)
       and not exists (select 1 from public.npl_stems_blocked b where b.deezer_id = i)
  ), up as (
    insert into public.npl_stems_queue (deezer_id, status, requested_at)
    select i, 'pending', now() from ids
    on conflict (deezer_id) do update
       set status = 'pending', requested_at = now(), error = null
     where npl_stems_queue.status in ('error', 'ready')
    returning 1
  )
  select count(*) into v_n from up;
  perform public.npl_stems_fill_meta(p_tracks);
  return v_n;
end $$;

-- Próximo pedido: nada com a fila pausada, nem com o limite tomado pelas fixadas; bloqueadas saem
create or replace function public.npl_stems_claim()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v public.npl_stems_queue;
begin
  if exists (select 1 from public.npl_stems_worker where id = 1 and paused) then
    return null;
  end if;
  delete from public.npl_stems_queue q where exists (select 1 from public.npl_stems_blocked b where b.deezer_id = q.deezer_id);
  if public.npl_stems_full() then
    return null;
  end if;
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

-- O separador grava o cache (dados e origem vêm do pedido). Bloqueada no meio do caminho: arquivos vão para o lixo
create or replace function public.npl_stems_done(p_deezer_id bigint, p_key text, p_paths jsonb, p_bytes bigint,
                                                 p_audible jsonb, p_levels jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from public.npl_stems_blocked where deezer_id = p_deezer_id) then
    insert into public.npl_stems_trash (path)
    select value from jsonb_each_text(case when jsonb_typeof(p_paths) = 'object' then p_paths else '{}'::jsonb end)
    on conflict do nothing;
    delete from public.npl_stems_queue where deezer_id = p_deezer_id;
    return;
  end if;
  insert into public.npl_stems_cache (deezer_id, key, paths, bytes, audible, levels, created_at, last_used_at, meta, source)
  values (p_deezer_id, p_key, p_paths, greatest(0, coalesce(p_bytes, 0)), p_audible, coalesce(p_levels, '{}'::jsonb), now(), now(),
          (select q.meta from public.npl_stems_queue q where q.deezer_id = p_deezer_id),
          (select q.source from public.npl_stems_queue q where q.deezer_id = p_deezer_id))
  on conflict (deezer_id) do update
     set key = excluded.key, paths = excluded.paths, bytes = excluded.bytes, audible = excluded.audible,
         levels = excluded.levels, created_at = now(), last_used_at = now(),
         meta = coalesce(excluded.meta, npl_stems_cache.meta),
         source = coalesce(excluded.source, npl_stems_cache.source);
  update public.npl_stems_queue set status = 'ready', finished_at = now(), error = null where deezer_id = p_deezer_id;
end $$;

-- Cache acima do limite: tira as não fixadas usadas há mais tempo e devolve as chaves para apagar os arquivos
create or replace function public.npl_stems_evict(p_limit_bytes bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limit bigint := public.npl_stems_limit_bytes(p_limit_bytes);
  v_total bigint;
  v_out jsonb := '[]'::jsonb;
  r public.npl_stems_cache;
begin
  select coalesce(sum(bytes), 0) into v_total from public.npl_stems_cache;
  for r in select * from public.npl_stems_cache where not pinned order by last_used_at, created_at loop
    exit when v_total <= v_limit;
    delete from public.npl_stems_cache where deezer_id = r.deezer_id;
    delete from public.npl_stems_queue where deezer_id = r.deezer_id;
    v_total := v_total - r.bytes;
    v_out := v_out || jsonb_build_object('deezer_id', r.deezer_id, 'key', r.key, 'paths', r.paths);
  end loop;
  return v_out;
end $$;

-- A partida vai usar estas: atualiza o "último uso" (até 160)
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
  update public.npl_stems_cache set last_used_at = now() where deezer_id = any (coalesce(p_ids[1:160], '{}'));
end $$;

-- Estado: + bloqueadas entre as pedidas, limite, espaço das fixadas e "cheio"
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
    'blocked', coalesce((select jsonb_agg(b.deezer_id) from public.npl_stems_blocked b
                          where b.deezer_id = any (coalesce(p_ids[1:300], '{}'))), '[]'::jsonb),
    'queue', coalesce((select jsonb_object_agg(q.status, q.n) from (
                         select status, count(*) as n from public.npl_stems_queue
                          where deezer_id = any (coalesce(p_ids[1:300], '{}')) and status <> 'ready'
                          group by status) q), '{}'::jsonb),
    'errors', coalesce((select jsonb_agg(jsonb_build_object('deezer_id', q.deezer_id, 'error', q.error))
                          from public.npl_stems_queue q
                         where q.deezer_id = any (coalesce(p_ids[1:300], '{}')) and q.status = 'error'), '[]'::jsonb),
    'cache', (select jsonb_build_object('songs', count(*), 'bytes', coalesce(sum(bytes), 0),
                                        'pinned_bytes', coalesce(sum(bytes) filter (where pinned), 0),
                                        'limit_bytes', public.npl_stems_limit_bytes())
                from public.npl_stems_cache),
    'global', jsonb_build_object(
      'paused', coalesce((select w.paused from public.npl_stems_worker w where w.id = 1), false),
      'full', public.npl_stems_full(),
      'pending', (select count(*) from public.npl_stems_queue where status = 'pending'),
      'processing', (select count(*) from public.npl_stems_queue where status = 'processing'),
      'current_started_at', (select max(started_at) from public.npl_stems_queue where status = 'processing'),
      'avg_seconds', (select round(avg(s))::int from (
                        select extract(epoch from finished_at - started_at) as s from public.npl_stems_queue
                         where status = 'ready' and started_at is not null and finished_at > started_at
                           and finished_at - started_at < interval '30 minutes'
                         order by finished_at desc limit 20) t)))
$$;

-- Fonte "Músicas já preparadas" (p_collection null) ou uma coleção
drop function if exists public.npl_stems_cached();
create or replace function public.npl_stems_cached(p_collection uuid default null)
returns jsonb
language sql stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object('deezer_id', c.deezer_id, 'meta', c.meta) order by c.last_used_at desc), '[]'::jsonb)
    from (select * from public.npl_stems_cache s
           where p_collection is null
              or exists (select 1 from public.npl_stems_collection_items i
                          where i.collection_id = p_collection and i.deezer_id = s.deezer_id)
           order by last_used_at desc limit 1000) c
$$;

-- Coleções para escolher como fonte (nome e quantas músicas)
create or replace function public.npl_stems_collections_list()
returns jsonb
language sql stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name,
                    'songs', (select count(*) from public.npl_stems_collection_items i where i.collection_id = c.id))
                  order by lower(c.name)), '[]'::jsonb)
    from public.npl_stems_collections c
$$;


-- ---------------------------------------------------------------------
-- Biblioteca (só service_role: as rotas /api/biblioteca conferem a senha)
-- ---------------------------------------------------------------------
create or replace function public.npl_lib_list()
returns jsonb
language sql stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'songs', coalesce((select jsonb_agg(jsonb_build_object(
                 'deezer_id', c.deezer_id, 'key', c.key, 'paths', c.paths, 'bytes', c.bytes,
                 'audible', c.audible, 'meta', c.meta, 'source', c.source, 'pinned', c.pinned,
                 'created_at', c.created_at, 'last_used_at', c.last_used_at,
                 'collections', coalesce((select jsonb_agg(i.collection_id) from public.npl_stems_collection_items i
                                           where i.deezer_id = c.deezer_id), '[]'::jsonb))
               order by c.created_at desc)
               from (select * from public.npl_stems_cache order by created_at desc limit 3000) c), '[]'::jsonb),
    'collections', public.npl_stems_collections_list(),
    'blocked', coalesce((select jsonb_agg(jsonb_build_object('deezer_id', b.deezer_id, 'meta', b.meta,
                                                              'source', b.source, 'blocked_at', b.blocked_at)
                                          order by b.blocked_at desc)
                           from public.npl_stems_blocked b), '[]'::jsonb),
    'usage', (select jsonb_build_object(
                'songs', count(*), 'bytes', coalesce(sum(bytes), 0),
                'pinned', count(*) filter (where pinned),
                'pinned_bytes', coalesce(sum(bytes) filter (where pinned), 0),
                'limit_bytes', public.npl_stems_limit_bytes(),
                'limit_mb', (select w.limit_mb from public.npl_stems_worker w where w.id = 1),
                'full', public.npl_stems_full())
                from public.npl_stems_cache),
    'trash', (select count(*) from public.npl_stems_trash))
$$;

-- Remover (e bloquear): apaga o registro e devolve os arquivos para o servidor apagar do Storage
create or replace function public.npl_lib_remove(p_ids bigint[], p_block boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids bigint[] := coalesce(p_ids[1:500], '{}');
  v_paths jsonb;
  v_n int;
begin
  if coalesce(p_block, false) then
    insert into public.npl_stems_blocked (deezer_id, meta, source, blocked_at)
    select i, coalesce(c.meta, q.meta), coalesce(c.source, q.source), now()
      from unnest(v_ids) as i
      left join public.npl_stems_cache c on c.deezer_id = i
      left join public.npl_stems_queue q on q.deezer_id = i
     where i > 0
    on conflict (deezer_id) do update
       set meta = coalesce(excluded.meta, npl_stems_blocked.meta),
           source = coalesce(excluded.source, npl_stems_blocked.source);
  end if;
  select coalesce(jsonb_agg(p.value), '[]'::jsonb) into v_paths
    from public.npl_stems_cache c, jsonb_each_text(c.paths) p
   where c.deezer_id = any (v_ids);
  with gone as (delete from public.npl_stems_cache where deezer_id = any (v_ids) returning 1)
  select count(*) into v_n from gone;
  delete from public.npl_stems_queue
   where deezer_id = any (v_ids) and (coalesce(p_block, false) or status <> 'processing');
  return jsonb_build_object('removed', v_n, 'paths', v_paths);
end $$;

create or replace function public.npl_lib_unblock(p_ids bigint[])
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n int;
begin
  with gone as (delete from public.npl_stems_blocked where deezer_id = any (coalesce(p_ids[1:500], '{}')) returning 1)
  select count(*) into v_n from gone;
  return v_n;
end $$;

create or replace function public.npl_lib_pin(p_ids bigint[], p_pinned boolean)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n int;
begin
  update public.npl_stems_cache set pinned = coalesce(p_pinned, false)
   where deezer_id = any (coalesce(p_ids[1:500], '{}'));
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- Criar (p_id null) ou renomear
create or replace function public.npl_lib_collection_save(p_id uuid, p_name text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := left(regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'), 60);
  v public.npl_stems_collections;
begin
  if v_name = '' then raise exception 'npl:collection_name'; end if;
  if exists (select 1 from public.npl_stems_collections
              where lower(name) = lower(v_name) and id is distinct from p_id) then
    raise exception 'npl:collection_exists';
  end if;
  if p_id is null then
    insert into public.npl_stems_collections (name) values (v_name) returning * into v;
  else
    update public.npl_stems_collections set name = v_name where id = p_id returning * into v;
    if not found then raise exception 'npl:collection_not_found'; end if;
  end if;
  return jsonb_build_object('id', v.id, 'name', v.name);
end $$;

create or replace function public.npl_lib_collection_delete(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.npl_stems_collections where id = p_id;
  return found;
end $$;

-- Pôr (p_add) ou tirar músicas de uma coleção
create or replace function public.npl_lib_collection_set(p_collection uuid, p_ids bigint[], p_add boolean)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n int;
begin
  if not exists (select 1 from public.npl_stems_collections where id = p_collection) then
    raise exception 'npl:collection_not_found';
  end if;
  if coalesce(p_add, true) then
    insert into public.npl_stems_collection_items (collection_id, deezer_id)
    select p_collection, c.deezer_id from public.npl_stems_cache c where c.deezer_id = any (coalesce(p_ids[1:500], '{}'))
    on conflict do nothing;
  else
    delete from public.npl_stems_collection_items
     where collection_id = p_collection and deezer_id = any (coalesce(p_ids[1:500], '{}'));
  end if;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- Novo limite (20 a 500 MB): já tira as não fixadas que passarem (o servidor apaga os arquivos)
create or replace function public.npl_lib_set_limit(p_mb int)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mb int := least(500, greatest(20, coalesce(p_mb, 200)));
begin
  insert into public.npl_stems_worker (id) values (1) on conflict do nothing;
  update public.npl_stems_worker set limit_mb = v_mb where id = 1;
  return jsonb_build_object('limit_mb', v_mb, 'evicted', public.npl_stems_evict(null));
end $$;

-- Arquivos para apagar (músicas bloqueadas que terminaram de separar depois)
create or replace function public.npl_lib_trash_take()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v jsonb;
begin
  with gone as (delete from public.npl_stems_trash returning path)
  select coalesce(jsonb_agg(path), '[]'::jsonb) into v from gone;
  return v;
end $$;


-- ---------------------------------------------------------------------
-- Partidas de até 100 músicas
-- ---------------------------------------------------------------------
do $$
declare
  v_def text;
  v_new text;
begin
  v_def := replace(pg_get_functiondef('public.npl_clean_settings(jsonb)'::regprocedure), E'\r\n', E'\n');
  v_new := replace(v_def, 'to_jsonb(least(30, greatest(5, coalesce(v_int, 10))))', 'to_jsonb(least(100, greatest(5, coalesce(v_int, 10))))');
  if v_new <> v_def then
    execute v_new;
  elsif position('least(100, greatest(5, coalesce(v_int, 10)))' in v_def) = 0 then
    raise exception 'npl 023: limite de rodadas não encontrado em npl_clean_settings';
  end if;

  v_def := replace(pg_get_functiondef('public.npl_start_match(text, text, jsonb, int)'::regprocedure), E'\r\n', E'\n');
  v_new := replace(v_def, 'with ordinality as x(e, n)
   where n <= 40;', 'with ordinality as x(e, n)
   where n <= 160;');
  if v_new <> v_def then
    execute v_new;
  elsif position('where n <= 160;' in v_def) = 0 then
    raise exception 'npl 023: limite de faixas não encontrado em npl_start_match';
  end if;
end $$;


revoke execute on function
  public.npl_clean_origin(jsonb),
  public.npl_stems_limit_bytes(bigint),
  public.npl_stems_full(),
  public.npl_stems_claim(),
  public.npl_stems_done(bigint, text, jsonb, bigint, jsonb, jsonb),
  public.npl_stems_evict(bigint),
  public.npl_lib_list(),
  public.npl_lib_remove(bigint[], boolean),
  public.npl_lib_unblock(bigint[]),
  public.npl_lib_pin(bigint[], boolean),
  public.npl_lib_collection_save(uuid, text),
  public.npl_lib_collection_delete(uuid),
  public.npl_lib_collection_set(uuid, bigint[], boolean),
  public.npl_lib_set_limit(int),
  public.npl_lib_trash_take()
  from public, anon, authenticated;

-- no Supabase a service_role (rotas do servidor e o separador) continua chamando
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function
      public.npl_stems_limit_bytes(bigint),
      public.npl_stems_full(),
      public.npl_stems_claim(),
      public.npl_stems_done(bigint, text, jsonb, bigint, jsonb, jsonb),
      public.npl_stems_evict(bigint),
      public.npl_lib_list(),
      public.npl_lib_remove(bigint[], boolean),
      public.npl_lib_unblock(bigint[]),
      public.npl_lib_pin(bigint[], boolean),
      public.npl_lib_collection_save(uuid, text),
      public.npl_lib_collection_delete(uuid),
      public.npl_lib_collection_set(uuid, bigint[], boolean),
      public.npl_lib_set_limit(int),
      public.npl_lib_trash_take()
      to service_role;
  end if;
end $$;
