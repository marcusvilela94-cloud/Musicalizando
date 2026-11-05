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
