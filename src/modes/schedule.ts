import type { ModeId, RoomSettings } from "@/lib/types";

/** Ordem da lista na configuração (e dos blocos). Modo novo: acrescentar aqui. */
export const MODE_LIST: ModeId[] = ["classic", "auction", "lyrics"];

export type ModeOrder = "alternate" | "random" | "blocks";

/** Modos ligados, na ordem da lista (pelo menos um). */
export function enabledModes(s: Pick<RoomSettings, "mode" | "modePool" | "modeSelection">): ModeId[] {
  const pool = s.modeSelection === "random" && s.modePool?.length ? s.modePool : [s.mode];
  const on = MODE_LIST.filter((m) => pool.includes(m));
  return on.length ? on : ["classic"];
}

/**
 * Modo de cada rodada (1..n):
 *  - alternate: revezam em ordem fixa (o mais igual possível);
 *  - random: cada rodada sorteia um dos ligados;
 *  - blocks: todas do 1º modo, depois do 2º… dividindo igualmente.
 */
export function modeSchedule(modes: ModeId[], order: ModeOrder, n: number): ModeId[] {
  if (modes.length <= 1) return Array.from({ length: n }, () => modes[0] ?? "classic");
  if (order === "random") return Array.from({ length: n }, () => modes[Math.floor(Math.random() * modes.length)]);
  if (order === "blocks") {
    const base = Math.floor(n / modes.length);
    const extra = n % modes.length;
    return modes.flatMap((m, i) => Array.from({ length: base + (i < extra ? 1 : 0) }, () => m));
  }
  return Array.from({ length: n }, (_, i) => modes[i % modes.length]);
}
