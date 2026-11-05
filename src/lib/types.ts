// Tipos compartilhados entre servidor e clientes.

export type MusicSource =
  | { type: "preset"; id: string; label: string }
  | { type: "playlist"; id: string; label: string; picture?: string | null; nbTracks?: number }
  | { type: "artist"; id: string; label: string; picture?: string | null; level?: ArtistLevel };

/** Popularidade das músicas de um artista: top 15 | top 50 (padrão) | catálogo inteiro. */
export type ArtistLevel = "hits" | "known" | "fan";

export type Scoring = "artist_title" | "title"; // "Artista e música" | "Só a música"
export type AnswerMode = "spoken" | "typed"; // "Falada" | "Digitada"
export type RoomStyle = "all" | "host"; // "Todos jogam" | "Com apresentador"
export type SfxVolume = "low" | "medium" | "high";
/** Trechos: "sequence" = todos do início da prévia; "alternate" = cada um num ponto sorteado. */
export type ClipMode = "sequence" | "alternate";
/** Tema visual da sala. */
export type RoomTheme = "party" | "neon" | "retro" | "beach" | "xmas";
/** Empate no 1º lugar: "sudden" = morte súbita (música extra); "accept" = aceitar empate. */
export type Tiebreak = "sudden" | "accept";

/** Bloqueio de um time depois de errar. started_at/until = null: aguardando a música voltar. */
export type TeamLock = { secs: number; started_at: string | null; until: string | null };

/** Configuração da sala. Guardada como JSON (extensível para novos modos). */
export type ModeId = "classic" | "auction" | "lyrics" | "continue";

export type RoomSettings = {
  mode: ModeId; // modo fixo da partida
  modeSelection: "fixed" | "random"; // "random": sorteia o modo de cada rodada entre os do modePool
  modePool: ModeId[]; // modos ligados (2+ = a partida mistura)
  modeOrder?: "alternate" | "random" | "blocks"; // com 2+ modos (padrão "alternate")
  rounds: number; // 5..30
  answerSeconds: 0 | 10 | 20 | 30; // 0 = sem limite
  penalty: 0 | 20 | 50;
  scoring: Scoring;
  roomStyle: RoomStyle;
  answerMode: AnswerMode; // no estilo "all" é sempre "typed"
  lockSeconds: 5 | 10 | 15 | 20 | 30; // bloqueio após erro (conta só com a música tocando)
  sounds: boolean; // efeitos sonoros na TV
  sfxVolume?: SfxVolume; // volume dos efeitos (padrão "high")
  clipMode?: ClipMode; // trechos (padrão "sequence")
  tiebreak?: Tiebreak; // desempate (padrão "sudden")
  versionFilter?: boolean; // descarta ao vivo, acústico, remix, coletâneas… (padrão true)
  theme?: RoomTheme; // visual da TV e dos celulares (padrão "party")
  teamMode: "teams" | "solo";
  teamCount: number;
  sources: MusicSource[];
};

/** Modo letra: trechos de 2 linhas (o último é o refrão). masked = título/artista viram "___". */
export type LyricVerses = { masked: string[][]; plain: string[][] };

export type PickedTrack = {
  deezer_id: number;
  title: string;
  title_short: string;
  artist: string;
  artists: string[];
  cover: string | null;
  album: string | null;
  lyrics?: LyricVerses; // só quando a partida usa o modo letra (vai para npl_tracks, oculto)
  mode?: ModeId; // modo planejado para a rodada desta posição
  cont?: ContinuePlan; // "Continuar a letra": linhas de contexto + a escondida (vai para npl_tracks, oculto)
};

/**
 * Dica do Leilão: gênero + ano. year = menor ano de lançamento da mesma música
 * no Deezer (sem coletâneas/ao vivo/remasters…), null quando não é confiável.
 * track_year = ano do álbum da faixa que toca (ex.: remaster de 2010).
 */
export type TrackMeta = { genre: string | null; year: number | null; compilation: boolean; track_year: number | null };

export type Phase ="config" | "lobby" | "playing" | "finished";
export type RoundStatus = "loading" | "playing" | "answering" | "doubt" | "revealed" | "scoreboard";
export type AttemptStatus = "open" | "doubt" | "correct" | "wrong" | "timeout" | "cancelled" | "late";
export type FieldResult = "ok" | "doubt" | "wrong" | "empty" | null;

export type Room = {
  id: string;
  code: string;
  phase: Phase;
  settings: RoomSettings;
  match_no: number;
  round_no: number;
  total_rounds: number;
  paused: boolean;
  paused_at: string | null;
  pause_reason: "owner" | "owner_away" | null;
  /** preparação em segundo plano ("Continuar a letra") */
  prep?: { active?: boolean; done?: number; total?: number };
  version: number;
  created_at: string;
  last_activity_at: string;
};

export type Team = { id: string; room_id: string; idx: number; name: string; color: string; score: number; icon?: string | null };

export type Player = {
  id: string;
  room_id: string;
  nickname: string;
  icon?: string | null; // emoji do jogador
  team_id: string | null;
  active_from_round: number;
  wants_rematch: boolean;
  joined_at: string;
};

export type Reveal = {
  deezer_id: number;
  title: string;
  artist: string;
  artists: string[];
  cover: string | null;
  album: string | null;
  lyrics?: LyricVerses; // só quando a partida usa o modo letra (vai para npl_tracks, oculto)
  mode?: ModeId; // modo planejado para a rodada desta posição
  cont?: ContinuePlan; // "Continuar a letra": linhas de contexto + a escondida (vai para npl_tracks, oculto)
};

/** Leilão: "artist" = TV mostra o artista (vale a música); "genre" = gênero + ano (vale o artista). */
export type AuctionHint = "artist" | "genre";

/** Estado do leilão (npl_rounds.auction), só nas rodadas do modo "auction". */
export type AuctionState = {
  hint: AuctionHint;
  artist: string | null;
  artists: string[] | null;
  genre: string | null;
  year: number | null;
  track_year?: number | null; // ano da versão que toca (pode ser diferente de year)
  phase: "bidding" | "proving";
  starts_at: string;
  order: string[]; // times na ordem do rodízio
  turn: string | null; // time da vez (lances)
  turn_deadline: string | null;
  low: number; // menor lance atual (20 = ninguém deu lance)
  low_team: string | null;
  bids: Record<string, number>;
  passes: string[];
  log: { team: string; secs: number | null; at: string }[]; // secs null = "Pode tocar!"
  queue: { team: string; secs: number }[]; // fila de prova
  qidx: number; // posição atual da fila
  played: number; // última posição que já ouviu o trecho
  winner: string | null; // venceu o leilão (menor lance)
};

/** "Continuar a letra": linha com tempos em segundos da prévia. */
export type ContLine = { text: string; start: number; end: number };
export type ContinuePlan = { lines: ContLine[]; hidden: ContLine; after: ContLine[] };
/** O que todos veem na rodada (sem o texto da linha escondida até a revelação). */
export type ContinueState = {
  title?: string;
  artist?: string;
  artists?: string[];
  ctx: number; // 2 | 3 | 4 linhas de contexto
  max: number; // estágios desta música (1 a 3)
  lines: { text: string; start: number }[];
  hidden: { words: number; start: number };
  reveal?: ContLine; // só na revelação
  after?: ContLine[]; // só na revelação: as linhas seguintes (cantar junto)
  sung?: boolean; // "Próxima música" pulou o cantar junto
};

/** Modo letra: o que todos veem (o servidor só manda os trechos já revelados). */
export type LyricsState = {
  total: number; // quantos trechos a música tem (3 a 5)
  shown: string[][]; // trechos revelados, com "___"
  plain?: string[][]; // só depois da revelação: todos os trechos sem "___"
};

/** Rodada de desempate (morte súbita): só os times empatados no 1º lugar jogam. */
export type TiebreakState = {
  teams: string[]; // times que disputam esta música
  out: string[]; // erraram: fora do desempate
  survivor: string | null; // sobrou um só (os outros erraram): ele vence
  n: number; // 1ª, 2ª… música de desempate
};

export type Round = {
  id: string;
  room_id: string;
  match_no: number;
  round_no: number;
  mode: string;
  status: RoundStatus;
  stage: number;
  stage_started_at: string | null;
  locked_team_id: string | null;
  had_error: boolean;
  current_attempt_id: string | null;
  winner_team_id: string | null;
  points: number;
  skipped: boolean;
  reveal: Reveal | null;
  offsets: number[]; // segundo de início de cada trecho (sorteado no início da rodada)
  play_seq: number; // +1 a cada "Tocar" / "Repetir" / "Próximo trecho"
  played_stage: number; // último estágio tocado (0 = nenhum)
  play_at: string | null;
  artist_team_id: string | null;
  title_team_id: string | null;
  found: { artist?: string; title?: string }; // partes já descobertas
  locks: Record<string, TeamLock>; // team_id -> bloqueio (relógio do servidor)
  auction: Partial<AuctionState>; // vazio ({}) fora do leilão
  tiebreak?: Partial<TiebreakState>; // vazio ({}) fora do desempate
  lyrics?: Partial<LyricsState>; // vazio ({}) fora do modo letra
  cont?: Partial<ContinueState>; // vazio ({}) fora do "Continuar a letra"
  created_at: string;
  started_at: string | null;
  revealed_at: string | null;
};

export type Attempt = {
  id: string;
  room_id: string;
  round_id: string;
  team_id: string | null;
  player_id: string | null;
  kind: "turn" | "late";
  parent_id: string | null;
  status: AttemptStatus;
  created_at: string;
  deadline: string | null;
  stage: number;
  stage_points: number;
  ms_into_stage: number;
  steal: boolean;
  answered_by: string | null;
  answer_artist: string | null;
  answer_title: string | null;
  artist_result: FieldResult;
  title_result: FieldResult;
  points: number;
  decided_by: "auto" | "owner" | null;
  overridden: boolean;
  decided_at: string | null;
};

export type RoomState = {
  server_now: number;
  room: Room;
  owner: { claimed: boolean; player_id: string | null };
  teams: Team[];
  players: Player[];
  rounds: Round[];
  attempts: Attempt[];
};
