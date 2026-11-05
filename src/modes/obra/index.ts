import type { ModeDef } from "../types";
import { ClassicTvEngine } from "../classic/ClassicTvEngine";
import { pickStageOffsets } from "../classic/offsets";
import { CLASSIC_STAGES } from "../classic/stages";

/**
 * "Qual é a obra?": joga como o Clássico (trechos crescentes, EU SEI!,
 * bloqueio, penalidade, Formato da vez), mas a resposta é a OBRA (filme,
 * anime ou novela). As músicas vêm dos pacotes temáticos ligados.
 */
export const obraMode: ModeDef = {
  id: "obra",
  label: "Qual é a obra?",
  icon: "🎭",
  description: "Trechos de trilhas e aberturas: acerte o filme, o anime ou a novela.",
  stages: CLASSIC_STAGES,
  pickOffsets: (duration) => pickStageOffsets(CLASSIC_STAGES, duration),
  TvEngine: ClassicTvEngine,
};
