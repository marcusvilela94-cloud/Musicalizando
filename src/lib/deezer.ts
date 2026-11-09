// Acesso à API pública do Deezer. SÓ roda no servidor (rotas /api/deezer/*):
// o Deezer bloqueia chamadas diretas do navegador por CORS.
import "server-only";
import { versesFor } from "./lyrics";
import { mbYear, recordingsByIsrc, searchRecordings } from "./musicbrainz";
import { adminRpc } from "./bibliotecaServer";
import { supabaseServer } from "./supabaseServer";
import type { ArtistLevel, MusicSource, PickedTrack, SourceRef, TrackMeta } from "./types";

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
  title_version?: string;
  isrc?: string;
  duration?: number;
  preview?: string;
  artist: DzArtist;
  contributors?: DzArtist[];
  album?: { id?: number; title?: string; cover_medium?: string; cover_big?: string };
};
type DzAlbum = {
  id?: number;
  title?: string;
  record_type?: string;
  release_date?: string;
  genres?: { data?: { name?: string }[] };
  artist?: { id?: number; name?: string };
};

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

/**
 * Fonte "artista": conjunto de onde as músicas são sorteadas.
 *  - head = quantas do começo da lista entram no sorteio; o resto fica na ordem
 *    (só entra se faltar música depois dos filtros: "completa com as seguintes do top").
 */
type SourcePool = { tracks: DzTrack[]; head: number };

/** Nível de popularidade: Sucessos = top 15, Conhecidas = top 50, Fã = catálogo inteiro. */
const LEVEL_HEAD: Record<ArtistLevel, number> = { hits: 15, known: 50, fan: Infinity };
/** Fã de carteirinha: no máximo 20 álbuns/singles consultados. */
const FAN_MAX_ALBUMS = 20;

type DzAlbumItem = { id: number; title?: string; record_type?: string; cover_medium?: string; cover_big?: string };

async function getArtistTracks(id: string, level: ArtistLevel): Promise<SourcePool> {
  if (level !== "fan") {
    // top 100 em ordem de popularidade: sorteia entre as N primeiras, as demais completam
    const r = await dz<DzList<DzTrack>>(`/artist/${id}/top?limit=100`);
    return { tracks: r.data ?? [], head: LEVEL_HEAD[level] };
  }
  // catálogo: álbuns, singles e EPs do artista (sem coletâneas), até 20, sorteados
  const list = await dz<DzList<DzAlbumItem>>(`/artist/${id}/albums?limit=100`);
  const albums = shuffle((list.data ?? []).filter((a) => a.record_type !== "compile")).slice(0, FAN_MAX_ALBUMS);
  const perAlbum = await Promise.all(
    albums.map(async (a) => {
      const t = await dz<DzList<DzTrack>>(`/album/${a.id}/tracks?limit=100`).catch(() => ({ data: [] }) as DzList<DzTrack>);
      // as faixas do álbum não trazem o álbum: completa (capa, título, id)
      return (t.data ?? []).map((x) => ({ ...x, album: { id: a.id, title: a.title, cover_medium: a.cover_medium, cover_big: a.cover_big } }));
    }),
  );
  return { tracks: perAlbum.flat(), head: Infinity };
}

export async function getTrack(id: string) {
  const t = await dz<DzTrack>(`/track/${id}`);
  const artists = [t.artist?.name, ...(t.contributors ?? []).map((c) => c.name)].filter(Boolean) as string[];
  return {
    id: String(t.id),
    preview: t.preview || null,
    title: t.title,
    titleShort: t.title_short ?? t.title,
    duration: t.duration,
    cover: t.album?.cover_medium ?? null,
    artist: t.artist?.name ?? "",
    artists: [...new Set(artists)],
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

// ---------------------------------------------------------------------
// Filtro de versões (ao vivo, acústico, remix, karaokê, cover, regravação…)
// ---------------------------------------------------------------------
/** Minúsculas, sem acentos, pontuação vira espaço. */
const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const VERSION_WORDS_RE =
  /\b(ao vivo|live|acustico|acoustic|unplugged|remix|mix|karaoke|instrumental|cover|tributo|tribute|versao|version|regravacao|re ?recorded|sped up|slowed)\b/;
/**
 * "Version" que não é outra gravação: edições do mesmo álbum ("Fearless
 * (International Version)", "Deluxe Version"…) e remasters ("Versão Remasterizada").
 */
const SAME_RECORDING_RE =
  /\b(deluxe|super deluxe|international|expanded|bonus tracks?|special|standard|explicit|clean|edited|album|original|single|radio|anniversary|remaster\w*)( edition)? (version|versao)\b|\b(versao|version) (remaster\w*|original|do album|deluxe)\b/g;
const VERSION_RE = { test: (text: string) => VERSION_WORDS_RE.test(text.replace(SAME_RECORDING_RE, " ")) };

/**
 * Trecho do título que indica a versão: o que está entre parênteses/colchetes,
 * depois de " - " e o title_version do Deezer. (Assim "Live Forever" não cai.)
 */
function titleVersionText(t: Pick<DzTrack, "title" | "title_version">) {
  const title = t.title ?? "";
  const bits = [...title.matchAll(/\(([^)]*)\)|\[([^\]]*)\]/g)].map((m) => m[1] ?? m[2] ?? "");
  const dash = title.match(/\s[-–—]\s(.*)$/);
  if (dash) bits.push(dash[1]);
  if (t.title_version) bits.push(t.title_version);
  return fold(bits.join(" "));
}

/** Título do álbum sem o nome da própria música (o single "Live Forever" não conta como ao vivo). */
function albumVersionText(albumTitle: string | undefined, trackTitle: string) {
  const a = fold(albumTitle ?? "");
  const t = fold(trackTitle);
  return t && a.startsWith(t) ? a.slice(t.length) : a;
}

const versionText = (t: DzTrack) =>
  `${titleVersionText(t)} | ${albumVersionText(t.album?.title, t.title_short ?? t.title)}`;
/** Faixa é outra versão (ao vivo, remix, cover…)? */
export const isOtherVersion = (t: DzTrack) => VERSION_RE.test(versionText(t));

/** Álbuns já consultados (record_type, data, gênero). Compartilhado entre as rotas. */
const albumCache = new Map<number, Promise<DzAlbum | null>>();
function getAlbum(id: number | undefined): Promise<DzAlbum | null> {
  if (!id) return Promise.resolve(null);
  let p = albumCache.get(id);
  if (!p) {
    p = dz<DzAlbum>(`/album/${id}`).catch(() => null);
    albumCache.set(id, p);
    if (albumCache.size > 3000) albumCache.delete(albumCache.keys().next().value!);
  }
  return p;
}

const VARIOUS_ARTISTS_ID = 5080;
const isCompilationAlbum = (a: DzAlbum | null) =>
  !!a &&
  (a.record_type === "compile" || a.artist?.id === VARIOUS_ARTISTS_ID || /various artists|v[aá]rios artistas/i.test(a.artist?.name ?? ""));

function yearOf(date: string | undefined) {
  const y = Number((date ?? "").slice(0, 4));
  return y >= 1900 && y <= new Date().getFullYear() + 1 ? y : null;
}
/**
 * Ano de um álbum. O Deezer costuma guardar a data do relançamento digital
 * (remaster), então um ano escrito no título ("Roberto Carlos 1971
 * Remasterizado") vale se for mais antigo. Remasters contam no menor ano:
 * nunca são mais antigos que o original, então só podem ajudar.
 */
function albumYear(a: DzAlbum) {
  const date = yearOf(a.release_date);
  const inTitle = [...(a.title ?? "").matchAll(/\b(19\d\d|20\d\d)\b/g)].map((m) => Number(m[1]));
  const all = [date, ...inTitle.filter((y) => !date || y <= date)].filter((y): y is number => !!y);
  return all.length ? Math.min(...all) : null;
}
const genreOf =(a: DzAlbum | null) =>
  a?.genres?.data?.map((g) => g.name?.trim()).find((g) => g && g.toLowerCase() !== "all") ?? null;

// ---------------------------------------------------------------------
// Dica "Gênero e ano" do Leilão: ano ORIGINAL da música
// ---------------------------------------------------------------------
const metaCache = new Map<string, Promise<TrackMeta>>();

/**
 * Ano original da música = o MENOR entre:
 *  - MusicBrainz pelo ISRC da faixa (a gravação exata; remasters costumam
 *    apontar para a gravação original, com a data de 1º lançamento);
 *  - MusicBrainz por título + artista (gravações de estúdio do mesmo artista);
 *  - Deezer: álbuns/singles com a mesma música do mesmo artista principal,
 *    sem coletâneas e sem outras versões (ao vivo, remix…).
 * Sem resultado confiável -> year null (a rodada usa a dica "Artista").
 */
export function getAuctionMeta(id: string): Promise<TrackMeta> {
  let p = metaCache.get(id);
  if (!p) {
    p = computeAuctionMeta(id);
    p.catch(() => metaCache.delete(id));
    metaCache.set(id, p);
    if (metaCache.size > 500) metaCache.delete(metaCache.keys().next().value!);
  }
  return p;
}

async function computeAuctionMeta(id: string): Promise<TrackMeta> {
  const t = await dz<DzTrack>(`/track/${id}`);
  const own = await getAlbum(t.album?.id);
  const name = t.artist?.name ?? "";
  const short = t.title_short ?? t.title;
  const mbYearP = musicBrainzYear(t.isrc, short, name); // em paralelo com o Deezer
  const q = `artist:"${name.replace(/"/g, "")}" track:"${short.replace(/"/g, "")}"`;
  const search = (query: string) =>
    dz<DzList<DzTrack>>(`/search/track?q=${encodeURIComponent(query)}&limit=50`).catch(() => ({ data: [] }) as DzList<DzTrack>);
  // a busca avançada (artist:"" track:"") do Deezer tem voltado vazia: busca simples
  // "artista música" primeiro (o filtro abaixo garante título e artista iguais)
  let found = await search(`${name} ${short}`);
  if (!found.data?.length) found = await search(q);

  // mesma música (título normalizado) do mesmo artista principal, versão "normal"
  const key = norm(short);
  const artistKey = norm(name);
  const same = (found.data ?? []).filter(
    (x) =>
      norm(x.title_short ?? x.title) === key &&
      (x.artist?.id === t.artist?.id || norm(x.artist?.name ?? "") === artistKey) &&
      !isOtherVersion(x),
  );
  const albumIds = [...new Set(same.map((x) => x.album?.id).filter((v): v is number => !!v))].slice(0, 12);
  const albums = (await Promise.all(albumIds.map(getAlbum))).filter(
    (a): a is DzAlbum =>
      !!a && !isCompilationAlbum(a) && !VERSION_RE.test(albumVersionText(a.title, short)),
  );
  const dated = albums
    .map((a) => ({ a, year: albumYear(a) }))
    .filter((x): x is { a: DzAlbum; year: number } => x.year !== null)
    .sort((x, y) => x.year - y.year);
  // MusicBrainz lento/fora do ar: no máximo 8 s de espera (a TV desiste em 12 s)
  const mbYearOrNull = await Promise.race([mbYearP, new Promise<null>((r) => setTimeout(() => r(null), 8000))]);
  const years = [dated[0]?.year ?? null, mbYearOrNull].filter((y): y is number => y !== null);
  const year = years.length ? Math.min(...years) : null;
  // gênero: o do álbum da faixa (se não for coletânea); senão o do lançamento mais antigo
  const genre = (!isCompilationAlbum(own) ? genreOf(own) : null) ?? dated.map((x) => genreOf(x.a)).find(Boolean) ?? null;
  return { genre, year, compilation: false, track_year: yearOf(own?.release_date) };
}

/** Gravação ao vivo/acústica/cover pelo ISRC: não é a original. ("international mix" vale.) */
const MB_LIVE_RE = /\b(live|ao vivo|acoustic|acustico|unplugged|cover|karaoke|instrumental|re ?recorded|demo)\b/;

/** Menor ano de 1º lançamento no MusicBrainz (null se não achou nada confiável). */
async function musicBrainzYear(isrc: string | undefined, title: string, artist: string): Promise<number | null> {
  const [byIsrc, bySearch] = await Promise.all([isrc ? recordingsByIsrc(isrc) : [], searchRecordings(title, artist)]);
  const key = norm(title);
  const artistKey = norm(artist);
  const fromIsrc = byIsrc.filter((r) => !MB_LIVE_RE.test(fold(r.disambiguation ?? "")));
  const fromSearch = bySearch.filter(
    (r) =>
      !r.video &&
      norm(r.title) === key &&
      !VERSION_RE.test(titleVersionText({ title: r.title })) &&
      !VERSION_RE.test(fold(r.disambiguation ?? "")) &&
      (r["artist-credit"] ?? []).some((c) => norm(c.name) === artistKey || norm(c.artist?.name ?? "") === artistKey),
  );
  const years = [...fromIsrc, ...fromSearch].map(mbYear).filter((y): y is number => y !== null);
  return years.length ? Math.min(...years) : null;
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function toPicked(t: DzTrack, source?: SourceRef): PickedTrack {
  return {
    ...(source ? { source } : {}),
    deezer_id: t.id,
    title: t.title,
    title_short: t.title_short ?? t.title,
    artist: t.artist?.name ?? "?",
    artists: [t.artist?.name ?? "?"],
    cover: t.album?.cover_big ?? t.album?.cover_medium ?? null,
    album: t.album?.title ?? null,
    album_id: t.album?.id ?? null,
    artist_id: t.artist?.id || null, // 0 = desconhecido (músicas do cache sem o ID)
  };
}

/**
 * Curiosidades: a música mais popular do artista (top do Deezer), com prévia,
 * respeitando o filtro de versões (sem ao vivo, remix, coletâneas…).
 * null = artista não encontrado ou nenhuma faixa serve.
 */
export async function artistTopTrack(name: string, versionFilter: boolean, exclude: Set<number> = new Set()): Promise<PickedTrack | null> {
  const r = await dz<DzList<DzArtist>>(`/search/artist?q=${encodeURIComponent(name)}&limit=8`);
  const want = fold(name);
  // nome igual (o mais seguido); a busca às vezes põe homônimos pequenos na frente
  const artist = (r.data ?? []).filter((a) => fold(a.name) === want).sort((a, b) => (b.nb_fan ?? 0) - (a.nb_fan ?? 0))[0];
  if (!artist) return null;
  const top = await dz<DzList<DzTrack>>(`/artist/${artist.id}/top?limit=15`);
  for (const t of top.data ?? []) {
    if (!t.preview || t.readable === false || exclude.has(t.id)) continue;
    if (versionFilter && (isOtherVersion(t) || isCompilationAlbum(await getAlbum(t.album?.id)))) continue;
    return toPicked(t);
  }
  return null;
}

/** Dados guardados de cada música do cache (npl_stems_cache.meta). */
type CachedMeta = {
  title: string;
  title_short?: string;
  artist: string;
  artist_id?: number;
  album?: string;
  album_id?: number;
  cover?: string;
  duration?: number;
};
/** Músicas sem dados (pedidas antes da 022): no máximo tantas consultas ao Deezer por vez. */
const CACHE_META_LOOKUPS = 60;

/**
 * Fonte "Músicas já preparadas": todas as músicas do cache dos Instrumentos.
 * Os dados vêm do banco; as que ainda não têm são buscadas no Deezer e
 * gravadas (npl_stems_fill_meta), para não consultar de novo.
 */
async function getCachedTracks(collection?: string): Promise<DzTrack[]> {
  const sb = supabaseServer();
  const { data, error } = await sb.rpc("npl_stems_cached", collection ? { p_collection: collection } : {});
  if (error) throw new Error(`cache dos instrumentos: ${error.message}`);
  const rows = ((data ?? []) as { deezer_id: number; meta: CachedMeta | null }[]).map((r) => ({ ...r, deezer_id: Number(r.deezer_id) }));
  await completeCacheMeta(rows);
  return rows
    .filter((r): r is { deezer_id: number; meta: CachedMeta } => !!r.meta)
    .map((r) => ({
      id: r.deezer_id,
      readable: true,
      title: r.meta.title,
      title_short: r.meta.title_short ?? r.meta.title,
      duration: r.meta.duration,
      preview: "cache", // o jogo busca a prévia atualizada na hora de tocar
      artist: { id: r.meta.artist_id ?? 0, name: r.meta.artist },
      album: { id: r.meta.album_id, title: r.meta.album, cover_big: r.meta.cover },
    }));
}

/**
 * Músicas do cache sem dados (pedidas antes da 022): busca no Deezer (no
 * máximo CACHE_META_LOOKUPS por vez), completa as linhas e grava no banco.
 * Usado pela fonte do cache e pela biblioteca.
 */
export async function completeCacheMeta(rows: { deezer_id: number; meta: CachedMeta | null }[]) {
  const missing = rows.filter((r) => !r.meta).slice(0, CACHE_META_LOOKUPS);
  if (missing.length) {
    const found: (PickedTrack & { duration?: number })[] = [];
    for (let i = 0; i < missing.length; i += 6) {
      const got = await Promise.all(missing.slice(i, i + 6).map((r) => dz<DzTrack>(`/track/${r.deezer_id}`).catch(() => null)));
      for (const t of got) if (t?.id) found.push({ ...toPicked(t), duration: t.duration });
    }
    const byId = new Map(found.map((t) => [t.deezer_id, t]));
    for (const r of missing) {
      const t = byId.get(r.deezer_id);
      if (t)
        r.meta = {
          title: t.title,
          title_short: t.title_short,
          artist: t.artist,
          artist_id: t.artist_id ?? undefined,
          album: t.album ?? undefined,
          album_id: t.album_id ?? undefined,
          cover: t.cover ?? undefined,
          duration: t.duration,
        };
    }
    // só o servidor grava (service_role): a chave pública não chama mais npl_stems_fill_meta
    if (found.length && process.env.SUPABASE_SERVICE_ROLE_KEY)
      await adminRpc("npl_stems_fill_meta", { p_tracks: found }).catch(() => {});
  }
}

async function loadSource(src: MusicSource): Promise<SourcePool> {
  if (src.type === "cache") return { tracks: await getCachedTracks(), head: Infinity };
  if (src.type === "collection") {
    if (!/^[0-9a-f-]{36}$/i.test(src.id)) throw new Error("Coleção inválida");
    return { tracks: await getCachedTracks(src.id), head: Infinity };
  }
  if (src.type === "preset") {
    const preset = PRESETS[src.id];
    if (!preset) throw new Error(`Playlist pronta desconhecida: ${src.id}`);
    return { tracks: await getPlaylistTracks(preset.playlistId), head: Infinity };
  }
  if (src.type === "playlist") return { tracks: await getPlaylistTracks(src.id), head: Infinity };
  if (src.type === "artist") {
    const level: ArtistLevel = src.level === "hits" || src.level === "fan" ? src.level : "known";
    return getArtistTracks(src.id, level);
  }
  throw new Error("Fonte desconhecida");
}

/**
 * Junta as faixas de todas as fontes, remove repetidas (mesmo ID ou mesmo
 * título+artista), descarta faixas sem prévia e sorteia N músicas de forma
 * equilibrada: as fontes se revezam (rodízio), então uma playlist de 200
 * não engole uma de 20. Com o filtro de versões, descarta ao vivo, acústico,
 * remix, karaokê, covers, regravações… e faixas de coletâneas.
 *
 * Letras (modo "Só pela letra"): lyricsNeed = quantas músicas COM letra a
 * partida precisa (as rodadas de letra). As sem letra só entram até completar
 * as outras (count - lyricsNeed); depois disso, só entram músicas com letra.
 */
/** Limite de músicas consultadas na LRCLIB por lista (para não demorar demais). */
const MAX_LYRICS_LOOKUPS = 220;
/** Consultas de letra em paralelo (a LRCLIB é gratuita: sem exagero). */
const LYRICS_PARALLEL = 12;

/** Promise.all com no máximo n ao mesmo tempo. */
async function mapLimit<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

export async function buildTrackList(sources: MusicSource[], count: number, versionFilter = true, lyricsNeed = 0) {
  const need = Math.max(0, Math.min(count, Math.floor(lyricsNeed)));
  const warnings: string[] = [];
  const pools: DzTrack[][] = [];
  const poolSource: SourceRef[] = [];
  const results = await Promise.allSettled(sources.map(loadSource));
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      // filtros primeiro; depois sorteia entre as "head" primeiras e deixa o resto (em ordem) para completar
      const ok = r.value.tracks.filter((t) => t.preview && t.readable !== false && !(versionFilter && isOtherVersion(t)));
      pools.push([...shuffle(ok.slice(0, r.value.head)), ...ok.slice(r.value.head)]);
      poolSource.push({ type: sources[i].type, id: String(sources[i].id), label: String(sources[i].label ?? "").slice(0, 200) });
    } else warnings.push(`Não consegui carregar "${sources[i].label}": ${(r.reason as Error).message}`);
  });

  // rodízio entre as fontes (ordem das fontes sorteada a cada volta), sem repetidas
  const seenIds = new Set<number>();
  const seenKeys = new Set<string>();
  function* candidates(): Generator<{ t: DzTrack; src: SourceRef }> {
    const cursors = pools.map(() => 0);
    for (;;) {
      let any = false;
      for (const i of shuffle(pools.map((_, k) => k))) {
        const pool = pools[i];
        while (cursors[i] < pool.length) {
          const t = pool[cursors[i]++];
          const key = `${norm(t.title_short ?? t.title)}|${norm(t.artist?.name ?? "")}`;
          if (seenIds.has(t.id) || seenKeys.has(key)) continue;
          seenIds.add(t.id);
          seenKeys.add(key);
          any = true;
          yield { t, src: poolSource[i] };
          break;
        }
      }
      if (!any) return;
    }
  }

  // coletânea só dá para saber consultando o álbum: confere em lotes, em paralelo
  const picked: PickedTrack[] = [];
  const gen = candidates();
  let lookups = 0;
  let without = 0; // aceitas sem letra
  const srcOf = new Map<number, SourceRef>();
  while (picked.length < count && lookups < MAX_LYRICS_LOOKUPS) {
    const batch: DzTrack[] = [];
    while (batch.length < count - picked.length) {
      const n = gen.next();
      if (n.done) break;
      batch.push(n.value.t);
      srcOf.set(n.value.t.id, n.value.src);
    }
    if (!batch.length) break;
    const keep = versionFilter
      ? await Promise.all(batch.map(async (t) => (await getAlbum(t.album?.id))?.record_type !== "compile"))
      : batch.map(() => true);
    const verses = await mapLimit(batch, LYRICS_PARALLEL, async (t, i) => {
      if (need === 0 || !keep[i]) return null;
      lookups++;
      return versesFor({ title: t.title, titleShort: t.title_short ?? t.title, artist: t.artist?.name ?? "", duration: t.duration }).catch(() => null);
    });
    batch.forEach((t, i) => {
      if (!keep[i] || picked.length >= count) return;
      if (verses[i]) picked.push({ ...toPicked(t, srcOf.get(t.id)), lyrics: verses[i]! });
      else if (without < count - need) {
        without++;
        picked.push(toPicked(t, srcOf.get(t.id)));
      }
    });
  }

  if (picked.length < count && picked.length > 0 && need === 0) {
    warnings.push(`Só encontrei ${picked.length} músicas com prévia nas fontes escolhidas.`);
  }
  return { tracks: shuffle(picked), warnings, withLyrics: picked.filter((t) => t.lyrics).length };
}

// Usados pelo gerador de perguntas do quiz (src/lib/quiz.ts)
export { dz as dzGet, getAlbum, isCompilationAlbum, genreOf, norm as normTitle, fold, shuffle, VERSION_RE, albumVersionText };
export type { DzTrack, DzAlbum, DzList, DzArtist };
