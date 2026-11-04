-- =====================================================================
-- Musicalizando — 001: tabelas
-- Projeto Supabase COMPARTILHADO: tudo aqui usa o prefixo npl_ e nada
-- fora desse prefixo é criado, alterado ou apagado.
-- =====================================================================

-- Salas ---------------------------------------------------------------
create table if not exists public.npl_rooms (
  id               uuid primary key default gen_random_uuid(),
  code             text not null,
  owner_hash       text not null,                      -- md5 do token do dono (o token nunca é guardado)
  phase            text not null default 'config'
                   check (phase in ('config', 'lobby', 'playing', 'finished')),
  settings         jsonb not null default '{}'::jsonb, -- configuração extensível (modos, fontes, regras)
  match_no         int  not null default 0,            -- nº da partida dentro da sala (revanche = +1)
  round_no         int  not null default 0,            -- rodada atual da partida (0 = nenhuma)
  total_rounds     int  not null default 0,
  paused           boolean not null default false,
  paused_at        timestamptz,
  version          bigint not null default 0,          -- incrementa a cada mudança (sincronização)
  created_at       timestamptz not null default now(),
  last_activity_at timestamptz not null default now()
);
create unique index if not exists npl_rooms_code_key on public.npl_rooms (code);
create index if not exists npl_rooms_activity_idx on public.npl_rooms (last_activity_at);

-- Times ---------------------------------------------------------------
create table if not exists public.npl_teams (
  id         uuid primary key default gen_random_uuid(),
  room_id    uuid not null references public.npl_rooms (id) on delete cascade,
  idx        int  not null,
  name       text not null,
  color      text not null,
  score      int  not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists npl_teams_room_idx on public.npl_teams (room_id, idx);

-- Jogadores -----------------------------------------------------------
create table if not exists public.npl_players (
  id                uuid primary key default gen_random_uuid(),
  room_id           uuid not null references public.npl_rooms (id) on delete cascade,
  token_hash        text not null,                     -- md5 do token gerado no navegador
  nickname          text not null,
  team_id           uuid references public.npl_teams (id) on delete set null,
  active_from_round int  not null default 0,           -- quem entra no meio joga a partir da próxima rodada
  wants_rematch     boolean not null default false,
  joined_at         timestamptz not null default now()
);
create unique index if not exists npl_players_token_key on public.npl_players (room_id, token_hash);
create index if not exists npl_players_team_idx on public.npl_players (team_id);

-- Músicas sorteadas (OCULTA para os clientes: contém as respostas) ----
create table if not exists public.npl_tracks (
  room_id     uuid not null references public.npl_rooms (id) on delete cascade,
  match_no    int  not null,
  position    int  not null,
  deezer_id   bigint not null,
  title       text not null,
  title_short text,
  artist      text not null,
  artists     jsonb not null default '[]'::jsonb,      -- principal + participações (texto)
  cover       text,
  album       text,
  primary key (room_id, match_no, position)
);

-- Rodadas -------------------------------------------------------------
create table if not exists public.npl_rounds (
  id                 uuid primary key default gen_random_uuid(),
  room_id            uuid not null references public.npl_rooms (id) on delete cascade,
  match_no           int  not null,
  round_no           int  not null,
  mode               text not null default 'classic',
  status             text not null default 'loading'
                     check (status in ('loading', 'playing', 'answering', 'doubt', 'revealed', 'scoreboard')),
  stage              int  not null default 0,
  stage_started_at   timestamptz,
  locked_team_id     uuid references public.npl_teams (id) on delete set null,
  had_error          boolean not null default false,  -- já houve erro nesta música (acerto vira "roubo")
  current_attempt_id uuid,
  winner_team_id     uuid references public.npl_teams (id) on delete set null,
  points             int  not null default 0,
  skipped            boolean not null default false,
  reveal             jsonb,                            -- título/artista/capa: só preenchido na revelação
  created_at         timestamptz not null default now(),
  started_at         timestamptz,
  revealed_at        timestamptz
);
create unique index if not exists npl_rounds_room_round_key on public.npl_rounds (room_id, match_no, round_no);

-- Tentativas (toques no botão + respostas) ----------------------------
create table if not exists public.npl_attempts (
  id            uuid primary key default gen_random_uuid(),
  room_id       uuid not null references public.npl_rooms (id) on delete cascade,
  round_id      uuid not null references public.npl_rounds (id) on delete cascade,
  team_id       uuid references public.npl_teams (id) on delete set null,
  player_id     uuid references public.npl_players (id) on delete set null,
  kind          text not null default 'turn' check (kind in ('turn', 'late')),
  parent_id     uuid,                                  -- para 'late': o toque que ganhou a vez
  status        text not null default 'open'
                check (status in ('open', 'doubt', 'correct', 'wrong', 'timeout', 'cancelled', 'late')),
  created_at    timestamptz not null default clock_timestamp(),
  deadline      timestamptz,
  stage         int  not null default 0,
  stage_points  int  not null default 0,
  ms_into_stage int  not null default 0,
  steal         boolean not null default false,
  answered_by   uuid references public.npl_players (id) on delete set null,
  answer_artist text,
  answer_title  text,
  artist_result text,                                  -- ok | doubt | wrong | empty
  title_result  text,
  points        int  not null default 0,               -- pontos (ou penalidade negativa) desta tentativa
  decided_by    text,                                  -- auto | owner
  overridden    boolean not null default false,
  decided_at    timestamptz
);
create index if not exists npl_attempts_round_idx on public.npl_attempts (round_id, created_at);
create index if not exists npl_attempts_room_idx on public.npl_attempts (room_id);

-- Correções manuais de placar -----------------------------------------
create table if not exists public.npl_score_adjustments (
  id         uuid primary key default gen_random_uuid(),
  room_id    uuid not null references public.npl_rooms (id) on delete cascade,
  match_no   int  not null,
  team_id    uuid not null references public.npl_teams (id) on delete cascade,
  delta      int  not null,
  created_at timestamptz not null default now()
);
create index if not exists npl_score_adj_room_idx on public.npl_score_adjustments (room_id, match_no);

-- RLS: ligado em todas as tabelas e SEM policies -> acesso direto negado.
-- Leitura acontece só por npl_get_state(código) e escrita só pelas RPCs
-- security definer, que validam o token do jogador/dono.
alter table public.npl_rooms             enable row level security;
alter table public.npl_teams             enable row level security;
alter table public.npl_players           enable row level security;
alter table public.npl_tracks            enable row level security;
alter table public.npl_rounds            enable row level security;
alter table public.npl_attempts          enable row level security;
alter table public.npl_score_adjustments enable row level security;

revoke all on table public.npl_rooms, public.npl_teams, public.npl_players, public.npl_tracks,
  public.npl_rounds, public.npl_attempts, public.npl_score_adjustments
  from anon, authenticated;
