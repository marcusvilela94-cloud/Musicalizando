import { getMode } from "@/modes";
import type { Attempt, RoomState, Round, Team } from "./types";

/** Partes que ainda faltam descobrir nesta rodada. */
export function missingParts(s: RoomState, r: Round) {
  const artist = s.room.settings.scoring === "artist_title" && !r.found?.artist;
  const title = !r.found?.title;
  return { artist, title };
}

/** Pontos do estágio atual (= valor da música). Artista vale metade. */
export const stagePoints = (r: Round) => getMode(r.mode).stages[Math.max(0, r.stage - 1)]?.points ?? 0;
export const artistPoints = (pts: number) => Math.round(pts * 0.5);

/** "artista", "música", "artista e música" ou "" (o que a tentativa acertou). */
export function attemptParts(a: Attempt) {
  const parts = [a.artist_result === "ok" && "artista", a.title_result === "ok" && "música"].filter(Boolean);
  return parts.join(" e ");
}

/** Milissegundos até o time ser liberado do bloqueio (0 = pode apertar). Relógio do servidor. */
export function lockLeftMs(r: Round | null, teamId: string | null | undefined, now: number) {
  const until = r && teamId ? r.locks?.[teamId] : undefined;
  return until ? Math.max(0, Date.parse(until) - now) : 0;
}

/** Times bloqueados agora, com o tempo restante. */
export function lockedTeams(s: RoomState, r: Round | null, now: number) {
  return s.teams.map((t) => ({ team: t, ms: lockLeftMs(r, t.id, now) })).filter((x) => x.ms > 0);
}

export const isHostStyle = (s: RoomState) => s.room.settings.roomStyle === "host";

/** Última decisão (acerto/erro) desta rodada, se aconteceu há pouco — para animações. */
export function recentDecision(s: RoomState, r: Round | null, now: number, withinMs = 3500) {
  if (!r) return undefined;
  const decided = s.attempts
    .filter((a) => a.round_id === r.id && a.kind === "turn" && a.decided_at && ["correct", "wrong", "timeout"].includes(a.status))
    .sort((a, b) => Date.parse(b.decided_at!) - Date.parse(a.decided_at!))[0];
  if (!decided || now - Date.parse(decided.decided_at!) > withinMs) return undefined;
  return decided;
}

export const currentRound = (s: RoomState): Round | null =>
  s.rounds.find((r) => r.round_no === s.room.round_no) ?? null;

export const teamById = (s: RoomState, id: string | null | undefined): Team | undefined =>
  id ? s.teams.find((t) => t.id === id) : undefined;

export const currentAttempt = (s: RoomState, r: Round | null): Attempt | undefined =>
  r?.current_attempt_id ? s.attempts.find((a) => a.id === r.current_attempt_id) : undefined;

export const roundAttempts = (s: RoomState, r: Round | null) =>
  r ? s.attempts.filter((a) => a.round_id === r.id && a.kind === "turn" && a.status !== "cancelled") : [];

/** Toques atrasados de uma tentativa: "Verde apertou 0,3s depois". */
export function lateTaps(s: RoomState, a: Attempt | undefined) {
  if (!a) return [];
  const t0 = Date.parse(a.created_at);
  return s.attempts
    .filter((x) => x.kind === "late" && x.parent_id === a.id)
    .map((x) => ({ team: teamById(s, x.team_id), ms: Date.parse(x.created_at) - t0 }))
    .sort((x, y) => x.ms - y.ms);
}

export const formatSeconds = (ms: number) =>
  (ms / 1000).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** Ranking com empates dividindo a posição. */
export function ranking(teams: Team[]) {
  const sorted = [...teams].sort((a, b) => b.score - a.score || a.idx - b.idx);
  return sorted.map((t) => ({ team: t, pos: sorted.findIndex((x) => x.score === t.score) + 1 }));
}

/** Pontos ganhos/perdidos por time numa rodada. */
export function roundDelta(s: RoomState, r: Round | null) {
  const d = new Map<string, number>();
  if (!r) return d;
  for (const a of s.attempts) {
    if (a.round_id === r.id && a.team_id && a.points) d.set(a.team_id, (d.get(a.team_id) ?? 0) + a.points);
  }
  return d;
}

/** Estatísticas da partida para a tela final. */
export function matchStats(s: RoomState) {
  const correct = s.attempts.filter((a) => a.kind === "turn" && a.status === "correct");
  const fastest = [...correct].sort((a, b) => a.stage - b.stage || a.ms_into_stage - b.ms_into_stage)[0];
  const steals = new Map<string, number>();
  for (const a of correct) if (a.steal && a.team_id) steals.set(a.team_id, (steals.get(a.team_id) ?? 0) + 1);
  const topSteal = [...steals.entries()].sort((a, b) => b[1] - a[1])[0];
  const nobody = s.rounds.filter((r) => r.reveal && !r.winner_team_id);
  return {
    fastest: fastest
      ? { team: teamById(s, fastest.team_id), round: s.rounds.find((r) => r.id === fastest.round_id), attempt: fastest }
      : null,
    topSteal: topSteal ? { team: teamById(s, topSteal[0]), count: topSteal[1] } : null,
    nobody,
  };
}
