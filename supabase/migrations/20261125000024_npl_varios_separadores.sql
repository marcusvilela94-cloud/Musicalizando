-- =====================================================================
-- Musicalizando — 024: vários separadores (PC + Hugging Face) sem service_role.
-- Aplicar DEPOIS da 023. Pode rodar mais de uma vez.
--
-- Os separadores não falam mais com o Supabase: usam as rotas do jogo
-- /api/separador/* (protegidas por SEPARADOR_TOKEN); só essas rotas usam a
-- service_role. Cada separador tem um nome ("PC-Marcus", "HuggingFace"):
--   npl_stems_workers  sinal de vida de cada um (o jogo mostra quais estão ligados)
--   npl_stems_queue.worker  quem está separando a música
-- A fila se divide sozinha: npl_stems_claim(nome) pega o próximo pedido com
-- FOR UPDATE SKIP LOCKED (dois separadores nunca pegam o mesmo). Um pedido
-- "processando" só é retomado por outro se o dono parou de mandar sinal de
-- vida (3 min) ou travou (45 min); e se os dois terminarem, o segundo
-- npl_stems_done é recusado (duplicate) e os arquivos dele são apagados.
--
-- Acordar o Space: npl_stems_wake_mark marca o pedido (no máximo 1 a cada
-- 90 s, só com nenhum separador ligado); o servidor chama o Hugging Face.
-- =====================================================================

create table if not exists public.npl_stems_workers (
  name       text primary key check (name ~ '^[[:alnum:] ._-]{1,40}$'),
  last_seen  timestamptz not null default now(),
  started_at timestamptz not null default now(),
  info       jsonb not null default '{}'::jsonb
);
alter table public.npl_stems_workers enable row level security;
revoke all on public.npl_stems_workers from anon, authenticated;

alter table public.npl_stems_queue add column if not exists worker text;
alter table public.npl_stems_worker add column if not exists wake_requested_at timestamptz;

-- nome do separador (o antigo, sem nome, vira "PC")
create or replace function public.npl_worker_name(p text)
returns text
language sql immutable
set search_path = public
as $$
  select case when btrim(coalesce(p, '')) ~ '^[[:alnum:] ._-]{1,40}$' then btrim(p) else 'PC' end
$$;

-- algum separador mandou sinal de vida no último minuto?
create or replace function public.npl_stems_any_alive()
returns boolean
language sql stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.npl_stems_workers where last_seen > now() - interval '1 minute')
$$;

-- limite: o da biblioteca; senão o informado; senão o maior do .env dos separadores; senão 200 MB
create or replace function public.npl_stems_limit_bytes(p_fallback bigint default null)
returns bigint
language sql stable
security definer
set search_path = public
as $$
  select (coalesce(
            (select w.limit_mb::numeric from public.npl_stems_worker w where w.id = 1 and w.limit_mb > 0),
            p_fallback::numeric / 1048576,
            (select max(case when coalesce(k.info->>'limit_mb', '') ~ '^\d{1,6}(\.\d+)?$' then (k.info->>'limit_mb')::numeric end)
               from public.npl_stems_workers k where k.last_seen > now() - interval '1 day'),
            200) * 1048576)::bigint
$$;

-- Sinal de vida (a cada 30 s): devolve pausa/cheio para o separador saber por que não recebe pedidos
drop function if exists public.npl_stems_heartbeat(jsonb);
create or replace function public.npl_stems_heartbeat(p_info jsonb, p_worker text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := public.npl_worker_name(p_worker);
begin
  insert into public.npl_stems_workers as k (name, last_seen, started_at, info)
  values (v_name, now(), now(), case when jsonb_typeof(p_info) = 'object' then p_info else '{}'::jsonb end)
  on conflict (name) do update
     set started_at = case when k.last_seen < now() - interval '2 minutes' then now() else k.started_at end,
         last_seen = now(), info = excluded.info;
  insert into public.npl_stems_worker (id) values (1) on conflict do nothing;
  update public.npl_stems_worker set last_seen = now() where id = 1;
  -- separadores parados há mais de 7 dias saem da lista
  delete from public.npl_stems_workers where last_seen < now() - interval '7 days';
  return jsonb_build_object(
    'paused', coalesce((select paused from public.npl_stems_worker where id = 1), false),
    'full', public.npl_stems_full());
end $$;

-- Próximo pedido para este separador (atômico: SKIP LOCKED)
drop function if exists public.npl_stems_claim();
create or replace function public.npl_stems_claim(p_worker text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := public.npl_worker_name(p_worker);
  v public.npl_stems_queue;
begin
  if exists (select 1 from public.npl_stems_worker where id = 1 and paused) then
    return null;
  end if;
  delete from public.npl_stems_queue q where exists (select 1 from public.npl_stems_blocked b where b.deezer_id = q.deezer_id);
  if public.npl_stems_full() then
    return null;
  end if;
  select q.* into v from public.npl_stems_queue q
   where q.status = 'pending'
      or (q.status = 'processing' and (
            q.started_at < now() - interval '45 minutes'
         or (q.worker is null and q.started_at < now() - interval '10 minutes')
         or (q.worker is not null and q.started_at < now() - interval '3 minutes'
             and not exists (select 1 from public.npl_stems_workers k
                              where k.name = q.worker and k.last_seen > now() - interval '3 minutes'))))
   order by (q.status = 'processing'), q.requested_at
   limit 1
   for update of q skip locked;
  if not found then return null; end if;
  update public.npl_stems_queue
     set status = 'processing', started_at = now(), attempts = attempts + 1, error = null, worker = v_name
   where deezer_id = v.deezer_id
  returning * into v;
  return to_jsonb(v);
end $$;

-- Faixas prontas. ok=false: bloqueada (não entra) ou duplicate (outro separador já terminou) -> apagar os arquivos
drop function if exists public.npl_stems_done(bigint, text, jsonb, bigint, jsonb, jsonb);
create or replace function public.npl_stems_done(p_deezer_id bigint, p_key text, p_paths jsonb, p_bytes bigint,
                                                 p_audible jsonb, p_levels jsonb, p_worker text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from public.npl_stems_blocked where deezer_id = p_deezer_id) then
    delete from public.npl_stems_queue where deezer_id = p_deezer_id;
    return jsonb_build_object('ok', false, 'reason', 'blocked');
  end if;
  -- trava a música: dois "done" ao mesmo tempo esperam um pelo outro
  perform 1 from public.npl_stems_queue where deezer_id = p_deezer_id for update;
  if exists (select 1 from public.npl_stems_cache where deezer_id = p_deezer_id) then
    update public.npl_stems_queue set status = 'ready', finished_at = coalesce(finished_at, now())
     where deezer_id = p_deezer_id and status <> 'ready';
    return jsonb_build_object('ok', false, 'reason', 'duplicate');
  end if;
  insert into public.npl_stems_cache (deezer_id, key, paths, bytes, audible, levels, created_at, last_used_at, meta, source)
  values (p_deezer_id, p_key, p_paths, greatest(0, coalesce(p_bytes, 0)), p_audible, coalesce(p_levels, '{}'::jsonb), now(), now(),
          (select q.meta from public.npl_stems_queue q where q.deezer_id = p_deezer_id),
          (select q.source from public.npl_stems_queue q where q.deezer_id = p_deezer_id));
  update public.npl_stems_queue
     set status = 'ready', finished_at = now(), error = null, worker = coalesce(public.npl_worker_name(p_worker), worker)
   where deezer_id = p_deezer_id;
  return jsonb_build_object('ok', true);
end $$;

-- Erro: só conta se a música ainda é deste separador
drop function if exists public.npl_stems_fail(bigint, text);
create or replace function public.npl_stems_fail(p_deezer_id bigint, p_error text, p_worker text default null)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.npl_stems_queue set status = 'error', finished_at = now(), error = left(p_error, 500)
   where deezer_id = p_deezer_id and status = 'processing'
     and (p_worker is null or worker is null or worker = public.npl_worker_name(p_worker));
  return found;
end $$;

-- Acordar o separador da nuvem: true = o servidor deve chamar o Hugging Face agora
create or replace function public.npl_stems_wake_mark(p_code text, p_owner_token text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.npl_rooms := public.npl_lock_room(p_code);
  v_last timestamptz;
begin
  perform public.npl_require_host(v_room, p_owner_token);
  if public.npl_stems_any_alive() then return false; end if;
  insert into public.npl_stems_worker (id) values (1) on conflict do nothing;
  select wake_requested_at into v_last from public.npl_stems_worker where id = 1 for update;
  if v_last > now() - interval '90 seconds' then return false; end if;
  update public.npl_stems_worker set wake_requested_at = now() where id = 1;
  return true;
end $$;

-- Estado: + lista de separadores e "acordando"
create or replace function public.npl_stems_status(p_ids bigint[])
returns jsonb
language sql stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    -- resumo (compatível): algum ligado; info do que mandou sinal por último
    'worker', (select jsonb_build_object('last_seen', max(k.last_seen),
                        'alive', coalesce(bool_or(k.last_seen > now() - interval '1 minute'), false),
                        'info', coalesce((select k2.info from public.npl_stems_workers k2
                                           where k2.last_seen > now() - interval '1 minute'
                                           order by (k2.info->>'current' is null), k2.last_seen desc limit 1), '{}'::jsonb))
                 from public.npl_stems_workers k),
    'workers', coalesce((select jsonb_agg(jsonb_build_object('name', k.name, 'last_seen', k.last_seen,
                                   'alive', k.last_seen > now() - interval '1 minute', 'info', k.info) order by k.name)
                           from public.npl_stems_workers k where k.last_seen > now() - interval '1 day'), '[]'::jsonb),
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
      'waking', not public.npl_stems_any_alive()
                and coalesce((select w.wake_requested_at > now() - interval '5 minutes' from public.npl_stems_worker w where w.id = 1), false),
      'pending', (select count(*) from public.npl_stems_queue where status = 'pending'),
      'processing', (select count(*) from public.npl_stems_queue where status = 'processing'),
      'workers_alive', (select count(*) from public.npl_stems_workers where last_seen > now() - interval '1 minute'),
      'current_started_at', (select max(started_at) from public.npl_stems_queue where status = 'processing'),
      'avg_seconds', (select round(avg(s))::int from (
                        select extract(epoch from finished_at - started_at) as s from public.npl_stems_queue
                         where status = 'ready' and started_at is not null and finished_at > started_at
                           and finished_at - started_at < interval '30 minutes'
                         order by finished_at desc limit 20) t)))
$$;

revoke execute on function
  public.npl_worker_name(text),
  public.npl_stems_any_alive(),
  public.npl_stems_limit_bytes(bigint),
  public.npl_stems_heartbeat(jsonb, text),
  public.npl_stems_claim(text),
  public.npl_stems_done(bigint, text, jsonb, bigint, jsonb, jsonb, text),
  public.npl_stems_fail(bigint, text, text)
  from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function
      public.npl_stems_limit_bytes(bigint),
      public.npl_stems_heartbeat(jsonb, text),
      public.npl_stems_claim(text),
      public.npl_stems_done(bigint, text, jsonb, bigint, jsonb, jsonb, text),
      public.npl_stems_fail(bigint, text, text)
      to service_role;
  end if;
end $$;
