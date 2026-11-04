import type { ComponentType } from "react";
import type { AudioManager } from "@/lib/audio";
import type { Round } from "@/lib/types";

export type StageDef = { seconds: number; points: number };

/** Props do "motor" de um modo na tela principal (só toca o som; quem comanda é o celular do dono). */
export type TvEngineProps = {
  round: Round;
  paused: boolean;
  buffer: AudioBuffer | null;
  audio: AudioManager;
  serverNow: () => number;
  /** avisa a tela se um trecho está tocando agora (para o visual) */
  onPlayingChange: (playing: boolean) => void;
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
  /** sorteia o ponto de início de cada trecho (guardado na rodada) */
  pickOffsets: (durationSec: number) => number[];
  /** componente sem UI que toca os trechos quando o dono manda */
  TvEngine: ComponentType<TvEngineProps>;
};
