import type { ContinueState, Round } from "@/lib/types";

/** Estado do "Continuar a letra" (null fora do modo ou antes de abrir). */
export function contOf(r: Round | null | undefined): ContinueState | null {
  const c = r?.mode === "continue" ? r.cont : null;
  return c && Array.isArray(c.lines) && c.hidden ? (c as ContinueState) : null;
}

/** O trecho tocado: do início da 1ª linha de contexto até 0,3 s antes da escondida. */
export function contClip(c: ContinueState) {
  const from = Math.max(0, Number(c.lines[0]?.start ?? 0));
  const to = Math.max(from + 0.5, Number(c.hidden.start) - 0.3);
  return { from, to };
}

/** Pausa antes da linha escondida. */
export const CONT_STOP_BEFORE = 0.3;

/** Duração da prévia do Deezer. */
export const PREVIEW_SECS = 30;
/** Tempo do efeito de acerto/erro antes de a música voltar na revelação. */
export const SING_LEAD_SECS = 1.5;

/** Até quando dura o "cantar junto" (relógio do servidor), ou null se não há. */
export function singUntil(r: Round | null | undefined): number | null {
  const c = contOf(r);
  if (!c?.reveal || !r?.revealed_at) return null;
  const from = Math.max(0, Number(c.reveal.start) - CONT_STOP_BEFORE);
  return Date.parse(r.revealed_at) + (SING_LEAD_SECS + PREVIEW_SECS - from) * 1000;
}

/** Ainda no "cantar junto"? (antes da tela de revelação normal) */
export function singing(r: Round | null | undefined, now: number) {
  const c = contOf(r);
  const until = singUntil(r);
  return !!r && r.status === "revealed" && !!c?.reveal && !c.sung && until !== null && now < until;
}

/** Quando o trecho tocado para (relógio do servidor), ou null se ainda não tocou. */
export function contStopAt(r: Round | null | undefined): number | null {
  const c = contOf(r);
  if (!c || !r?.play_at || r.played_stage < 1) return null;
  const { from, to } = contClip(c);
  return Date.parse(r.play_at) + (to - from) * 1000;
}

/**
 * EU SEI! / resposta liberados? Só depois que a música para antes da linha
 * escondida (o servidor confere o mesmo; aqui com meio segundo de folga
 * para o som da TV acabar de verdade).
 */
export function contCanAnswer(r: Round | null | undefined, now: number) {
  const stop = contStopAt(r);
  return stop !== null && now >= stop + 500;
}
