import { getTrack } from "@/lib/deezer";
import { analyzeTrack } from "@/lib/sync";

// GET /api/lab/sync/{deezerId} -> linhas da letra com o segundo em que começam na prévia.
// Página de teste (/lab/sync). A transcrição usa o Groq (GROQ_API_KEY), só aqui no servidor.
export const maxDuration = 60;

export async function GET(_request: Request, ctx: RouteContext<"/api/lab/sync/[id]">) {
  const { id } = await ctx.params;
  if (!/^\d+$/.test(id)) return Response.json({ error: "ID inválido" }, { status: 400 });
  try {
    const t = await getTrack(id);
    if (!t.preview) return Response.json({ error: "Faixa sem prévia" }, { status: 404 });
    const r = await analyzeTrack({ preview: t.preview, titleShort: t.titleShort, artist: t.artist, duration: t.duration });
    return Response.json(
      { id: t.id, title: t.title, artist: t.artist, cover: t.cover, preview: t.preview, ...r },
      { headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } },
    );
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
