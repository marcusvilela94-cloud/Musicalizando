import type { AuctionState, Round } from "@/lib/types";

/** Regras do Leilão (espelhadas em supabase/migrations/..._npl_leilao.sql). */
export const AUCTION_START_SECS = 20; // o leilão começa em 20 s
export const AUCTION_TURN_SECS = 15; // cada turno de lance
export const AUCTION_POINTS = 100; // acerto vale 100, independente do lance

export const isAuction = (r: Round | null | undefined) => r?.mode === "auction";

/** Estado do leilão (null fora do leilão ou antes de a rodada abrir). */
export function auctionOf(r: Round | null | undefined): AuctionState | null {
  const a = r?.mode === "auction" ? r.auction : null;
  return a && a.phase ? (a as AuctionState) : null;
}

/** Quem está na vez da prova (fila) e com quantos segundos. */
export function queueEntry(a: AuctionState | null) {
  return a && a.phase === "proving" ? a.queue[a.qidx] ?? null : null;
}

/** O trecho da posição atual já tocou? */
export const entryPlayed = (a: AuctionState | null) => !!a && a.played >= a.qidx;

/** Ainda ouvindo o trecho (relógio do servidor): play_at + lance. */
export function listening(r: Round, a: AuctionState | null, now: number) {
  const e = queueEntry(a);
  if (!e || !entryPlayed(a) || !r.play_at) return false;
  return now < Date.parse(r.play_at) + e.secs * 1000;
}

/** Última ação do leilão (para destacar o lance novo). */
export const lastAction = (a: AuctionState | null) => (a && a.log.length ? a.log[a.log.length - 1] : null);

/** "Acerte a MÚSICA" / "Acerte o ARTISTA". */
export const auctionGoal = (a: Pick<AuctionState, "hint">) => (a.hint === "artist" ? "a MÚSICA" : "o ARTISTA");
