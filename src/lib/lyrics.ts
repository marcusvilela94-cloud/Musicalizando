// Letras (LRCLIB) e montagem dos versos do modo "Só pela letra".
// SÓ roda no servidor (rota /api/deezer/build): a letra nunca vai para os
// celulares; o banco guarda só os trechos e revela um por vez.
import "server-only";
import type { LyricVerses } from "./types";

const API = "https://lrclib.net/api";
const USER_AGENT = "Musicalizando/1.0 (https://github.com/marcusvilela94-cloud/Musicalizando)";

type LrcRecord = {
  trackName?: string;
  artistName?: string;
  duration?: number;
  instrumental?: boolean;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
};

/** A LRCLIB limita o ritmo (429): no máximo 3 requisições ao mesmo tempo. */
const MAX_PARALLEL = 3;
let running = 0;
const waiting: (() => void)[] = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_PARALLEL) await new Promise<void>((r) => waiting.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

/** Erro temporário (429/5xx/rede): não dá para dizer que a música não tem letra. */
class LrclibBusy extends Error {}

async function lrclib<T>(path: string): Promise<T | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await slot(async () => {
      try {
        const res = await fetch(`${API}${path}`, {
          headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
          cache: "no-store",
          signal: AbortSignal.timeout(8000),
        });
        if (res.status === 404) return { ok: true as const, data: null };
        if (res.status === 429 || res.status >= 500) return { ok: false as const, wait: Number(res.headers.get("retry-after")) || 0 };
        return { ok: true as const, data: res.ok ? ((await res.json()) as T) : null };
      } catch {
        return { ok: false as const, wait: 0 };
      }
    });
    if (r.ok) return r.data;
    // muitas requisições: espera e tenta de novo (1 s, 2 s, 4 s)
    await new Promise((res) => setTimeout(res, Math.max(r.wait * 1000, 1000 * 2 ** attempt)));
  }
  throw new LrclibBusy("LRCLIB ocupada");
}

/** Minúsculas, sem acentos, só letras/números e espaços. */
export const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Para comparar títulos/artistas: sem o que está entre ()/[] e depois de " - ". */
const key = (s: string) => fold(s.replace(/\(.*?\)|\[.*?\]/g, " ").replace(/\s[-–—]\s.*$/, ""));

const lyricsText = (r: LrcRecord | null) => {
  if (!r || r.instrumental) return null;
  const plain = r.plainLyrics?.trim();
  if (plain) return plain;
  // só a versão sincronizada: tira os tempos [01:23.45]
  const synced = r.syncedLyrics?.replace(/\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]/g, "").trim();
  return synced || null;
};

/**
 * Letra em texto simples: GET /api/get (título, artista, duração); se não
 * achar, /api/search escolhendo o resultado com título e artista iguais
 * (normalizados) e duração dentro de ±3 s. Instrumental/sem letra -> null.
 */
export async function fetchLyrics(title: string, artist: string, duration?: number): Promise<string | null> {
  const q = new URLSearchParams({ track_name: title, artist_name: artist });
  if (duration) q.set("duration", String(Math.round(duration)));
  const exact = await lrclib<LrcRecord>(`/get?${q}`);
  if (exact?.instrumental) return null;
  const text = lyricsText(exact);
  if (text) return text;

  const list = await lrclib<LrcRecord[]>(`/search?${new URLSearchParams({ track_name: title, artist_name: artist })}`);
  const t = key(title);
  const a = key(artist);
  const hit = (list ?? []).find(
    (r) =>
      key(r.trackName ?? "") === t &&
      key(r.artistName ?? "").includes(a) &&
      (!duration || !r.duration || Math.abs(r.duration - duration) <= 3) &&
      !!lyricsText(r),
  );
  return lyricsText(hit ?? null);
}

// ---------------------------------------------------------------------
// Versos
// ---------------------------------------------------------------------
/** Marcações que não são letra: [Refrão], (2x), "Chorus:", "Verso 2"… */
const LABEL_RE =
  /^(refrao|chorus|verse|verso|ponte|bridge|pre refrao|pre chorus|prechorus|intro|outro|hook|coro|repete|repeat|instrumental|solo)( \d+)?( \d+x| x\d+)?$/;

/** Só vocalização: oh, ah, yeah, uô, lá, na, uh, hey, ooh, whoa, iê… */
const FILLER_RE = /^(o+h*|a+h*|u+h*|u+o+|ye+a*h*|ie+|la+|na+|hey|ho+|whoa+|wo+|ooh+|mm+|hmm+|uau|eh+|ai+|ay+|oi+)$/;

function cleanLines(text: string) {
  return text
    .split(/\r?\n/)
    .map((l) =>
      l
        .replace(/\[[^\]]*\]/g, " ") // [Refrão], [Chorus: Fulano]
        .replace(/\(\s*(?:x\s*\d+|\d+\s*x|bis|repete|repeat)\s*\)/gi, " ") // (2x), (bis)
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((l) => {
      if (!l || !/\p{L}/u.test(l)) return false;
      if (/^\(.*\)$/.test(l)) return false; // linha inteira entre parênteses
      const f = fold(l);
      if (f.split(" ").every((w) => FILLER_RE.test(w))) return false; // "Oh-oh, yeah", "Lá-lá-lá"
      return !LABEL_RE.test(f.replace(/:$/, ""));
    });
}

/** Palavras curtas/comuns do título que não viram "___". */
const STOP = new Set(
  (
    "a o e de da do das dos em no na nos nas um uma uns umas por pra para com sem que se me te eu tu ele ela " +
    "the an and of to in on at for is it my me you your i we he she be by or as so do no not it's its " +
    "el la los las y en mi tu es un una lo"
  ).split(" "),
);
const WORD_RE = /[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu;

/** Palavras do título e de todos os artistas que aparecem nos versos viram "___". */
function maskWords(title: string, artists: string[]) {
  const words = new Set<string>();
  for (const src of [title, ...artists]) {
    for (const w of src.match(WORD_RE) ?? []) {
      const f = fold(w);
      if (f.length >= 3 && !STOP.has(f)) words.add(f);
    }
  }
  return words;
}

/**
 * Monta os trechos (2 linhas seguidas cada):
 *  - trechos 1 a 4: partes que NÃO são refrão, primeiro as menos repetidas e
 *    mais do meio/fim da letra, sem repetir linhas entre trechos;
 *  - último trecho: o refrão (as linhas que mais se repetem).
 * Menos de 3 trechos -> null (a música não entra no modo letra).
 */
export function buildVerses(text: string, title: string, artists: string[]): LyricVerses | null {
  const lines = cleanLines(text);
  const n = lines.length;
  if (n < 6) return null;
  const keys = lines.map(fold);
  const count = new Map<string, number>();
  for (const k of keys) count.set(k, (count.get(k) ?? 0) + 1);
  const c = (i: number) => count.get(keys[i]) ?? 0;

  // refrão: começa numa linha das mais repetidas, de preferência seguida de outra repetida
  const max = Math.max(...keys.map((k) => count.get(k) ?? 0));
  let chorus: [number, number];
  if (max >= 2) {
    const starts = keys.map((_, i) => i).filter((i) => c(i) === max && i + 1 < n);
    // de preferência duas linhas diferentes, as duas repetidas
    const start =
      starts.find((i) => c(i + 1) >= 2 && keys[i + 1] !== keys[i]) ??
      starts.find((i) => keys[i + 1] !== keys[i]) ??
      starts[0] ??
      keys.findIndex((k) => (count.get(k) ?? 0) === max);
    chorus = start + 1 < n ? [start, start + 1] : [start - 1, start];
  } else {
    chorus = [n - 2, n - 1]; // sem repetição: o fim da letra faz o papel do refrão
  }
  const usedKeys = new Set([keys[chorus[0]], keys[chorus[1]]]);

  // escondidas: palavras do título/artistas (e pedaços de 4+ letras delas: "apai…")
  const hide = maskWords(title, artists);
  const hidden = (w: string) => {
    const f = fold(w);
    if (hide.has(f)) return true;
    if (f.length < 4) return false;
    for (const h of hide) if (h.length > f.length && h.startsWith(f)) return true;
    return false;
  };
  const mask = (l: string) => l.replace(WORD_RE, (w) => (hidden(w) ? "___" : w));
  // linha quase toda escondida ("___, ___, ___, uô") não ajuda: vai para o fim da fila
  const mostlyHidden = (i: number) => {
    const words = lines[i].match(WORD_RE) ?? [];
    return words.length > 0 && words.filter(hidden).length * 2 >= words.length;
  };

  // demais trechos: menos repetidos primeiro; empate -> mais para o meio/fim
  const cands: { i: number; score: number }[] = [];
  for (let i = 0; i + 1 < n; i++) {
    if (usedKeys.has(keys[i]) || usedKeys.has(keys[i + 1]) || keys[i] === keys[i + 1]) continue;
    // linha curtinha ("Acesas") quase não dá pista: também vai para o fim
    const short = (k: number) => (lines[k].match(WORD_RE) ?? []).length < 3;
    const penalty =
      (mostlyHidden(i) ? 1000 : 0) + (mostlyHidden(i + 1) ? 1000 : 0) + (short(i) ? 300 : 0) + (short(i + 1) ? 300 : 0);
    cands.push({ i, score: penalty + (c(i) + c(i + 1)) * 100 - Math.round((100 * i) / n) });
  }
  cands.sort((x, y) => x.score - y.score);
  const picked: number[] = [];
  const usedIdx = new Set<number>();
  for (const { i } of cands) {
    if (picked.length >= 4) break;
    if (usedIdx.has(i) || usedIdx.has(i + 1) || usedKeys.has(keys[i]) || usedKeys.has(keys[i + 1])) continue;
    picked.push(i);
    usedIdx.add(i).add(i + 1);
    usedKeys.add(keys[i]).add(keys[i + 1]);
  }
  if (picked.length + 1 < 3) return null;

  const plain = [...picked.map((i) => [lines[i], lines[i + 1]]), [lines[chorus[0]], lines[chorus[1]]]];
  return { masked: plain.map((seg) => seg.map(mask)), plain };
}

/** Letras já buscadas (título|artista -> texto ou null). Erro temporário não entra no cache. */
const lyricsCache = new Map<string, Promise<string | null>>();
function cachedLyrics(title: string, artist: string, duration?: number) {
  const k = `${key(title)}|${key(artist)}`;
  let p = lyricsCache.get(k);
  if (!p) {
    p = fetchLyrics(title, artist, duration);
    p.catch(() => lyricsCache.delete(k));
    lyricsCache.set(k, p);
    if (lyricsCache.size > 2000) lyricsCache.delete(lyricsCache.keys().next().value!);
  }
  return p;
}

/** Letra + versos de uma faixa (null se não tem letra boa para o modo; erro se a LRCLIB não respondeu). */
export async function versesFor(t: { title: string; titleShort: string; artist: string; duration?: number }) {
  const text = await cachedLyrics(t.titleShort, t.artist, t.duration);
  if (!text) return null;
  // participações no título ("(feat. Fulano)") também viram "___"
  const feat = t.title.match(/\((?:feat\.?|ft\.?|part\.?|com|with)\s+([^)]*)\)/i)?.[1] ?? "";
  return buildVerses(text, t.titleShort, [t.artist, feat].filter(Boolean));
}
