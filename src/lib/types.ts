// Tipos compartilhados entre servidor e clientes.

export type MusicSource =
  | { type: "preset"; id: string; label: string }
  | { type: "playlist"; id: string; label: string; picture?: string | null; nbTracks?: number }
  | { type: "artist"; id: string; label: string; picture?: string | null };

export type Scoring = "artist_title" | "title"; // "Artista e música" | "Só a música"
export type AnswerMode = "spoken" | "typed"; // "Falada" | "Digitada"
export type RoomStyle = "all" | "host"; // "Todos jogam" | "Com apresentador"
export type SfxVolume = "low" | "medium" | "high";
/** Trechos: "sequence" = todos do início da prévia; "alternate" = cada um num ponto sorteado. */
export type ClipMode = "sequence" | "alternate";

/** Bloqueio de um time depois de errar. started_at/until = null: aguardando a música voltar. */
export type TeamLock = { secs: number; started_at: string | null; until: string | null };

/** Configuração da sala. Guardada como JSON (extensível para novos modos). */
export type ModeId = "classic" | "auction";

export type RoomSettings = {
  mode: ModeId; // modo fixo da partida
  modeSelection: "fixed" | "random"; // "random": sorteia o modo de cada rodada entre os do modePool
  modePool: ModeId[];
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
  teamMode: "teams" | "solo";
  teamCount: number;
  sources: MusicSource[];
};

export type PickedTrack = {
  deezer_id: number;
  title: string;
  title_short: string;
  artist: string;
  artists: string[];
  cover: string | null;
  album: string | null;
};

/** Dica do Leilão: gênero e ano do álbum da faixa (null quando não é confiável). */
export type TrackMeta = { genre: string | null; year: number | null; compilation: boolean };

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
  version: number;
  created_at: string;
  last_activity_at: string;
};

export type Team = { id: string; room_id: string; idx: number; name: string; color: string; score: number };

export type Player = {
  id: string;
  room_id: string;
  nickname: string;
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
