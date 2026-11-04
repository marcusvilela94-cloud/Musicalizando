import { getPlaylistInfo, resolvePlaylistId } from "@/lib/deezer";

// GET /api/deezer/playlist?url=<link ou id> -> dados da playlist
export async function GET(request: Request) {
  const url = new URL(request.url).searchParams.get("url") ?? "";
  if (!url.trim()) return Response.json({ error: "Cole um link de playlist" }, { status: 400 });
  try {
    const id = await resolvePlaylistId(url);
    const info = await getPlaylistInfo(id);
    if (!info.nbTracks) return Response.json({ error: "Playlist vazia ou privada" }, { status: 404 });
    return Response.json(info);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
