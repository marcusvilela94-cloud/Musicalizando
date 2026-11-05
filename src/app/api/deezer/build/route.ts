import { buildTrackList } from "@/lib/deezer";
import type { MusicSource } from "@/lib/types";

// POST /api/deezer/build { sources, count, versionFilter } -> lista sorteada (só IDs e metadados).
// count pode passar das rodadas: as músicas a mais ficam de reserva para a morte súbita.
export async function POST(request: Request) {
  let body: { sources?: MusicSource[]; count?: number; versionFilter?: boolean };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "JSON inválido" }, { status: 400 });
  }
  const sources = (Array.isArray(body.sources) ? body.sources : [])
    .filter((s) => s && ["preset", "playlist", "artist"].includes(s.type) && /^[\w-]+$/.test(String(s.id)))
    .slice(0, 12);
  const count = Math.min(35, Math.max(5, Number(body.count) || 10));
  if (sources.length === 0) return Response.json({ error: "Escolha pelo menos uma fonte de músicas" }, { status: 400 });
  try {
    const result = await buildTrackList(sources, count, body.versionFilter !== false);
    if (result.tracks.length === 0) {
      return Response.json({ error: "Nenhuma música com prévia encontrada", warnings: result.warnings }, { status: 404 });
    }
    return Response.json(result);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
