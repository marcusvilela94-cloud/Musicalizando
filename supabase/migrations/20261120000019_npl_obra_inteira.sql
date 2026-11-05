-- =====================================================================
-- Musicalizando — 019: "Qual é a obra?" toca a prévia inteira de uma vez.
-- Aplicar DEPOIS da 018. Pode rodar mais de uma vez.
--
-- Um só estágio valendo 100 (sem trechos crescentes): "Tocar"/"Repetir"
-- tocam a prévia toda; não há "Próximo trecho".
-- =====================================================================

create or replace function public.npl_stage_count(p_mode text)
returns int
language sql immutable
set search_path = public
as $$ select case p_mode when 'lyrics' then 5 when 'continue' then 1 when 'quiz_open' then 1 when 'quiz_choice' then 1
                         when 'obra' then 1 else 6 end $$;

create or replace function public.npl_stage_points(p_mode text, p_stage int)
returns int
language sql immutable
set search_path = public
as $$
  select case p_mode
    when 'lyrics' then (array[100, 75, 50, 30, 15])[greatest(1, least(5, p_stage))]
    when 'continue' then 100
    when 'quiz_open' then 100
    when 'quiz_choice' then 100
    when 'obra' then 100
    else (array[100, 80, 60, 40, 25, 10])[greatest(1, least(6, p_stage))]
  end
$$;
