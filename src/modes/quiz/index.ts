import type { ModeDef } from "../types";
import { QUIZ_STAGES } from "./logic";
import { QuizTvEngine } from "./QuizTvEngine";
import { QuizChoicePhone, QuizChoiceTv, QuizPresenterView } from "./QuizViews";

/**
 * Quiz no botão (quiz aberto): a prévia toca ao fundo e a TV mostra uma pergunta sobre a
 * música (ano, álbum, quem canta…) ou uma curiosidade. Quem souber aperta
 * EU SEI! e responde (falada ou digitada), com as regras do clássico. Vale 100.
 */
export const quizOpenMode: ModeDef = {
  id: "quiz_open",
  label: "Quiz no botão",
  icon: "❓",
  description: "Uma pergunta sobre a música: quem souber aperta EU SEI! e responde.",
  stages: QUIZ_STAGES,
  pickOffsets: () => [],
  TvEngine: QuizTvEngine,
  PresenterRoundView: QuizPresenterView,
};

/**
 * Quiz de alternativas (estilo Kahoot): pergunta + 4 alternativas na TV;
 * todos os times respondem ao mesmo tempo pelo celular, no "Tempo de resposta". Acerto vale
 * de 100 (na hora) a 50 (no último segundo).
 */
export const quizChoiceMode: ModeDef = {
  id: "quiz_choice",
  label: "Quiz de alternativas",
  icon: "🅰️",
  description: "Pergunta com 4 alternativas: todos respondem ao mesmo tempo. Quanto mais rápido, mais pontos.",
  stages: QUIZ_STAGES,
  pickOffsets: () => [],
  TvEngine: QuizTvEngine,
  TvRoundView: QuizChoiceTv,
  PhoneRoundView: QuizChoicePhone,
  PresenterRoundView: QuizPresenterView,
};
