import type { QuizKind, QuizState, Round } from "@/lib/types";
import type { StageDef } from "../types";

type StageDefLike = StageDef;

/** Estado da pergunta (null fora dos quizzes ou antes de a rodada abrir). */
export function quizOf(r: Round | null | undefined): QuizState | null {
  const q = r && (r.mode === "quiz_open" || r.mode === "quiz_choice") ? r.quiz : null;
  return q && typeof q.q === "string" ? (q as QuizState) : null;
}

export const isQuizMode = (m: string | null | undefined) => m === "quiz_open" || m === "quiz_choice";

/** Um só estágio: a pergunta vale 100 (o ano errado por 1 vale 50). */
export const QUIZ_STAGES: StageDefLike[] = [{ seconds: 30, points: 100 }];

/** Cores e formas das alternativas (A, B, C, D). */
export const CHOICE_STYLE = [
  { letter: "A", color: "#e21b3c", shape: "▲" },
  { letter: "B", color: "#1368ce", shape: "◆" },
  { letter: "C", color: "#d89e00", shape: "●" },
  { letter: "D", color: "#26890c", shape: "■" },
] as const;

export const QUIZ_KIND_LABEL: Record<QuizKind, string> = {
  year: "📅 Ano",
  album: "💿 Álbum",
  artist: "🎤 Quem canta",
  feat: "🤝 Participação",
  top: "🔥 Mais ouvida",
  intruder: "🕵️ Intrusa",
  older: "⏳ Qual veio primeiro",
  cover: "🖼️ Capa",
  complete: "✍️ Complete o título",
  trivia: "💡 Curiosidade",
};

/** Desfoque da capa (px): começa forte e fica nítida em ~20 s. */
export function coverBlur(startedAt: string | null | undefined, now: number) {
  if (!startedAt) return 28;
  const t = Math.max(0, (now - Date.parse(startedAt)) / 1000);
  return Math.max(0, Math.round(28 * (1 - t / 20)));
}
