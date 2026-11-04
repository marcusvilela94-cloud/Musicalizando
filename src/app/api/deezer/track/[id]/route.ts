import { getTrack } from "@/lib/deezer";

// GET /api/deezer/track/{id} -> link da prévia ATUALIZADO (ele expira) + artistas
export async function GET(_request: Request, ctx: RouteContext<"/api/deezer/track/[id]">) {
  const { id } = await ctx.params;
  if (!/^\d+$/.test(id)) return Response.json({ error: "ID inválido" }, { status: 400 });
  try {
    const t = await getTrack(id);
    if (!t.preview) return Response.json({ error: "Faixa sem prévia" }, { status: 404 });
    return Response.json(t, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
