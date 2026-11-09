import { buildQuiz, type QuizRequest } from "@/lib/quiz";

// POST /api/game/quiz { items, pool, sources, curiosities, recent } -> uma pergunta por rodada de quiz.
// As respostas vão para npl_tracks (oculto) pelo npl_start_match; a TV e os celulares não leem.

// o ano corrigido consulta o MusicBrainz (1 pedido por segundo): pode levar alguns segundos
export const maxDuration = 300;
export async function POST(request: Request) {
  let body: Partial<QuizRequest>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "JSON inválido" }, { status: 400 });
  }
  const okTrack = (t: unknown): t is QuizRequest["pool"][number] =>
    !!t && typeof t === "object" && Number.isFinite(Number((t as { deezer_id?: unknown }).deezer_id)) && typeof (t as { title?: unknown }).title === "string";
  const items = (Array.isArray(body.items) ? body.items : [])
    .filter((t) => okTrack(t) && (t.format === "open" || t.format === "choice"))
    .slice(0, 110);
  const pool = (Array.isArray(body.pool) ? body.pool : []).filter(okTrack).slice(0, 160);
  const sources = (Array.isArray(body.sources) ? body.sources : []).slice(0, 12);
  const recent = (Array.isArray(body.recent) ? body.recent : []).filter((x) => typeof x === "string").slice(0, 80);
  if (!items.length) return Response.json({ results: [] });
  try {
    return Response.json(await buildQuiz({ items, pool, sources, curiosities: body.curiosities !== false, recent, versionFilter: body.versionFilter !== false }));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
