import type { QuizState, Round } from "@/lib/types";

/** "Qual é a obra?": o que todos veem (pacote; a obra e o tipo só na revelação). */
export function obraOf(r: Round | null | undefined): QuizState | null {
  const q = r?.mode === "obra" ? r.quiz : null;
  return q && q.kind === "obra" ? (q as QuizState) : null;
}

export const isObraMode = (m: string | null | undefined) => m === "obra";

/** Pacote como dica do tipo de obra. */
export const OBRA_KIND: Record<string, string> = { cinema: "um filme", anime: "um anime", novelas: "uma novela" };
/** Campo de resposta no celular. */
export const OBRA_ASK: Record<string, string> = { cinema: "Nome do filme", anime: "Nome do anime", novelas: "Nome da novela" };
