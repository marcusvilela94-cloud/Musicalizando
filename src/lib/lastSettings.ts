"use client";
import type { RoomSettings } from "@/lib/types";

// Última configuração usada neste aparelho (a TV): a próxima sala começa com ela.
const KEY = "npl_last_settings";

export function saveLastSettings(s: RoomSettings) {
  try {
    // o estilo da sala é escolhido a cada vez
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { roomStyle, ...rest } = s;
    localStorage.setItem(KEY, JSON.stringify(rest));
  } catch {
    // sem localStorage (modo privado, cota…): segue sem memória
  }
}

export function loadLastSettings(): Partial<RoomSettings> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Partial<RoomSettings>) : {};
  } catch {
    return {};
  }
}
