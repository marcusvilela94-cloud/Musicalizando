import type { ComponentType } from "react";
import type { AudioManager } from "@/lib/audio";
import type { Round } from "@/lib/types";

export type StageDef = { seconds: number; points: number };

/** Props do "motor" de um modo na tela principal (controla som e relógio da rodada). */
export type TvEngineProps = {
  code: string;
  owner: string;
  round: Round;
  paused: boolean;
  attemptCount: number;
  buffer: AudioBuffer | null;
  audio: AudioManager;
};

/**
 * Definição de um modo de jogo. A base (salas, times, botão, respostas,
 * placar) é comum; cada modo define estágios/pontos e como a rodada é tocada.
 * Fase 2: letra, quiz, instrumentos entram aqui sem mexer na base.
 */
export type ModeDef = {
  id: string;
  label: string;
  description: string;
  stages: StageDef[];
  /** componente sem UI que toca a rodada e chama npl_advance_stage */
  TvEngine: ComponentType<TvEngineProps>;
};
