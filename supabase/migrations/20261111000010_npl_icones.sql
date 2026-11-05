-- =====================================================================
-- Musicalizando — 010: ícones (emojis) para jogadores e times.
-- Aplicar DEPOIS das migrações 001–009. Pode rodar mais de uma vez.
--
-- Cada jogador e cada time ganha um emoji sorteado ao ser criado (um que
-- ainda não esteja em uso na sala). O jogador troca o dele; o time é trocado
-- por quem está nele (ou pelo dono/apresentador), como o nome do time.
-- "Cada um por si": o time acompanha o ícone do jogador.
-- A lista abaixo é a mesma de src/lib/icons.ts.
-- =====================================================================

alter table public.npl_teams add column if not exists icon text;
alter table public.npl_players add column if not exists icon text;

create or replace function public.npl_icons()
returns text[]
language sql immutable
set search_path = public
as $$
  select array[
    '🦖','🦄','🐙','🦊','🐸','🐼','🐨','🐯','🦁','🐵','🐧','🦉','🦩','🐢','🐳','🦈','🐝','🦋','🐌','🦀',
    '🍕','🌮','🍩','🍔','🥑','🍉','🍦','🧀','🥨','🍟','🎸','🎺','🥁','🎷','🎤','🎧','🚀','👽','🤖','👻',
    '🤠','🥸','😎','🤡','💀','🌈','🔥','⚡','🌵','🍄','🎩','👑','🦸','🧙','🐔','🦥','🦦','🐷','🦝','🐲'
  ]
$$;

-- Sorteia um emoji que ainda não está em uso na sala (senão, qualquer um)
create or replace function public.npl_pick_icon(p_room_id uuid, p_kind text)
returns text
language plpgsql volatile
set search_path = public
as $$
declare
  v_used text[];
  v_free text[];
  v_all text[] := public.npl_icons();
begin
  if p_kind = 'team' then
    select coalesce(array_agg(icon), '{}') into v_used from public.npl_teams where room_id = p_room_id and icon is not null;
  else
    select coalesce(array_agg(icon), '{}') into v_used from public.npl_players where room_id = p_room_id and icon is not null;
  end if;
  select array_agg(i) into v_free from unnest(v_all) as i where not (i = any(v_used));
  if coalesce(cardinality(v_free), 0) = 0 then v_free := v_all; end if;
  return v_free[1 + floor(random() * cardinality(v_free))::int];
end $$;

-- Emoji padrão ao criar time/jogador
create or replace function public.npl_default_icon()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.icon is null or not (new.icon = any(public.npl_icons())) then
    new.icon := public.npl_pick_icon(new.room_id, case when tg_table_name = 'npl_teams' then 'team' else 'player' end);
  end if;
  return new;
end $$;

drop trigger if exists npl_teams_icon on public.npl_teams;
create trigger npl_teams_icon before insert on public.npl_teams
  for each row execute function public.npl_default_icon();
drop trigger if exists npl_players_icon on public.npl_players;
create trigger npl_players_icon before insert on public.npl_players
  for each row execute function public.npl_default_icon();

-- "Cada um por si": o time (que é o próprio jogador) usa o ícone do jogador
create or replace function public.npl_solo_team_icon()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.team_id is not null and new.icon is not null
     and (select settings->>'teamMode' from public.npl_rooms where id = new.room_id) = 'solo' then
    update public.npl_teams set icon = new.icon where id = new.team_id and icon is distinct from new.icon;
  end if;
  return new;
end $$;

drop trigger if exists npl_players_solo_icon on public.npl_players;
create trigger npl_players_solo_icon after insert or update of icon, team_id on public.npl_players
  for each row execute function public.npl_solo_team_icon();

-- salas que já existem
update public.npl_teams set icon = public.npl_pick_icon(room_id, 'team') where icon is null;
update public.npl_players set icon = public.npl_pick_icon(room_id, 'player') where icon is null;

-- ---------------------------------------------------------------------
-- Trocar ícone
-- ---------------------------------------------------------------------
create or replace function public.npl_set_icon(p_code text, p_token text, p_icon text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.npl_rooms := public.npl_lock_room(p_code);
  v_player public.npl_players := public.npl_player_by_token(v_room.id, p_token);
begin
  if not (p_icon = any(public.npl_icons())) then raise exception 'npl:bad_icon'; end if;
  update public.npl_players set icon = p_icon where id = v_player.id;
  perform public.npl_touch(v_room.id, 'player');
end $$;

create or replace function public.npl_set_team_icon(p_code text, p_token text, p_team_id uuid, p_icon text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.npl_rooms := public.npl_lock_room(p_code);
begin
  if not (p_icon = any(public.npl_icons())) then raise exception 'npl:bad_icon'; end if;
  -- mesma regra do nome do time: quem está no time, o dono ou o apresentador
  if v_room.owner_hash <> public.npl_hash(p_token)
     and v_room.ctrl_hash is distinct from public.npl_hash(p_token)
     and not exists (
       select 1 from public.npl_players
        where room_id = v_room.id and token_hash = public.npl_hash(p_token) and team_id = p_team_id) then
    raise exception 'npl:not_allowed';
  end if;
  update public.npl_teams set icon = p_icon where id = p_team_id and room_id = v_room.id;
  perform public.npl_touch(v_room.id, 'team');
end $$;

revoke execute on function
  public.npl_icons(),
  public.npl_pick_icon(uuid, text),
  public.npl_default_icon(),
  public.npl_solo_team_icon()
  from public, anon, authenticated;
