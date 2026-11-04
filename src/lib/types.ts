// Tipos compartilhados entre servidor e clientes.

export type MusicSource =
  | { type: "preset"; id: string; label: string }
  | { type: "playlist"; id: string; label: string; picture?: string | null; nbTracks?: number }
  | { type: "artist"; id: string; label: string; picture?: string | null };

export type Scoring = "artist_title" | "title";

/** Configuração da sala. Guardada como JSON (extensível para novos modos). */
export type RoomSettings = {
  mode: string; // modo fixo da partida (fase 1: "classic")
  modeSelection: "fixed" | "random"; // fase 2: sorteio de modo por rodada
  modePool: string[];
  rounds: number; // 5..30
  answerSeconds: 0 | 10 | 20 | 30; // 0 = sem limite
  penalty: 0 | 20 | 50;
  scoring: Scoring;
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

export type Phase = "config" | "lobby" | "playing" | "finished";
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
};

export type RoomState = {
  server_now: number;
  room: Room;
  teams: Team[];
  players: Player[];
  rounds: Round[];
  attempts: Attempt[];
};
