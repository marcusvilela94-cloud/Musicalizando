import { auctionMode } from "./auction";
import { classicMode } from "./classic";
import { continueMode } from "./continue";
import { lyricsMode } from "./lyrics";
import { obraMode } from "./obra";
import { quizChoiceMode, quizOpenMode } from "./quiz";
import type { ModeDef } from "./types";

/** Registro de modos. Para um modo novo: criar src/modes/<id>/, registrar aqui e no banco (npl_clean_settings). */
export const MODES: Record<string, ModeDef> = {
  [classicMode.id]: classicMode,
  [auctionMode.id]: auctionMode,
  [lyricsMode.id]: lyricsMode,
  [continueMode.id]: continueMode,
  [quizOpenMode.id]: quizOpenMode,
  [quizChoiceMode.id]: quizChoiceMode,
  [obraMode.id]: obraMode,
};

export const getMode = (id: string | null | undefined): ModeDef => MODES[id ?? ""] ?? classicMode;
