import type { ModeDef } from "../types";
import { SINGLE_STAGES } from "./logic";
import { StemsTvEngine } from "./StemsTvEngine";

/**
 * Instrumentos: faixas separadas (Demucs, no cache do Supabase).
 *  - Camadas: bateria → + baixo → + guitarra → + voz, tocando juntas
 *    ("Próxima camada"); 100 / 75 / 50 / 20.
 *  - Um instrumento só: trechos de 5/15/30 s de uma faixa; 100 / 60 / 30.
 * Os pontos de cada estágio vêm da rodada (npl_rounds.stems.points).
 */
export const stemsMode: ModeDef = {
  id: "stems",
  label: "Instrumentos",
  icon: "🥁",
  description: "A música separada em instrumentos: adivinhe só pela bateria, pelo baixo…",
  stages: SINGLE_STAGES,
  pickOffsets: () => [],
  TvEngine: StemsTvEngine,
};
