import type { ModeDef } from "../types";
import { ClassicTvEngine } from "./ClassicTvEngine";
import { CLASSIC_STAGES } from "./stages";

export const classicMode: ModeDef = {
  id: "classic",
  label: "Clássico",
  description: "Trechos crescentes da música: quanto antes acertar, mais pontos.",
  stages: CLASSIC_STAGES,
  TvEngine: ClassicTvEngine,
};
