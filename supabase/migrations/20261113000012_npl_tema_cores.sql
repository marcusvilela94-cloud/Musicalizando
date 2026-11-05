-- =====================================================================
-- Musicalizando — 012: tema visual da sala e cor do time escolhida.
-- Aplicar DEPOIS das migrações 001–011. Pode rodar mais de uma vez.
--
-- settings.theme = party (padrão) | neon | retro | beach | xmas
-- npl_set_team_color: quem está no time (ou dono/apresentador) escolhe uma
-- cor da paleta que nenhum outro time da sala esteja usando. Se o time ainda
-- tem o nome padrão ("Time Verde"), o nome acompanha a cor nova.
-- =====================================================================

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
  if coalesce(s->>'mode', '') not in ('classic', 'auction', 'lyrics') then
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
            where jsonb_typeof(e) = 'string' and e #>> '{}' in ('classic', 'auction', 'lyrics')
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

create or replace function public.npl_set_team_color(p_code text, p_token text, p_team_id uuid, p_color text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.npl_rooms := public.npl_lock_room(p_code);
  v_team public.npl_teams;
  v_new jsonb;
  v_old jsonb;
begin
  -- mesma regra do nome do time: quem está no time, o dono ou o apresentador
  if v_room.owner_hash <> public.npl_hash(p_token)
     and v_room.ctrl_hash is distinct from public.npl_hash(p_token)
     and not exists (
       select 1 from public.npl_players
        where room_id = v_room.id and token_hash = public.npl_hash(p_token) and team_id = p_team_id) then
    raise exception 'npl:not_allowed';
  end if;
  select * into v_team from public.npl_teams where id = p_team_id and room_id = v_room.id for update;
  if not found then raise exception 'npl:team_not_found'; end if;
  select e into v_new from jsonb_array_elements(public.npl_palette()) as e where upper(e->>'color') = upper(p_color);
  if v_new is null then raise exception 'npl:bad_color'; end if;
  if upper(v_team.color) = upper(v_new->>'color') then return; end if;
  if exists (select 1 from public.npl_teams
              where room_id = v_room.id and id <> p_team_id and upper(color) = upper(v_new->>'color')) then
    raise exception 'npl:color_taken';
  end if;
  select e into v_old from jsonb_array_elements(public.npl_palette()) as e where upper(e->>'color') = upper(v_team.color);
  update public.npl_teams
     set color = v_new->>'color',
         name = case when v_old is not null and name = 'Time ' || (v_old->>'name')
                     then 'Time ' || (v_new->>'name') else name end
   where id = p_team_id;
  perform public.npl_touch(v_room.id, 'team');
end $$;

revoke execute on function public.npl_clean_settings(jsonb) from public, anon, authenticated;
