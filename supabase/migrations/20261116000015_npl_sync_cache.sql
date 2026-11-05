-- =====================================================================
-- Musicalizando — 015: cache da análise de sincronização ("Continuar a
-- letra") e preparação em segundo plano.
-- Aplicar DEPOIS das migrações 001–014. Pode rodar mais de uma vez.
--
-- npl_sync_cache: por faixa do Deezer, o resultado da análise (Groq + LRC).
--   NÃO guarda letra nem áudio: só tempos e índices das linhas.
--   algo        versão do algoritmo (mudou -> analisa de novo)
--   ok/reason   serve para o modo? (descartada também fica, com o motivo)
--   line_count  nº de linhas da letra sincronizada usada (se a letra do LRCLIB
--               mudar de tamanho, a análise é refeita)
--   lines       [{i, s, e, u}] linhas na prévia: índice na letra, início e fim
--               pelo LRC (s da prévia) e fim do canto ouvido (u)
--   eligible    índices das linhas que podem ser escondidas (ordem de preferência)
-- npl_rooms.prep: progresso da preparação em segundo plano {active, done, total}.
-- =====================================================================

create table if not exists public.npl_sync_cache (
  deezer_id      bigint primary key,
  algo           int not null,
  ok             boolean not null,
  reason         text,
  preview_offset numeric,
  line_count     int not null default 0,
  lines          jsonb not null default '[]'::jsonb,
  eligible       jsonb not null default '[]'::jsonb,
  confidence     numeric,
  analyzed_at    timestamptz not null default now()
);
alter table public.npl_sync_cache enable row level security;
revoke all on public.npl_sync_cache from anon, authenticated;

alter table public.npl_rooms add column if not exists prep jsonb not null default '{}'::jsonb;

-- Leitura do cache (só tempos e índices; qualquer cliente pode ler)
create or replace function public.npl_sync_get(p_ids bigint[])
returns jsonb
language sql stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(to_jsonb(c)), '[]'::jsonb)
    from public.npl_sync_cache c
   where c.deezer_id = any(coalesce(p_ids, '{}'::bigint[]))
$$;

-- Gravação do cache: só quem comanda uma sala (a rota do Next manda o token)
create or replace function public.npl_sync_put(p_code text, p_owner_token text, p_entry jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.npl_rooms;
  v_id bigint;
begin
  select * into v_room from public.npl_rooms where code = btrim(p_code);
  if not found then raise exception 'npl:room_not_found'; end if;
  perform public.npl_require_owner(v_room, p_owner_token);
  begin v_id := (p_entry->>'deezer_id')::bigint; exception when others then v_id := null; end;
  if v_id is null or jsonb_typeof(p_entry->'ok') <> 'boolean' or jsonb_typeof(p_entry->'algo') <> 'number' then
    raise exception 'npl:bad_entry';
  end if;
  insert into public.npl_sync_cache as c (deezer_id, algo, ok, reason, preview_offset, line_count, lines, eligible, confidence, analyzed_at)
  values (
    v_id,
    (p_entry->>'algo')::int,
    (p_entry->>'ok')::boolean,
    left(p_entry->>'reason', 200),
    case when jsonb_typeof(p_entry->'offset') = 'number' then (p_entry->>'offset')::numeric end,
    greatest(0, coalesce((p_entry->>'line_count')::int, 0)),
    coalesce((select jsonb_agg(jsonb_build_object('i', (e->>'i')::int, 's', (e->>'s')::numeric,
                                                  'e', (e->>'e')::numeric, 'u', (e->>'u')::numeric) order by n)
                from jsonb_array_elements(case when jsonb_typeof(p_entry->'lines') = 'array' then p_entry->'lines' else '[]'::jsonb end)
                     with ordinality as x(e, n)
               where n <= 40 and jsonb_typeof(e->'i') = 'number' and jsonb_typeof(e->'s') = 'number'
                 and jsonb_typeof(e->'e') = 'number' and jsonb_typeof(e->'u') = 'number'), '[]'::jsonb),
    coalesce((select jsonb_agg(to_jsonb((e #>> '{}')::int) order by n)
                from jsonb_array_elements(case when jsonb_typeof(p_entry->'eligible') = 'array' then p_entry->'eligible' else '[]'::jsonb end)
                     with ordinality as x(e, n)
               where n <= 20 and jsonb_typeof(e) = 'number'), '[]'::jsonb),
    case when jsonb_typeof(p_entry->'confidence') = 'number' then (p_entry->>'confidence')::numeric end,
    now())
  on conflict (deezer_id) do update
     set algo = excluded.algo, ok = excluded.ok, reason = excluded.reason, preview_offset = excluded.preview_offset,
         line_count = excluded.line_count, lines = excluded.lines, eligible = excluded.eligible,
         confidence = excluded.confidence, analyzed_at = excluded.analyzed_at;
end $$;

-- Preparação em segundo plano: troca a música de uma rodada futura de
-- "Continuar a letra" pela que ficou pronta (só se a rodada ainda não começou)
-- e atualiza o progresso (rooms.prep). p_track null = só o progresso.
create or replace function public.npl_fill_cont(p_code text, p_owner_token text, p_match int, p_position int,
                                                p_track jsonb, p_prep jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.npl_rooms := public.npl_lock_room(p_code);
  v_cont jsonb;
  v_ok boolean := false;
begin
  perform public.npl_require_owner(v_room, p_owner_token);
  if v_room.match_no is distinct from p_match or v_room.phase <> 'playing' then
    return jsonb_build_object('ok', false, 'reason', 'match');
  end if;
  if jsonb_typeof(p_track) = 'object' then
    v_cont := public.npl_clean_cont(p_track->'cont');
    if v_cont is not null and p_position > v_room.round_no and p_position <= v_room.total_rounds
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
             lyrics = null,
             mode = 'continue',
             cont = v_cont
       where room_id = v_room.id and match_no = v_room.match_no and position = p_position;
      v_ok := found;
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
