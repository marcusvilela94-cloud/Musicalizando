// Sem importar o registro de modos (src/modes): as telas dos modos usam este arquivo.
import { CLASSIC_STAGES } from "@/modes/classic/stages";
import { CONTINUE_STAGES } from "@/modes/continue/stages";
import { LYRICS_STAGES } from "@/modes/lyrics/stages";
import { AUCTION_POINTS, auctionOf } from "@/modes/auction/logic";
import { QUIZ_STAGES, isQuizMode } from "@/modes/quiz/logic";
import type { Attempt, RoomState, Round, Team, TiebreakState, TurnState } from "./types";

/** "Um time por vez": de quem é a vez (null no "Quem sabe primeiro"). */
export function turnOf(r: Round | null | undefined): TurnState | null {
  const t = r?.turn;
  return t && typeof t.team === "string" && Array.isArray(t.order) ? (t as TurnState) : null;
}

/** A vez do time está aberta (a música/pista segue tocando enquanto ele responde). */
export const turnOpen = (r: Round | null | undefined) => !!turnOf(r) && r!.status === "answering";

/** Estado do desempate (null fora da morte súbita). */
export function tiebreakOf(r: Round | null | undefined): TiebreakState | null {
  const t = r?.tiebreak;
  return t && Array.isArray(t.teams) ? (t as TiebreakState) : null;
}

/** Times que ainda estão no páreo nesta música de desempate. */
export const tiebreakLeft = (t: TiebreakState) => t.teams.filter((id) => !(t.out ?? []).includes(id));

/** Quem venceu o desempate nesta rodada: acertou a música ou sobrou sozinho. */
export const tiebreakDecider = (r: Round | null | undefined) => {
  const t = tiebreakOf(r);
  return t ? (r!.winner_team_id ?? t.survivor ?? null) : null;
};

/** Vencedor da morte súbita na partida (null se não houve ou ficou empatado). */
export function suddenDeathWinner(s: RoomState): Team | null {
  const r = [...s.rounds].reverse().find((x) => tiebreakDecider(x));
  return r ? teamById(s, tiebreakDecider(r)) ?? null : null;
}

/**
 * Partes que ainda faltam descobrir nesta rodada (= o que o time pode responder).
 * Leilão: dica "artist" -> só a música; dica "genre" -> só o artista.
 */
export function missingParts(s: RoomState, r: Round) {
  if (tiebreakOf(r)) return { artist: false, title: !r.found?.title }; // desempate: só a música
  if (r.mode === "continue") return { artist: false, title: !r.found?.title }; // continuar a letra: só a linha
  if (isQuizMode(r.mode) || r.mode === "obra") return { artist: false, title: !r.found?.title }; // quiz / obra: só a resposta
  if (r.mode === "auction") {
    const hint = r.auction?.hint;
    return { artist: hint === "genre" && !r.found?.artist, title: hint === "artist" && !r.found?.title };
  }
  const artist = s.room.settings.scoring === "artist_title" && !r.found?.artist;
  const title = !r.found?.title;
  return { artist, title };
}

/** Pontos do estágio atual (= valor da música). Artista vale metade. Leilão: 100 fixos. */
export const stagePoints = (r: Round) =>
  tiebreakOf(r)
    ? 0
    : r.mode === "auction"
      ? AUCTION_POINTS
      : // um time por vez: depois de passar a vez, vale metade
        Math.round(
          ((r.mode === "lyrics" ? LYRICS_STAGES : r.mode === "continue" ? CONTINUE_STAGES : isQuizMode(r.mode) ? QUIZ_STAGES : CLASSIC_STAGES)[
            Math.max(0, r.stage - 1)
          ]?.points ?? 0) * (turnOf(r)?.factor ?? 1),
        );
export const artistPoints = (pts: number) => Math.round(pts * 0.5);

/** Quanto vale acertar cada parte agora. */
export function partPoints(r: Round, part: "artist" | "title") {
  if (tiebreakOf(r)) return 0; // desempate não vale pontos
  if (r.mode === "auction") return AUCTION_POINTS;
  const pts = stagePoints(r);
  return part === "artist" ? artistPoints(pts) : pts;
}

/**
 * "artista", "música", "artista e música" ou "" (o que a tentativa acertou).
 * Nos modos em que só vale uma coisa (quiz, continuar a letra) é "".
 */
export function attemptParts(a: Attempt, mode?: string | null) {
  if (mode && (isQuizMode(mode) || mode === "continue" || mode === "obra")) return "";
  const parts = [a.artist_result === "ok" && "artista", a.title_result === "ok" && "música"].filter(Boolean);
  return parts.join(" e ");
}

/**
 * Bloqueio do time agora (relógio do servidor): null = pode apertar;
 * waiting = errou e aguarda a música voltar a tocar; ms = tempo que falta.
 */
export function lockInfo(r: Round | null, teamId: string | null | undefined, now: number) {
  const l = r && teamId ? r.locks?.[teamId] : undefined;
  if (!l || typeof l !== "object") return null;
  if (!l.until) return { waiting: true, ms: (l.secs ?? 0) * 1000 };
  const ms = Date.parse(l.until) - now;
  return ms > 0 ? { waiting: false, ms } : null;
}

/** Times bloqueados agora, com o tempo restante (ou aguardando a música). */
export function lockedTeams(s: RoomState, r: Round | null, now: number) {
  return s.teams.flatMap((t) => {
    const l = lockInfo(r, t.id, now);
    return l ? [{ team: t, ...l }] : [];
  });
}

/** Texto curto do bloqueio: "aguardando a música" (modo letra: "o próximo verso") ou "12s". */
export const lockLabel = (l: { waiting: boolean; ms: number }, r?: Round | null) =>
  l.waiting ? (r?.mode === "lyrics" ? "aguardando o próximo verso" : r?.mode === "continue" ? "aguardando tocar de novo" : "aguardando a música") : `${Math.ceil(l.ms / 1000)}s`;

/** Todos os artistas creditados, principal primeiro: "Major Lazer, Anitta, Pabllo Vittar". */
export function artistCredits(r: { artist: string; artists?: string[] | null }) {
  const all = [r.artist, ...(r.artists ?? [])].map((a) => a?.trim()).filter(Boolean) as string[];
  const seen = new Set<string>();
  return all.filter((a) => (seen.has(a.toLowerCase()) ? false : (seen.add(a.toLowerCase()), true))).join(", ");
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

/**
 * Ranking final: igual ao ranking, mas quem venceu a morte súbita fica
 * sozinho em 1º e os outros empatados com ele passam a 2º.
 */
export function finalRanking(s: RoomState) {
  const base = ranking(s.teams).map((x) => ({ ...x, wonTiebreak: false }));
  const w = suddenDeathWinner(s);
  const top = base[0]?.team.score;
  if (!w || w.score !== top) return base;
  return base
    .map((x) => (x.team.id === w.id ? { ...x, pos: 1, wonTiebreak: true } : x.pos === 1 ? { ...x, pos: 2 } : x))
    .sort((a, b) => a.pos - b.pos || a.team.idx - b.team.idx);
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
  // as músicas de desempate não entram nas estatísticas
  const rounds = s.rounds.filter((r) => !tiebreakOf(r));
  const roundOf = (a: Attempt) => rounds.find((r) => r.id === a.round_id);
  const correct = s.attempts.filter((a) => a.kind === "turn" && a.status === "correct" && roundOf(a));
  const classicCorrect = correct.filter((a) => roundOf(a)?.mode === "classic");
  const fastest = [...classicCorrect].sort((a, b) => a.stage - b.stage || a.ms_into_stage - b.ms_into_stage)[0];
  const steals = new Map<string, number>();
  for (const a of classicCorrect) if (a.steal && a.team_id) steals.set(a.team_id, (steals.get(a.team_id) ?? 0) + 1);
  const topSteal = [...steals.entries()].sort((a, b) => b[1] - a[1])[0];
  const nobody = rounds.filter((r) => r.reveal && !r.winner_team_id);

  // Leilão: "Lance mais ousado" (menor lance que acertou; attempt.stage = segundos do lance)
  // e "Mais leilões vencidos" (quem ficou com o menor lance).
  const auctionRounds = rounds.filter((r) => auctionOf(r));
  const boldest = correct
    .filter((a) => roundOf(a)?.mode === "auction")
    .sort((a, b) => a.stage - b.stage || Date.parse(a.created_at) - Date.parse(b.created_at))[0];
  const wins = new Map<string, number>();
  for (const r of auctionRounds) {
    const w = auctionOf(r)?.winner;
    if (w) wins.set(w, (wins.get(w) ?? 0) + 1);
  }
  const topWins = [...wins.entries()].sort((a, b) => b[1] - a[1]);
  return {
    fastest: fastest ? { team: teamById(s, fastest.team_id), round: roundOf(fastest), attempt: fastest } : null,
    topSteal: topSteal ? { team: teamById(s, topSteal[0]), count: topSteal[1] } : null,
    nobody,
    hadClassic: rounds.some((r) => r.mode === "classic"),
    hadAuction: auctionRounds.length > 0,
    boldest: boldest ? { team: teamById(s, boldest.team_id), round: roundOf(boldest), secs: boldest.stage } : null,
    topAuction: topWins[0]
      ? {
          teams: topWins.filter(([, n]) => n === topWins[0][1]).map(([id]) => teamById(s, id)).filter(Boolean) as Team[],
          count: topWins[0][1],
        }
      : null,
  };
}
