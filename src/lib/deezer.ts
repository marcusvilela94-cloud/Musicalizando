// Acesso à API pública do Deezer. SÓ roda no servidor (rotas /api/deezer/*):
// o Deezer bloqueia chamadas diretas do navegador por CORS.
import "server-only";
import type { MusicSource, PickedTrack, TrackMeta } from "./types";

const API = "https://api.deezer.com";

/** Playlists prontas. IDs conferidos na API (GET /playlist/{id}). */
export const PRESETS: Record<string, { playlistId: string; label: string }> = {
  // "Top Brasil" — Deezer Charts, 100 faixas
  top_brasil: { playlistId: "1111141961", label: "Top Brasil" },
};

type DzArtist = { id: number; name: string; picture_medium?: string; nb_fan?: number };
type DzTrack = {
  id: number;
  readable?: boolean;
  title: string;
  title_short?: string;
  preview?: string;
  artist: DzArtist;
  contributors?: DzArtist[];
  album?: { id?: number; title?: string; cover_medium?: string; cover_big?: string };
};
type DzAlbum = {
  title?: string;
  record_type?: string;
  release_date?: string;
  genres?: { data?: { name?: string }[] };
  artist?: { id?: number; name?: string };
};

const VARIOUS_ARTISTS_ID = 5080;
/** Títulos típicos de coletânea (o ano do álbum não é o da música). */
const COMPILATION_TITLE = /greatest hits|best of|the very best|grandes sucessos|maiores sucessos|as melhores|colet[aâ]nea|\bhits\b/i;

async function getTrackMeta(albumId: number | undefined): Promise<TrackMeta> {
  const none: TrackMeta = { genre: null, year: null, compilation: false };
  if (!albumId) return none;
  try {
    const a = await dz<DzAlbum>(`/album/${albumId}`);
    const year = Number((a.release_date ?? "").slice(0, 4));
    const genre = a.genres?.data?.map((g) => g.name?.trim()).find((g) => g && g.toLowerCase() !== "all") ?? null;
    const compilation =
      a.record_type === "compile" ||
      a.artist?.id === VARIOUS_ARTISTS_ID ||
      /various artists|v[aá]rios artistas/i.test(a.artist?.name ?? "") ||
      COMPILATION_TITLE.test(a.title ?? "");
    return { genre, year: year >= 1900 && year <= new Date().getFullYear() + 1 ? year : null, compilation };
  } catch {
    return none;
  }
}
type DzList<T> = { data?: T[]; next?: string; total?: number; error?: { message: string } };

async function dz<T>(pathOrUrl: string): Promise<T> {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${API}${pathOrUrl}`;
  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Deezer respondeu ${res.status}`);
  const json = (await res.json()) as T & { error?: { message?: string } };
  if (json && typeof json === "object" && "error" in json && json.error) {
    throw new Error(`Deezer: ${json.error.message ?? "erro"}`);
  }
  return json;
}

/** Extrai o ID de um link de playlist (deezer.com/.../playlist/ID ou link curto). */
export async function resolvePlaylistId(input: string): Promise<string> {
  const text = input.trim();
  if (/^\d{3,}$/.test(text)) return text;
  const direct = text.match(/deezer\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?playlist\/(\d+)/i);
  if (direct) return direct[1];

  let url: URL;
  try {
    url = new URL(text.startsWith("http") ? text : `https://${text}`);
  } catch {
    throw new Error("Link inválido");
  }
  const allowed = ["link.deezer.com", "deezer.page.link", "dzr.page.link", "www.deezer.com", "deezer.com"];
  if (!allowed.includes(url.hostname)) throw new Error("Esse link não é do Deezer");

  // link curto: segue o redirecionamento e procura o ID na URL final ou no HTML
  const res = await fetch(url, { redirect: "follow", cache: "no-store", signal: AbortSignal.timeout(10000) });
  const found = res.url.match(/playlist\/(\d+)/);
  if (found) return found[1];
  const body = await res.text().catch(() => "");
  const inBody = body.match(/deezer\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?playlist\/(\d+)/i);
  if (inBody) return inBody[1];
  throw new Error("Não achei uma playlist nesse link");
}

export async function getPlaylistInfo(id: string) {
  const p = await dz<{ id: number; title: string; nb_tracks: number; picture_medium?: string; public?: boolean }>(
    `/playlist/${id}`,
  );
  return { id: String(p.id), title: p.title, nbTracks: p.nb_tracks, picture: p.picture_medium ?? null };
}

export async function searchArtists(q: string) {
  const r = await dz<DzList<DzArtist>>(`/search/artist?q=${encodeURIComponent(q)}&limit=8`);
  // a busca do Deezer às vezes põe homônimos pequenos na frente: ordena por fãs
  return (r.data ?? [])
    .map((a) => ({ id: String(a.id), name: a.name, picture: a.picture_medium ?? null, fans: a.nb_fan ?? 0 }))
    .sort((a, b) => b.fans - a.fans);
}

async function getPlaylistTracks(id: string, max = 400): Promise<DzTrack[]> {
  const out: DzTrack[] = [];
  let next: string | undefined = `/playlist/${id}/tracks?limit=100&index=0`;
  while (next && out.length < max) {
    const page: DzList<DzTrack> = await dz<DzList<DzTrack>>(next);
    out.push(...(page.data ?? []));
    next = page.next;
  }
  return out;
}

async function getArtistTracks(id: string): Promise<DzTrack[]> {
  const r = await dz<DzList<DzTrack>>(`/artist/${id}/top?limit=100`);
  return r.data ?? [];
}

export async function getTrack(id: string) {
  const t = await dz<DzTrack>(`/track/${id}`);
  const artists = [t.artist?.name, ...(t.contributors ?? []).map((c) => c.name)].filter(Boolean) as string[];
  return {
    id: String(t.id),
    preview: t.preview || null,
    title: t.title,
    artist: t.artist?.name ?? "",
    artists: [...new Set(artists)],
    meta: await getTrackMeta(t.album?.id),
  };
}

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, "")
    .replace(/\s+-\s+.*$/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function toPicked(t: DzTrack): PickedTrack {
  return {
    deezer_id: t.id,
    title: t.title,
    title_short: t.title_short ?? t.title,
    artist: t.artist?.name ?? "?",
    artists: [t.artist?.name ?? "?"],
    cover: t.album?.cover_big ?? t.album?.cover_medium ?? null,
    album: t.album?.title ?? null,
  };
}

async function loadSource(src: MusicSource): Promise<DzTrack[]> {
  if (src.type === "preset") {
    const preset = PRESETS[src.id];
    if (!preset) throw new Error(`Playlist pronta desconhecida: ${src.id}`);
    return getPlaylistTracks(preset.playlistId);
  }
  if (src.type === "playlist") return getPlaylistTracks(src.id);
  if (src.type === "artist") return getArtistTracks(src.id);
  throw new Error("Fonte desconhecida");
}

/**
 * Junta as faixas de todas as fontes, remove repetidas (mesmo ID ou mesmo
 * título+artista), descarta faixas sem prévia e sorteia N músicas de forma
 * equilibrada: as fontes se revezam (rodízio), então uma playlist de 200
 * não engole uma de 20.
 */
export async function buildTrackList(sources: MusicSource[], count: number) {
  const warnings: string[] = [];
  const pools: DzTrack[][] = [];
  const results = await Promise.allSettled(sources.map(loadSource));
  results.forEach((r, i) => {
    if (r.status === "fulfilled") pools.push(shuffle(r.value.filter((t) => t.preview && t.readable !== false)));
    else warnings.push(`Não consegui carregar "${sources[i].label}": ${(r.reason as Error).message}`);
  });

  const seenIds = new Set<number>();
  const seenKeys = new Set<string>();
  const picked: PickedTrack[] = [];
  const take = (t: DzTrack) => {
    const key = `${norm(t.title_short ?? t.title)}|${norm(t.artist?.name ?? "")}`;
    if (seenIds.has(t.id) || seenKeys.has(key)) return false;
    seenIds.add(t.id);
    seenKeys.add(key);
    picked.push(toPicked(t));
    return true;
  };

  // rodízio entre as fontes (ordem das fontes sorteada a cada volta)
  const cursors = pools.map(() => 0);
  while (picked.length < count) {
    let progressed = false;
    for (const i of shuffle(pools.map((_, k) => k))) {
      if (picked.length >= count) break;
      const pool = pools[i];
      while (cursors[i] < pool.length) {
        const t = pool[cursors[i]++];
        if (take(t)) {
          progressed = true;
          break;
        }
      }
    }
    if (!progressed) break;
  }

  if (picked.length < count && picked.length > 0) {
    warnings.push(`Só encontrei ${picked.length} músicas com prévia nas fontes escolhidas.`);
  }
  return { tracks: shuffle(picked), warnings };
}
