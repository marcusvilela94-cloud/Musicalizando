"use client";
// Wrappers das RPCs npl_* (únicas escritas permitidas no banco).
import { supabase } from "./supabase";
import type { PickedTrack, RoomSettings, RoomState, TrackMeta } from "./types";

type Listener = (kind: string, extra?: Record<string, unknown>) => void;
let afterMutation: Listener | null = null;

/** O hook da sala registra aqui: depois de cada escrita, avisa os outros aparelhos e recarrega. */
export function onAfterMutation(fn: Listener | null) {
  afterMutation = fn;
}

async function call<T>(fn: string, args: Record<string, unknown>, mutation = true): Promise<T> {
  const { data, error } = await supabase().rpc(fn, args);
  if (error) throw new Error(error.message);
  if (mutation) afterMutation?.(fn, (data && typeof data === "object" ? data : {}) as Record<string, unknown>);
  return data as T;
}

export const api = {
  // leitura
  getState: (code: string) => call<RoomState | null>("npl_get_state", { p_code: code }, false),
  isOwner: (code: string, owner: string) => call<boolean>("npl_is_owner", { p_code: code, p_owner_token: owner }, false),
  hostTracks: (code: string, owner: string) =>
    call<{ round_no: number; deezer_id: number }[]>("npl_host_tracks", { p_code: code, p_owner_token: owner }, false),

  // sala
  createRoom: (owner: string, settings: Partial<RoomSettings>) =>
    call<{ room_id: string; code: string }>("npl_create_room", { p_owner_token: owner, p_settings: settings }, false),
  updateSettings: (code: string, owner: string, settings: Partial<RoomSettings>) =>
    call<RoomSettings>("npl_update_settings", { p_code: code, p_owner_token: owner, p_settings: settings }),
  setPhase: (code: string, owner: string, phase: "config" | "lobby") =>
    call<void>("npl_set_phase", { p_code: code, p_owner_token: owner, p_phase: phase }),

  // jogadores / times
  join: (code: string, token: string, nickname: string) =>
    call<{ id: string; team_id: string | null }>("npl_join", { p_code: code, p_token: token, p_nickname: nickname }),
  setTeam: (code: string, token: string, teamId: string) =>
    call<void>("npl_set_team", { p_code: code, p_token: token, p_team_id: teamId }),
  renameTeam: (code: string, token: string, teamId: string, name: string) =>
    call<void>("npl_rename_team", { p_code: code, p_token: token, p_team_id: teamId, p_name: name }),
  shuffleTeams: (code: string, owner: string) => call<void>("npl_shuffle_teams", { p_code: code, p_owner_token: owner }),
  movePlayer: (code: string, owner: string, playerId: string, teamId: string | null) =>
    call<void>("npl_move_player", { p_code: code, p_owner_token: owner, p_player_id: playerId, p_team_id: teamId }),
  removePlayer: (code: string, owner: string, playerId: string) =>
    call<void>("npl_remove_player", { p_code: code, p_owner_token: owner, p_player_id: playerId }),
  rematchVote: (code: string, token: string, value: boolean) =>
    call<void>("npl_rematch_vote", { p_code: code, p_token: token, p_value: value }),

  // partida
  /** rounds: quantas rodadas jogar (modo letra com menos músicas com letra que o escolhido). */
  startMatch: (code: string, owner: string, tracks: PickedTrack[], rounds: number) =>
    call<{ match_no: number; total_rounds: number }>("npl_start_match", {
      p_code: code,
      p_owner_token: owner,
      p_tracks: tracks,
      p_rounds: rounds,
    }),
  /** meta = gênero/ano do álbum (dica do Leilão; ignorado no clássico). */
  roundBegin: (code: string, host: string, roundId: string, artists: string[], offsets: number[], meta: TrackMeta | null) =>
    call<unknown>("npl_round_begin", {
      p_code: code,
      p_owner_token: host,
      p_round_id: roundId,
      p_artists: artists,
      p_offsets: offsets,
      p_meta: meta ?? {},
    }),
  /** Leilão: lance de `secs` segundos, ou "Pode tocar!" (secs = null). */
  auctionBid: (code: string, token: string, roundId: string, secs: number | null) =>
    call<{ ok: boolean; reason?: string; phase?: string; low?: number }>("npl_auction_bid", {
      p_code: code,
      p_token: token,
      p_round_id: roundId,
      p_secs: secs,
    }),
  /** Leilão: "Tocar" o trecho do time na posição `idx` da fila (uma vez só). */
  auctionPlay: (code: string, owner: string, roundId: string, idx: number) =>
    call<{ ok: boolean; attempt_id?: string }>("npl_auction_play", {
      p_code: code,
      p_owner_token: owner,
      p_round_id: roundId,
      p_idx: idx,
    }),
  /** Tocar/Repetir (advance=false) ou Próximo trecho (advance=true). */
  play: (code: string, owner: string, roundId: string, stage: number, advance: boolean) =>
    call<{ ok: boolean }>("npl_play", {
      p_code: code,
      p_owner_token: owner,
      p_round_id: roundId,
      p_stage: stage,
      p_advance: advance,
    }),
  skipRound: (code: string, owner: string, roundId: string) =>
    call<void>("npl_skip_round", { p_code: code, p_owner_token: owner, p_round_id: roundId }),
  endRound: (code: string, owner: string, roundId: string) =>
    call<void>("npl_end_round", { p_code: code, p_owner_token: owner, p_round_id: roundId }),
  showScoreboard: (code: string, owner: string, roundId: string) =>
    call<void>("npl_show_scoreboard", { p_code: code, p_owner_token: owner, p_round_id: roundId }),
  nextRound: (code: string, owner: string, fromRound: number) =>
    call<void>("npl_next_round", { p_code: code, p_owner_token: owner, p_from_round: fromRound }),
  finishMatch: (code: string, owner: string) => call<void>("npl_finish_match", { p_code: code, p_owner_token: owner }),
  pause: (code: string, owner: string, paused: boolean) =>
    call<void>("npl_pause", { p_code: code, p_owner_token: owner, p_paused: paused }),
  judge: (code: string, owner: string, attemptId: string, accept: boolean) =>
    call<string>("npl_judge", { p_code: code, p_owner_token: owner, p_attempt_id: attemptId, p_accept: accept }),
  /** Resposta falada: o dono marca "Artista certo" / "Música certa" (os dois falsos = "Errou"). */
  decide: (code: string, owner: string, attemptId: string, artist: boolean, title: boolean) =>
    call<string | null>("npl_decide", {
      p_code: code,
      p_owner_token: owner,
      p_attempt_id: attemptId,
      p_artist: artist,
      p_title: title,
    }),
  /** Inverter decisão: define quais partes a tentativa acertou. */
  overrideParts: (code: string, owner: string, attemptId: string, artist: boolean, title: boolean) =>
    call<void>("npl_override_parts", {
      p_code: code,
      p_owner_token: owner,
      p_attempt_id: attemptId,
      p_artist: artist,
      p_title: title,
    }),
  adjustScore: (code: string, owner: string, teamId: string, delta: number) =>
    call<void>("npl_adjust_score", { p_code: code, p_owner_token: owner, p_team_id: teamId, p_delta: delta }),
  endTurn: (code: string, owner: string, attemptId: string) =>
    call<void>("npl_end_turn", { p_code: code, p_owner_token: owner, p_attempt_id: attemptId }),
  tick: (code: string) => call<boolean>("npl_tick", { p_code: code }),
  hostAnswer: (code: string, owner: string) =>
    call<{ round_id: string; title: string; artist: string; artists: string[] } | null>(
      "npl_host_answer",
      { p_code: code, p_owner_token: owner },
      false,
    ),

  // celular do dono
  openClaim: (code: string, host: string, claim: string) =>
    call<void>("npl_open_claim", { p_code: code, p_host_token: host, p_claim: claim }, false),
  claimOwner: (code: string, claim: string, token: string) =>
    call<{ ok: boolean }>("npl_claim_owner", { p_code: code, p_claim: claim, p_token: token }),
  ownerAway: (code: string, host: string, away: boolean) =>
    call<void>("npl_owner_away", { p_code: code, p_host_token: host, p_away: away }),

  // botão e resposta
  buzz: (code: string, token: string, roundId: string) =>
    call<{ ok: boolean; reason?: string; attempt_id?: string; team_id?: string; behind_ms?: number; until?: string }>("npl_buzz", {
      p_code: code,
      p_token: token,
      p_round_id: roundId,
    }),
  submitAnswer: (code: string, token: string, attemptId: string, artist: string, title: string) =>
    call<{ ok: boolean; reason?: string; result?: string; points?: number; artist?: string; title?: string }>("npl_submit_answer", {
      p_code: code,
      p_token: token,
      p_attempt_id: attemptId,
      p_artist: artist,
      p_title: title,
    }),
};

// ---- Deezer (via rotas do Next) ----
async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `Erro ${res.status}`);
  return json as T;
}

export const deezer = {
  playlist: (url: string) =>
    getJson<{ id: string; title: string; nbTracks: number; picture: string | null }>(
      `/api/deezer/playlist?url=${encodeURIComponent(url)}`,
    ),
  artists: (q: string) =>
    getJson<{ id: string; name: string; picture: string | null; fans: number }[]>(
      `/api/deezer/artists?q=${encodeURIComponent(q)}`,
    ),
  /** lyrics: "all" = só músicas com letra; "some" = busca letra para as que tiverem. */
  build: (sources: RoomSettings["sources"], count: number, versionFilter: boolean, lyrics: "none" | "some" | "all") =>
    getJson<{ tracks: PickedTrack[]; warnings: string[]; withLyrics: number }>("/api/deezer/build", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sources, count, versionFilter, lyrics }),
    }),
  track: (id: number | string) =>
    getJson<{ id: string; preview: string; title: string; artist: string; artists: string[] }>(`/api/deezer/track/${id}`),
  /** Leilão: gênero + ano original (busca no Deezer, feita no servidor). */
  meta: (id: number | string) => getJson<TrackMeta>(`/api/deezer/meta/${id}`, { signal: AbortSignal.timeout(12000) }),
};
