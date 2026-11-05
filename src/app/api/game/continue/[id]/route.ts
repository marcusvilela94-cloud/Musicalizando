import { getTrack } from "@/lib/deezer";
import { prepareContinue } from "@/lib/sync";

// GET /api/game/continue/{deezerId} -> serve para "Continuar a letra"? + plano (linhas e tempos).
// Chamada na preparação da partida, uma música por vez (o Groq aceita 20 pedidos/minuto).
export const maxDuration = 60;

export async function GET(_request: Request, ctx: RouteContext<"/api/game/continue/[id]">) {
  const { id } = await ctx.params;
  if (!/^\d+$/.test(id)) return Response.json({ error: "ID inválido" }, { status: 400 });
  try {
    const t = await getTrack(id);
    if (!t.preview) return Response.json({ ok: false, reason: "sem prévia" });
    const v = await prepareContinue({ preview: t.preview, titleShort: t.titleShort, artist: t.artist, duration: t.duration });
    return Response.json(v, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json({ ok: false, reason: (e as Error).message }, { status: 200 });
  }
}
