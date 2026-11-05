import type { ModeDef } from "../types";
import { QuizTvEngine } from "../quiz/QuizTvEngine";
import { OBRA_STAGES } from "./logic";

/**
 * "Qual é a obra?": EU SEI!, bloqueio, penalidade e Formato da vez como no
 * Clássico, mas a prévia toca INTEIRA de uma vez ("Tocar"/"Repetir", sem
 * trechos crescentes) e a resposta é a OBRA (filme, anime ou novela). As
 * músicas vêm dos pacotes temáticos ligados.
 */
export const obraMode: ModeDef = {
  id: "obra",
  label: "Qual é a obra?",
  icon: "🎭",
  description: "Trilhas e aberturas tocando inteiras: acerte o filme, o anime ou a novela.",
  stages: OBRA_STAGES,
  pickOffsets: () => [],
  TvEngine: QuizTvEngine,
};
