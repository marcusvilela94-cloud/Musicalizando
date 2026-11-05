import { getAuctionMeta } from "@/lib/deezer";

// GET /api/deezer/meta/{id} -> gênero + ano original da música (dica do Leilão)
export async function GET(_request: Request, ctx: RouteContext<"/api/deezer/meta/[id]">) {
  const { id } = await ctx.params;
  if (!/^\d+$/.test(id)) return Response.json({ error: "ID inválido" }, { status: 400 });
  try {
    return Response.json(await getAuctionMeta(id), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
