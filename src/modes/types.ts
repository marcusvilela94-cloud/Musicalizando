import type { ComponentType } from "react";
import type { PhoneCtx } from "@/components/phone/PhoneApp";
import type { AudioManager } from "@/lib/audio";
import type { Attempt, ModeId, RoomState, Round } from "@/lib/types";

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

/** Tela da rodada na TV enquanto a música está em jogo (playing / answering / doubt). */
export type TvRoundViewProps = { state: RoomState; round: Round; attempt?: Attempt; now: number; clipPlaying: boolean };

/** Tela da rodada no celular do jogador enquanto a música está em jogo. */
export type PhoneRoundViewProps = { state: RoomState; ctx: PhoneCtx; round: Round; now: number; onFeedback: (m: string) => void };

/** Painel compacto da rodada no celular do apresentador. */
export type PresenterRoundViewProps = { state: RoomState; round: Round; now: number };

/**
 * Definição de um modo de jogo. A base (salas, times, respostas, placar) é
 * comum; cada modo define estágios/pontos, como a rodada é tocada e, se
 * quiser, as próprias telas da rodada (senão valem as do clássico).
 */
export type ModeDef = {
  id: ModeId;
  label: string;
  description: string;
  stages: StageDef[];
  /** sorteia o ponto de início de cada trecho (guardado na rodada) */
  pickOffsets: (durationSec: number) => number[];
  /** componente sem UI que toca os trechos quando o dono manda */
  TvEngine: ComponentType<TvEngineProps>;
  TvRoundView?: ComponentType<TvRoundViewProps>;
  PhoneRoundView?: ComponentType<PhoneRoundViewProps>;
  PresenterRoundView?: ComponentType<PresenterRoundViewProps>;
};
