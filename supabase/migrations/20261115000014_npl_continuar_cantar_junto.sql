-- =====================================================================
-- Musicalizando — 014: "Continuar a letra" com trecho único e "cantar junto".
-- Aplicar DEPOIS das migrações 001–013. Pode rodar mais de uma vez.
--
-- - Sem "Mais contexto": o trecho vai da 1ª linha completa da prévia até
--   0,3 s antes da linha escondida; acerto vale 100 fixos.
-- - npl_tracks.cont ganha "after": as linhas depois da escondida até o fim
--   da prévia (para o karaokê de "cantar junto" na revelação).
-- - Revelação: npl_rounds.cont recebe reveal (a linha) + after (as seguintes).
-- - npl_cont_skip: "Próxima música" durante o cantar junto pula para a tela
--   de revelação normal (cont.sung = true), na TV e no apresentador.
-- =====================================================================

create or replace function public.npl_stage_count(p_mode text)
returns int
language sql immutable
set search_path = public
as $$ select case p_mode when 'lyrics' then 5 when 'continue' then 1 else 6 end $$;

create or replace function public.npl_stage_points(p_mode text, p_stage int)
returns int
language sql immutable
set search_path = public
as $$
  select case p_mode
    when 'lyrics' then (array[100, 75, 50, 30, 15])[greatest(1, least(5, p_stage))]
    when 'continue' then 100
    else (array[100, 80, 60, 40, 25, 10])[greatest(1, least(6, p_stage))]
  end
$$;

-- Linhas {text, start, end} vindas do cliente (até p_max)
create or replace function public.npl_clean_cont_lines(p jsonb, p_max int)
returns jsonb
language sql immutable
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object('text', left(e->>'text', 200),
                                               'start', (e->>'start')::numeric,
                                               'end', (e->>'end')::numeric) order by n), '[]'::jsonb)
    from jsonb_array_elements(case when jsonb_typeof(p) = 'array' then p else '[]'::jsonb end) with ordinality as x(e, n)
   where n <= p_max and jsonb_typeof(e->'start') = 'number' and jsonb_typeof(e->'end') = 'number'
     and coalesce(btrim(e->>'text'), '') <> ''
$$;

create or replace function public.npl_clean_cont(p jsonb)
returns jsonb
language plpgsql immutable
set search_path = public
as $$
declare
  v_lines jsonb;
  v_h jsonb := p->'hidden';
begin
  if jsonb_typeof(p) <> 'object' or jsonb_typeof(p->'lines') <> 'array' or jsonb_typeof(v_h) <> 'object'
     or jsonb_typeof(v_h->'start') <> 'number' or jsonb_typeof(v_h->'end') <> 'number'
     or coalesce(btrim(v_h->>'text'), '') = '' then
    return null;
  end if;
  v_lines := public.npl_clean_cont_lines(p->'lines', 12);
  if jsonb_array_length(v_lines) < 1 then return null; end if;
  return jsonb_build_object('lines', v_lines,
    'hidden', jsonb_build_object('text', left(v_h->>'text', 200),
                                 'start', (v_h->>'start')::numeric, 'end', (v_h->>'end')::numeric),
    'after', public.npl_clean_cont_lines(p->'after', 12));
end $$;

-- A rodada mostra todas as linhas de contexto (trecho único); sem o texto escondido nem as seguintes
create or replace function public.npl_cont_view(p_track public.npl_tracks, p_ctx int)
returns jsonb
language sql immutable
set search_path = public
as $$
  select jsonb_build_object(
    'title', coalesce(p_track.title_short, p_track.title),
    'artist', p_track.artist,
    'artists', p_track.artists,
    'ctx', jsonb_array_length(p_track.cont->'lines'),
    'max', 1,
    'lines', coalesce((select jsonb_agg(jsonb_build_object('text', e->>'text', 'start', e->'start') order by n)
                         from jsonb_array_elements(p_track.cont->'lines') with ordinality as x(e, n)), '[]'::jsonb),
    'hidden', jsonb_build_object(
      'start', p_track.cont->'hidden'->'start',
      'words', coalesce(array_length(regexp_split_to_array(btrim(p_track.cont->'hidden'->>'text'), '\s+'), 1), 0)))
$$;

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
           'album', v_track.album),
         -- modo letra: os trechos sem "___" só aparecem agora
         lyrics = case when v_round.mode = 'lyrics' and v_round.lyrics ? 'total'
                       then v_round.lyrics || jsonb_build_object('plain', coalesce(v_track.lyrics->'plain', '[]'::jsonb))
                       else v_round.lyrics end,
         -- continuar a letra: a linha escondida (com início e fim) só aparece agora
         cont = case when v_round.mode = 'continue' and v_round.cont ? 'hidden'
                     then v_round.cont || jsonb_build_object('reveal', v_track.cont->'hidden',
                                                             'after', coalesce(v_track.cont->'after', '[]'::jsonb))
                     else v_round.cont end
   where id = p_round_id;
end $$;

-- "Próxima música" durante o cantar junto: vai para a tela de revelação normal
create or replace function public.npl_cont_skip(p_code text, p_owner_token text, p_round_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_room public.npl_rooms := public.npl_lock_room(p_code);
begin
  perform public.npl_require_owner(v_room, p_owner_token);
  update public.npl_rounds set cont = cont || '{"sung": true}'::jsonb
   where id = p_round_id and room_id = v_room.id and mode = 'continue'
     and status in ('revealed', 'scoreboard') and not coalesce((cont->>'sung')::boolean, false);
  if found then perform public.npl_touch(v_room.id, 'sung'); end if;
end $$;

revoke execute on function
  public.npl_clean_cont_lines(jsonb, int),
  public.npl_clean_cont(jsonb),
  public.npl_cont_view(public.npl_tracks, int),
  public.npl_reveal_round(uuid, boolean)
  from public, anon, authenticated;
