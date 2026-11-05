-- =====================================================================
-- Musicalizando — 025: segurança (repositório público).
-- Aplicar DEPOIS da 024. Pode rodar mais de uma vez.
--
--  1. Pausar / limpar a fila do separador vale para todas as salas: deixa de
--     ser liberado para qualquer dono de sala (qualquer um cria uma sala) e
--     passa a exigir a senha da biblioteca (rota /api/biblioteca, service_role):
--     npl_stems_set_paused / npl_stems_clear -> npl_lib_queue_pause / npl_lib_queue_clear.
--  2. Senha da biblioteca: no máximo 5 erros em 15 min por endereço (chave =
--     hash do IP, calculado no servidor); depois, bloqueado por 15 min.
--  3. npl_stems_fill_meta só pelo servidor do jogo (service_role).
-- =====================================================================

-- 1. fila: só pela biblioteca
drop function if exists public.npl_stems_set_paused(text, text, boolean);
drop function if exists public.npl_stems_clear(text, text);

create or replace function public.npl_lib_queue_pause(p_paused boolean)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.npl_stems_worker (id) values (1) on conflict do nothing;
  update public.npl_stems_worker
     set paused = coalesce(p_paused, false),
         paused_at = case when coalesce(p_paused, false) then now() end
   where id = 1;
  return coalesce(p_paused, false);
end $$;

-- só os pedidos que ainda não começaram (a atual e o cache ficam)
create or replace function public.npl_lib_queue_clear()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n int;
begin
  with gone as (delete from public.npl_stems_queue where status = 'pending' returning 1)
  select count(*) into v_n from gone;
  return v_n;
end $$;

-- 2. tentativas de senha
create table if not exists public.npl_lib_auth (
  key           text primary key check (key ~ '^[0-9a-f]{16,64}$'),
  failures      int not null default 0,
  first_at      timestamptz not null default now(),
  blocked_until timestamptz
);
alter table public.npl_lib_auth enable row level security;
revoke all on public.npl_lib_auth from anon, authenticated;

-- segundos que ainda faltam de bloqueio (0 = pode tentar)
create or replace function public.npl_lib_auth_blocked(p_key text)
returns int
language sql stable
security definer
set search_path = public
as $$
  select coalesce((select greatest(0, ceil(extract(epoch from blocked_until - now())))::int
                     from public.npl_lib_auth where key = p_key and blocked_until > now()), 0)
$$;

-- resultado de uma tentativa: acerto zera; erro conta (5 em 15 min = 15 min bloqueado)
create or replace function public.npl_lib_auth_result(p_key text, p_ok boolean)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.npl_lib_auth;
begin
  if p_key !~ '^[0-9a-f]{16,64}$' then return 0; end if;
  -- limpeza: registros velhos
  delete from public.npl_lib_auth where first_at < now() - interval '1 day' and (blocked_until is null or blocked_until < now());
  if coalesce(p_ok, false) then
    delete from public.npl_lib_auth where key = p_key;
    return 0;
  end if;
  insert into public.npl_lib_auth as a (key, failures, first_at)
  values (p_key, 1, now())
  on conflict (key) do update
     set failures = case when a.first_at < now() - interval '15 minutes' then 1 else a.failures + 1 end,
         first_at = case when a.first_at < now() - interval '15 minutes' then now() else a.first_at end
  returning * into r;
  if r.failures >= 5 then
    update public.npl_lib_auth set blocked_until = now() + interval '15 minutes', failures = 0, first_at = now()
     where key = p_key;
    return 900;
  end if;
  return 0;
end $$;

revoke execute on function
  public.npl_lib_queue_pause(boolean),
  public.npl_lib_queue_clear(),
  public.npl_lib_auth_blocked(text),
  public.npl_lib_auth_result(text, boolean),
  public.npl_stems_fill_meta(jsonb)
  from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function
      public.npl_lib_queue_pause(boolean),
      public.npl_lib_queue_clear(),
      public.npl_lib_auth_blocked(text),
      public.npl_lib_auth_result(text, boolean),
      public.npl_stems_fill_meta(jsonb)
      to service_role;
  end if;
end $$;
