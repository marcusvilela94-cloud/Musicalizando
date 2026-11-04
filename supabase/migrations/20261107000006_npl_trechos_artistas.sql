-- =====================================================================
-- Musicalizando — 006: configuração "Trechos" (em sequência | alternando)
-- e conferência de artista com todos os créditos e conectores de parceria.
-- Aplicar DEPOIS das migrações 001–005. Pode rodar mais de uma vez.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Configuração: clipMode = sequence ("Em sequência", padrão) | alternate ("Alternando")
-- ---------------------------------------------------------------------
create or replace function public.npl_default_settings()
returns jsonb
language sql immutable
set search_path = public
as $$
  select jsonb_build_object(
    'mode', 'classic',
    'modeSelection', 'fixed',
    'modePool', jsonb_build_array('classic'),
    'rounds', 10,
    'answerSeconds', 20,            -- 0 = sem limite
    'penalty', 0,
    'scoring', 'artist_title',      -- artist_title ("Artista e música") | title ("Só a música")
    'roomStyle', 'all',             -- all ("Todos jogam", controles na TV) | host ("Com apresentador")
    'answerMode', 'spoken',         -- só no estilo host: spoken (falada) | typed (digitada)
    'lockSeconds', 15,              -- bloqueio após erro: 5 | 10 | 15 | 20 | 30
    'sounds', true,                 -- efeitos sonoros na TV
    'sfxVolume', 'high',            -- volume dos efeitos: low | medium | high
    'clipMode', 'sequence',         -- trechos: sequence (todos do início) | alternate (pontos sorteados)
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

-- ---------------------------------------------------------------------
-- Artistas: "&", " e ", " and ", " x ", " feat. ", " ft. " são equivalentes
-- ---------------------------------------------------------------------
create or replace function public.npl_normalize_artist(t text)
returns text
language plpgsql immutable
set search_path = public
as $$
declare s text := ' ' || public.npl_normalize(t) || ' ';
begin
  -- npl_normalize já trata "&", "e", "and"; aqui entram x / feat / ft / featuring
  s := regexp_replace(s, ' (x|feat|ft|featuring) ', ' ', 'g');
  s := regexp_replace(s, ' (x|feat|ft|featuring) ', ' ', 'g');
  return btrim(regexp_replace(s, '\s+', ' ', 'g'));
end $$;

-- Classifica a resposta contra a lista de respostas certas:
-- ok (<= 20%), doubt (20%..40%), wrong (> 40%), empty (campo vazio).
-- Artista: os candidatos são todos os créditos da faixa (principal + contributors),
-- cada um inteiro (um integrante sozinho de "Jorge & Mateus" não vale). Se a
-- resposta citar vários artistas ("Anitta e Pabllo Vittar"), basta um deles bater.
create or replace function public.npl_classify(p_answer text, p_candidates text[], p_is_title boolean)
returns text
language plpgsql immutable
set search_path = public
as $$
declare
  v_raw text := left(coalesce(p_answer, ''), 120);
  v_answers text[];
  v_ans text;
  v_c text;
  v_norm text;
  v_best numeric := 1;
begin
  if p_is_title then
    v_answers := array[public.npl_normalize(public.npl_clean_title(v_raw))];
  else
    v_answers := array[public.npl_normalize_artist(v_raw)];
    -- pedaços da resposta separados por conectores
    v_answers := v_answers || array(
      select public.npl_normalize_artist(p)
        from regexp_split_to_table(v_raw,
               '\s*[,&/+;]\s*|\s+(e|and|x|y|feat\.?|ft\.?|featuring|com|with)\s+', 'i') as p
       where public.npl_normalize_artist(p) <> '');
  end if;
  if v_answers[1] = '' then return 'empty'; end if;

  foreach v_c in array coalesce(p_candidates, array[]::text[]) loop
    v_norm := case when p_is_title then public.npl_normalize(public.npl_clean_title(v_c))
                   else public.npl_normalize_artist(v_c) end;
    if v_norm <> '' then
      foreach v_ans in array v_answers loop
        v_best := least(v_best, public.npl_distance(v_ans, v_norm));
      end loop;
    end if;
  end loop;
  if v_best <= 0.20 then return 'ok'; end if;
  if v_best <= 0.40 then return 'doubt'; end if;
  return 'wrong';
end $$;

revoke execute on function
  public.npl_clean_settings(jsonb)
  from public, anon, authenticated;
