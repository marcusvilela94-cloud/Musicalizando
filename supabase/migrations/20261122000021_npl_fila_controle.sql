-- =====================================================================
-- Musicalizando — 021: controle da fila do separador (Instrumentos).
-- Aplicar DEPOIS da 020. Pode rodar mais de uma vez.
--
--  - Pausar/continuar: npl_stems_worker.paused. Com a fila pausada,
--    npl_stems_claim não entrega nada; o separador termina a música atual
--    (ele só pede a próxima depois de terminar) e fica esperando. Vale também
--    para um separador antigo, sem precisar reiniciar.
--  - Limpar: apaga só os pedidos "pending" (não mexe na que está sendo
--    separada nem no cache).
--  - npl_stems_status ganha "global": fila inteira, pausa e tempo médio
--    por música (para a estimativa de tempo restante).
-- =====================================================================

alter table public.npl_stems_worker add column if not exists paused boolean not null default false;
alter table public.npl_stems_worker add column if not exists paused_at timestamptz;

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
    'cache', (select jsonb_build_object('songs', count(*), 'bytes', coalesce(sum(bytes), 0)) from public.npl_stems_cache),
    -- a fila inteira (de todas as salas): pausa, pendentes e tempo médio das últimas 20 prontas
    'global', jsonb_build_object(
      'paused', coalesce((select w.paused from public.npl_stems_worker w where w.id = 1), false),
      'pending', (select count(*) from public.npl_stems_queue where status = 'pending'),
      'processing', (select count(*) from public.npl_stems_queue where status = 'processing'),
      'current_started_at', (select max(started_at) from public.npl_stems_queue where status = 'processing'),
      'avg_seconds', (select round(avg(s))::int from (
                        select extract(epoch from finished_at - started_at) as s from public.npl_stems_queue
                         where status = 'ready' and started_at is not null and finished_at > started_at
                           and finished_at - started_at < interval '30 minutes'
                         order by finished_at desc limit 20) t)))
$$;

-- Pausar / continuar a fila (quem é dono da sala)
create or replace function public.npl_stems_set_paused(p_code text, p_owner_token text, p_paused boolean)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.npl_rooms := public.npl_lock_room(p_code);
begin
  perform public.npl_require_host(v_room, p_owner_token);
  insert into public.npl_stems_worker (id) values (1) on conflict do nothing;
  update public.npl_stems_worker
     set paused = coalesce(p_paused, false),
         paused_at = case when coalesce(p_paused, false) then now() end
   where id = 1;
  return coalesce(p_paused, false);
end $$;

-- Limpar a fila: só os pedidos que ainda não começaram (a atual e o cache ficam)
create or replace function public.npl_stems_clear(p_code text, p_owner_token text)
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
  with gone as (delete from public.npl_stems_queue where status = 'pending' returning 1)
  select count(*) into v_n from gone;
  return v_n;
end $$;

-- Pega o próximo pedido (e retoma os que ficaram "processando" por mais de 10 min); nada com a fila pausada
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

revoke execute on function public.npl_stems_claim() from public, anon, authenticated;
