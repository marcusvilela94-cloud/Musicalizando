import { buildTrackList } from "@/lib/deezer";
import type { MusicSource } from "@/lib/types";

// POST /api/deezer/pool { sources, versionFilter } -> até 150 músicas das fontes (sem letra).
// Instrumentos: a configuração confere quantas já estão separadas no cache e pede as que faltam.
export const maxDuration = 60;
const MAX = 150;
export async function POST(request: Request) {
  let body: { sources?: MusicSource[]; versionFilter?: boolean };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "JSON inválido" }, { status: 400 });
  }
  const sources = (Array.isArray(body.sources) ? body.sources : [])
    .filter((s) => s && ["preset", "playlist", "artist"].includes(s.type) && /^[\w-]+$/.test(String(s.id)))
    .slice(0, 12);
  if (sources.length === 0) return Response.json({ error: "Escolha pelo menos uma fonte de músicas" }, { status: 400 });
  try {
    const { tracks, warnings } = await buildTrackList(sources, MAX, body.versionFilter !== false, 0);
    return Response.json({ tracks, warnings: warnings.filter((w) => !w.startsWith("Só encontrei")) });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
