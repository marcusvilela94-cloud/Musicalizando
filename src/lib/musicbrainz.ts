// MusicBrainz: ano ORIGINAL de uma gravação (o Deezer costuma ter só a data
// do relançamento digital). SÓ roda no servidor (rota /api/deezer/meta).
// Regras da API: no máximo 1 requisição por segundo e um User-Agent que
// identifique o app — https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting
import "server-only";

const API = "https://musicbrainz.org/ws/2";
const USER_AGENT = "Musicalizando/1.0 (https://github.com/marcusvilela94-cloud/Musicalizando)";
const MIN_GAP_MS = 1100;

export type MbRecording = {
  title: string;
  disambiguation?: string;
  video?: boolean | null;
  "first-release-date"?: string;
  "artist-credit"?: { name: string; artist?: { name?: string } }[];
};

// fila: uma requisição por vez, com 1,1 s entre elas
let queue: Promise<unknown> = Promise.resolve();
let last = 0;

function mb<T>(path: string): Promise<T | null> {
  const run = async (): Promise<T | null> => {
    const wait = last + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    try {
      const res = await fetch(`${API}${path}${path.includes("?") ? "&" : "?"}fmt=json`, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(6000),
      });
      return res.ok ? ((await res.json()) as T) : null;
    } catch {
      return null;
    }
  };
  const p = queue.then(run, run);
  queue = p.catch(() => null);
  return p;
}

/** Gravações com este ISRC (a faixa exata que toca; remasters costumam apontar para a original). */
export async function recordingsByIsrc(isrc: string): Promise<MbRecording[]> {
  if (!/^[A-Z0-9]{12}$/i.test(isrc)) return [];
  const r = await mb<{ recordings?: MbRecording[] }>(`/isrc/${encodeURIComponent(isrc)}`);
  return r?.recordings ?? [];
}

/** Busca gravações pelo título e artista (até 100 resultados). */
export async function searchRecordings(title: string, artist: string): Promise<MbRecording[]> {
  const clean = (s: string) => s.replace(/["\\]/g, " ").trim();
  if (!clean(title) || !clean(artist)) return [];
  const q = `recording:"${clean(title)}" AND artist:"${clean(artist)}"`;
  const r = await mb<{ recordings?: MbRecording[] }>(`/recording?query=${encodeURIComponent(q)}&limit=100`);
  return r?.recordings ?? [];
}

/** Ano de "first-release-date" ("1975-11-21" -> 1975). */
export function mbYear(r: MbRecording) {
  const y = Number((r["first-release-date"] ?? "").slice(0, 4));
  return y >= 1900 && y <= new Date().getFullYear() + 1 ? y : null;
}
