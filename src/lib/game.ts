import type { Attempt, RoomState, Round, Team } from "./types";

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
