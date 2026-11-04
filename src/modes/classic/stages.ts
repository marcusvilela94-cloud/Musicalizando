import type { StageDef } from "../types";

/** Trecho crescente: 1s, 2s, 4s, 8s, 15s, 30s. Pontos espelhados em npl_stage_points(). */
export const CLASSIC_STAGES: StageDef[] = [
  { seconds: 1, points: 100 },
  { seconds: 2, points: 80 },
  { seconds: 4, points: 60 },
  { seconds: 8, points: 40 },
  { seconds: 15, points: 25 },
  { seconds: 30, points: 10 },
];
