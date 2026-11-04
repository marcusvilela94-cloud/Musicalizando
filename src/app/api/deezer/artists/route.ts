import { searchArtists } from "@/lib/deezer";

// GET /api/deezer/artists?q=nome -> artistas encontrados
export async function GET(request: Request) {
  const q = (new URL(request.url).searchParams.get("q") ?? "").trim().slice(0, 80);
  if (q.length < 2) return Response.json([]);
  try {
    return Response.json(await searchArtists(q));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
