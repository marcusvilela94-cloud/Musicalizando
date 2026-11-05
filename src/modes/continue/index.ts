import type { ModeDef } from "../types";
import { ContinueTvEngine } from "./ContinueTvEngine";
import { ContinuePresenterView } from "./ContinueView";
import { CONTINUE_STAGES } from "./stages";

/**
 * Continuar a letra: a TV mostra música e artista, toca o trecho que termina
 * 0,3 s antes de uma linha e os times precisam cantar/digitar a próxima linha
 * (100 pontos). Na revelação a música segue até o fim: cantar junto.
 */
export const continueMode: ModeDef = {
  id: "continue",
  label: "Continuar a letra",
  icon: "🎤",
  description: "A música para antes de uma linha: quem continuar a letra leva os pontos.",
  stages: CONTINUE_STAGES,
  pickOffsets: () => [],
  TvEngine: ContinueTvEngine,
  PresenterRoundView: ContinuePresenterView,
};
