-- =====================================================================
-- Musicalizando — 022: fonte "Músicas já preparadas" e "Fontes recentes".
-- Aplicar DEPOIS da 021. Pode rodar mais de uma vez.
--
--  - npl_stems_queue.meta / npl_stems_cache.meta: título, artista, capa… da
--    música (para usar o cache como fonte sem consultar o Deezer faixa a
--    faixa). Vem no pedido (npl_stems_request p_tracks); o separador não
--    muda: npl_stems_done copia da fila. As antigas são completadas pelo
--    servidor do jogo (npl_stems_fill_meta, só onde está vazio).
--  - npl_stems_cached(): as músicas do cache com os dados.
--  - npl_recent_sources: as últimas 10 fontes usadas (ao começar a partida).
-- =====================================================================

alter table public.npl_stems_queue add column if not exists meta jsonb;
alter table public.npl_stems_cache add column if not exists meta jsonb;

-- só os campos que o jogo usa, com tamanho limitado
create or replace function public.npl_clean_track_meta(t jsonb)
returns jsonb
language sql immutable
set search_path = public
as $$
  select case
    when jsonb_typeof(t) <> 'object' or coalesce(t->>'title', '') = '' or coalesce(t->>'artist', '') = '' then null
    else jsonb_strip_nulls(jsonb_build_object(
      'title', left(t->>'title', 300),
      'title_short', left(coalesce(t->>'title_short', t->>'title'), 300),
      'artist', left(t->>'artist', 300),
      'artist_id', case when coalesce(t->>'artist_id', '') ~ '^\d{1,15}$' then (t->>'artist_id')::bigint end,
      'album', left(t->>'album', 300),
      'album_id', case when coalesce(t->>'album_id', '') ~ '^\d{1,15}$' then (t->>'album_id')::bigint end,
      'cover', case when coalesce(t->>'cover', '') ~ '^https://' then left(t->>'cover', 500) end,
      'duration', case when coalesce(t->>'duration', '') ~ '^\d{1,5}$' then (t->>'duration')::int end))
  end
$$;

-- Coloca na fila as que ainda não estão prontas (as que deram erro voltam para a fila).
-- p_tracks (opcional): [{deezer_id, title, artist, …}] — guardados para a fonte "Músicas já preparadas"
drop function if exists public.npl_stems_request(text, text, bigint[]);
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
  perform public.npl_stems_fill_meta(p_tracks);
  return v_n;
end $$;

-- Completa os dados das músicas da fila/cache que ainda não têm (nunca sobrescreve)
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
    select (x->>'deezer_id')::bigint as id, public.npl_clean_track_meta(x) as meta
      from jsonb_array_elements(p_tracks) with ordinality as e(x, n)
     where e.n <= 300 and jsonb_typeof(x) = 'object' and coalesce(x->>'deezer_id', '') ~ '^\d{1,15}$'
  ), q as (
    update public.npl_stems_queue s set meta = t.meta from t
     where s.deezer_id = t.id and s.meta is null and t.meta is not null
    returning 1
  )
  select count(*) into v_n from q;
  with t as (
    select (x->>'deezer_id')::bigint as id, public.npl_clean_track_meta(x) as meta
      from jsonb_array_elements(p_tracks) with ordinality as e(x, n)
     where e.n <= 300 and jsonb_typeof(x) = 'object' and coalesce(x->>'deezer_id', '') ~ '^\d{1,15}$'
  ), c as (
    update public.npl_stems_cache s set meta = t.meta from t
     where s.deezer_id = t.id and s.meta is null and t.meta is not null
    returning 1
  )
  select count(*) into v_m from c;
  return v_n + v_m;
end $$;

-- O separador grava o cache; os dados da música vêm do pedido
create or replace function public.npl_stems_done(p_deezer_id bigint, p_key text, p_paths jsonb, p_bytes bigint,
                                                 p_audible jsonb, p_levels jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.npl_stems_cache (deezer_id, key, paths, bytes, audible, levels, created_at, last_used_at, meta)
  values (p_deezer_id, p_key, p_paths, greatest(0, coalesce(p_bytes, 0)), p_audible, coalesce(p_levels, '{}'::jsonb), now(), now(),
          (select q.meta from public.npl_stems_queue q where q.deezer_id = p_deezer_id))
  on conflict (deezer_id) do update
     set key = excluded.key, paths = excluded.paths, bytes = excluded.bytes, audible = excluded.audible,
         levels = excluded.levels, created_at = now(), last_used_at = now(),
         meta = coalesce(excluded.meta, npl_stems_cache.meta);
  update public.npl_stems_queue set status = 'ready', finished_at = now(), error = null where deezer_id = p_deezer_id;
end $$;

-- Fonte "Músicas já preparadas": todas as do cache (meta null = o servidor completa no Deezer)
create or replace function public.npl_stems_cached()
returns jsonb
language sql stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object('deezer_id', c.deezer_id, 'meta', c.meta) order by c.last_used_at desc), '[]'::jsonb)
    from (select * from public.npl_stems_cache order by last_used_at desc limit 1000) c
$$;

revoke execute on function public.npl_stems_done(bigint, text, jsonb, bigint, jsonb, jsonb) from public, anon, authenticated;
revoke execute on function public.npl_clean_track_meta(jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Fontes recentes (as últimas 10 usadas para começar uma partida)
-- ---------------------------------------------------------------------
create table if not exists public.npl_recent_sources (
  key     text primary key,           -- "<tipo>:<id>"
  source  jsonb not null,             -- {type, id, label, picture?, level?, nbTracks?}
  used_at timestamptz not null default now()
);
create index if not exists npl_recent_sources_used on public.npl_recent_sources (used_at desc);
alter table public.npl_recent_sources enable row level security;
revoke all on public.npl_recent_sources from anon, authenticated;

create or replace function public.npl_clean_source(s jsonb)
returns jsonb
language sql immutable
set search_path = public
as $$
  select case
    when jsonb_typeof(s) <> 'object'
      or coalesce(s->>'type', '') not in ('preset', 'playlist', 'artist', 'cache')
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

-- Ao começar a partida: as fontes da sala viram as mais recentes (fica só com 10)
create or replace function public.npl_sources_used(p_code text, p_owner_token text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.npl_rooms := public.npl_lock_room(p_code);
begin
  perform public.npl_require_host(v_room, p_owner_token);
  insert into public.npl_recent_sources as r (key, source, used_at)
  select (c->>'type') || ':' || (c->>'id'), c, now() - (n * interval '1 microsecond') -- a 1ª da sala fica na frente
    from (select public.npl_clean_source(x) as c, n
            from jsonb_array_elements(case when jsonb_typeof(v_room.settings->'sources') = 'array'
                                           then v_room.settings->'sources' else '[]'::jsonb end)
                 with ordinality as e(x, n)
           where n <= 12) s
   where c is not null
  on conflict (key) do update set source = excluded.source, used_at = excluded.used_at;
  delete from public.npl_recent_sources
   where key not in (select key from public.npl_recent_sources order by used_at desc limit 10);
end $$;

create or replace function public.npl_recent_sources()
returns jsonb
language sql stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(r.source order by r.used_at desc), '[]'::jsonb)
    from (select * from public.npl_recent_sources order by used_at desc limit 10) r
$$;

revoke execute on function public.npl_clean_source(jsonb) from public, anon, authenticated;
