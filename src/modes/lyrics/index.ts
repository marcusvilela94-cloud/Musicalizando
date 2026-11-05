import type { ModeDef } from "../types";
import { LyricsPresenterView } from "./LyricsView";
import { LYRICS_STAGES } from "./stages";

/** Sem som durante a rodada (a prévia só toca na revelação). */
function SilentEngine() {
  return null;
}

/**
 * Só pela letra: a TV mostra trechos da letra (título e artista viram "___"),
 * um por vez, no "Próximo verso". O resto é o clássico: EU SEI!, partes,
 * bloqueio, revelação. Quanto menos versos, mais pontos.
 */
export const lyricsMode: ModeDef = {
  id: "lyrics",
  label: "Só pela letra",
  icon: "📝",
  description: "Trechos da letra, um por vez: quanto menos versos, mais pontos.",
  stages: LYRICS_STAGES,
  pickOffsets: () => [],
  TvEngine: SilentEngine,
  PresenterRoundView: LyricsPresenterView,
};
