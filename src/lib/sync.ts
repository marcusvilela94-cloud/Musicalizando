// TESTE DE VIABILIDADE (/lab/sync): em que segundo da prévia de 30 s do
// Deezer cada linha da letra é cantada. SÓ roda no servidor.
//  1. Transcrição: Groq (whisper-large-v3) com o tempo de cada palavra.
//  2. Letra: LRCLIB (syncedLyrics dá a ordem e os tempos na música inteira).
//  3. Alinhamento local (Smith-Waterman) palavra a palavra entre a
//     transcrição e a letra inteira, tolerante a erros (Levenshtein).
import "server-only";
import { FILLER_RE, fetchLyricsRecord, fold } from "./lyrics";

const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
/** Plano gratuito: 20 pedidos/minuto -> no mínimo 3,1 s entre chamadas (por instância). */
const GROQ_GAP_MS = 3100;

type Word = { word: string; start: number; end: number };
type GroqResult = { text?: string; language?: string; duration?: number; words?: Word[]; segments?: { start: number; end: number; text: string }[] };

let groqQueue: Promise<unknown> = Promise.resolve();
let lastGroq = 0;

/** Fila: uma transcrição por vez, com intervalo; 429 -> espera e tenta de novo. */
function transcribe(audio: ArrayBuffer): Promise<GroqResult> {
  const key = process.env.GROQ_API_KEY;
  if (!key) return Promise.reject(new Error("GROQ_API_KEY não configurada"));
  const run = async (): Promise<GroqResult> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const wait = lastGroq + GROQ_GAP_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastGroq = Date.now();
      const form = new FormData();
      form.append("file", new Blob([audio], { type: "audio/mpeg" }), "preview.mp3");
      form.append("model", "whisper-large-v3");
      form.append("response_format", "verbose_json");
      form.append("timestamp_granularities[]", "word");
      form.append("timestamp_granularities[]", "segment");
      form.append("temperature", "0");
      const res = await fetch(GROQ_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: form,
        signal: AbortSignal.timeout(30000),
      });
      if (res.status === 429) {
        const after = Number(res.headers.get("retry-after")) || 10;
        await new Promise((r) => setTimeout(r, Math.min(30, after) * 1000));
        continue;
      }
      if (!res.ok) throw new Error(`Groq respondeu ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return (await res.json()) as GroqResult;
    }
    throw new Error("Groq: limite de pedidos (tente de novo em 1 minuto)");
  };
  const p = groqQueue.then(run, run);
  groqQueue = p.catch(() => null);
  return p;
}

// ---------------------------------------------------------------------
// Letra -> linhas (com o tempo do LRC, se houver)
// ---------------------------------------------------------------------
type Line = { idx: number; text: string; lrc: number | null; tokens: string[] };

function lyricLines(plain: string | null | undefined, synced: string | null | undefined): Line[] {
  const raw: { text: string; lrc: number | null }[] = [];
  if (synced?.trim()) {
    for (const l of synced.split(/\r?\n/)) {
      const m = l.match(/^\s*\[(\d{1,2}):(\d{2}(?:[.:]\d{1,3})?)\]\s*(.*)$/);
      if (!m) continue;
      const text = m[3].trim();
      if (text) raw.push({ text, lrc: Number(m[1]) * 60 + Number(m[2].replace(":", ".")) });
    }
  }
  if (!raw.length) for (const l of (plain ?? "").split(/\r?\n/)) if (l.trim()) raw.push({ text: l.trim(), lrc: null });
  return raw
    .map((r) => ({ ...r, text: r.text.replace(/\[[^\]]*\]/g, "").trim() }))
    .filter((r) => r.text && /\p{L}/u.test(r.text))
    .map((r, idx) => ({ idx, text: r.text, lrc: r.lrc, tokens: fold(r.text).split(" ").filter(Boolean) }));
}

// ---------------------------------------------------------------------
// Alinhamento
// ---------------------------------------------------------------------
function lev(a: string, b: string) {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}
/** 1 = palavra igual; 0 = nada a ver. */
const sim = (a: string, b: string) => 1 - lev(a, b) / Math.max(a.length, b.length, 1);

export type SyncLine = {
  idx: number;
  text: string;
  /** segundo da prévia em que a linha começa (estimado se a 1ª palavra não foi ouvida) */
  start: number;
  confidence: number; // 0..100
  /** a linha começou antes da prévia (não serve para "parar antes") */
  cut: boolean;
  /** fim da última palavra ouvida desta linha (s da prévia) */
  sungEnd?: number;
  /** tempo previsto pelo LRC (offset da prévia na música), se houver */
  lrcStart: number | null;
  /** "audio" = achada na transcrição; "lrc" = só prevista pelo LRC */
  source: "audio" | "lrc";
};

export type SyncResult = {
  language: string | null;
  transcript: string;
  words: number;
  hasSynced: boolean;
  /** onde a prévia começa na música (s), estimado pelo LRC */
  offset: number | null;
  lines: SyncLine[];
};

const SECS_PER_WORD = 0.32; // para estimar o início quando as primeiras palavras não foram ouvidas

function align(words: Word[], lines: Line[]): Omit<SyncResult, "language" | "transcript" | "hasSynced"> {
  // transcrição -> tokens (uma palavra pode virar vários: "rock-n-roll")
  const A: { t: string; start: number; end: number }[] = [];
  for (const w of words) {
    const parts = fold(w.word).split(" ").filter(Boolean);
    parts.forEach((t, k) => {
      const d = (w.end - w.start) / parts.length;
      A.push({ t, start: w.start + k * d, end: w.start + (k + 1) * d });
    });
  }
  const B: { t: string; line: number; pos: number }[] = [];
  for (const l of lines) l.tokens.forEach((t, pos) => B.push({ t, line: l.idx, pos }));
  const n = A.length;
  const m = B.length;
  if (!n || !m) return { words: n, offset: null, lines: [] };

  // Smith-Waterman (local): acerto = +2·sim, erro = -1, pular palavra = -0.7
  const GAP = 0.7;
  const H = Array.from({ length: n + 1 }, () => new Float32Array(m + 1));
  let best = 0;
  let bi = 0;
  let bj = 0;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const s = sim(A[i - 1].t, B[j - 1].t);
      const diag = H[i - 1][j - 1] + (s >= 0.6 ? 2 * s : -1);
      const v = Math.max(0, diag, H[i - 1][j] - GAP, H[i][j - 1] - GAP);
      H[i][j] = v;
      if (v > best) [best, bi, bj] = [v, i, j];
    }
  }
  // volta pelo caminho: pares (palavra ouvida, palavra da letra)
  const pairs: { a: number; b: number; s: number }[] = [];
  let i = bi;
  let j = bj;
  while (i > 0 && j > 0 && H[i][j] > 0) {
    const s = sim(A[i - 1].t, B[j - 1].t);
    if (Math.abs(H[i][j] - (H[i - 1][j - 1] + (s >= 0.6 ? 2 * s : -1))) < 1e-4) {
      if (s >= 0.6) pairs.push({ a: i - 1, b: j - 1, s });
      i--;
      j--;
    } else if (Math.abs(H[i][j] - (H[i - 1][j] - GAP)) < 1e-4) i--;
    else j--;
  }
  pairs.reverse();

  // por linha: início = 1ª palavra casada (recuando o que faltou), confiança = palavras casadas
  const byLine = new Map<number, { a: number; b: number; s: number }[]>();
  for (const p of pairs) {
    const ln = B[p.b].line;
    byLine.set(ln, [...(byLine.get(ln) ?? []), p]);
  }
  const out: SyncLine[] = [];
  for (const [ln, ps] of byLine) {
    const line = lines[ln];
    const first = ps[0];
    const lastP = ps[ps.length - 1];
    const pos = B[first.b].pos;
    const start = A[first.a].start - pos * SECS_PER_WORD;
    const matched = ps.reduce((acc, p) => acc + p.s, 0);
    let conf = (matched / line.tokens.length) * 100;
    if (pos > 0) conf *= 1 - Math.min(0.5, pos / line.tokens.length / 2); // início estimado
    out.push({
      idx: ln,
      text: line.text,
      start: Math.max(0, Math.round(start * 100) / 100),
      confidence: Math.round(Math.min(100, conf)),
      cut: start < 0.15,
      sungEnd: Math.round(A[lastP.a].end * 100) / 100,
      lrcStart: null,
      source: "audio",
    });
  }
  out.sort((x, y) => x.idx - y.idx);

  // LRC: onde a prévia está na música = mediana(lrc - início) das linhas boas
  const good = out.filter((l) => l.confidence >= 70 && !l.cut && lines[l.idx].lrc !== null);
  let offset: number | null = null;
  if (good.length) {
    const d = good.map((l) => lines[l.idx].lrc! - l.start).sort((x, y) => x - y);
    offset = Math.round(d[Math.floor(d.length / 2)] * 100) / 100;
    for (const l of out) {
      const lrc = lines[l.idx].lrc;
      if (lrc === null) continue;
      l.lrcStart = Math.round((lrc - offset) * 100) / 100;
      const diff = Math.abs(l.lrcStart - l.start);
      // áudio e LRC concordam -> mais confiança; discordam muito -> menos
      if (diff <= 1) l.confidence = Math.min(100, l.confidence + 10);
      else if (diff > 3) l.confidence = Math.round(l.confidence * 0.7);
    }
    // linhas que o LRC põe dentro da prévia mas a transcrição não pegou
    for (const line of lines) {
      if (line.lrc === null || out.some((l) => l.idx === line.idx)) continue;
      const t = line.lrc - offset;
      if (t > 0.3 && t < 29.5) {
        out.push({ idx: line.idx, text: line.text, start: Math.round(t * 100) / 100, confidence: 0, cut: false, lrcStart: Math.round(t * 100) / 100, source: "lrc" });
      }
    }
    out.sort((x, y) => x.start - y.start || x.idx - y.idx);
  }
  return { words: n, offset, lines: out };
}

// ---------------------------------------------------------------------
// Modo "Continuar a letra": escolha da linha escondida
// ---------------------------------------------------------------------
export type ContLine = { text: string; start: number; end: number };
/** O que vai para npl_tracks.cont (tempos em segundos da prévia). */
export type ContinuePlan = { lines: ContLine[]; hidden: ContLine; after: ContLine[] };
export type ContinueVerdict = { ok: true; plan: ContinuePlan; offset: number } | { ok: false; reason: string };

const PREVIEW_SECS = 30;
const r2 = (x: number) => Math.round(x * 100) / 100;

/**
 * Decide se a música serve para o modo e qual linha esconder:
 *  - offset confiável: 2+ linhas ouvidas com confiança >= 70% e todas
 *    concordando (lrc - início) com a mediana em até 1 s;
 *  - todas as linhas da prévia usam os tempos do LRC (com o offset);
 *  - o trecho começa na 1ª linha COMPLETA da prévia e vai até a escondida;
 *  - linha escondida: pelo menos 8 s de música antes dela (desde o início do
 *    trecho) e 6 s depois do fim (para cantar junto), 4 a 12 palavras, até
 *    ~3,5 palavras/s, não é coro entre parênteses, onomatopeia nem o nome do
 *    artista, confiança >= 70%. Preferência: as que mais se repetem (refrão).
 */
const MIN_BEFORE = 8;
const MIN_AFTER = 6;

function decideContinue(lines: Line[], aligned: SyncLine[], artist: string): ContinueVerdict {
  if (!lines.length || lines.some((l) => l.lrc === null)) return { ok: false, reason: "sem letra sincronizada (LRC)" };
  const good = aligned.filter((l) => l.source === "audio" && !l.cut && l.confidence >= 70 && lines[l.idx]?.lrc !== null);
  if (good.length < 2) return { ok: false, reason: `poucas linhas ouvidas com confiança (${good.length})` };
  const d = good.map((l) => lines[l.idx].lrc! - l.start).sort((x, y) => x - y);
  const offset = d[Math.floor(d.length / 2)];
  const worst = Math.max(...d.map((x) => Math.abs(x - offset)));
  if (worst > 1) return { ok: false, reason: `linhas discordam do LRC em até ${worst.toFixed(1)} s` };

  // tempos de todas as linhas na prévia (pelo LRC)
  const at = lines.map((l, i) => {
    const start = l.lrc! - offset;
    const next = lines[i + 1]?.lrc;
    const end = next !== undefined && next !== null ? next - offset : start + Math.min(6, l.tokens.length * 0.45);
    return { start, end };
  });
  // 1ª linha completa (que começa dentro da prévia)
  const first = at.findIndex((t) => t.start >= 0.05);
  if (first < 0) return { ok: false, reason: "nenhuma linha completa na prévia" };
  const clipStart = at[first].start;

  const conf = new Map(aligned.filter((l) => l.source === "audio").map((l) => [l.idx, l.confidence]));
  // fim real do canto da linha: última palavra ouvida (ou estimativa), nunca depois da próxima linha
  const audioEnd = new Map(aligned.filter((l) => l.source === "audio" && l.sungEnd !== undefined).map((l) => [l.idx, l.sungEnd!]));
  const sungEnd = (i: number) =>
    Math.min(at[i].end, audioEnd.get(i) !== undefined && audioEnd.get(i)! > at[i].start ? audioEnd.get(i)! + 0.2 : at[i].start + lines[i].tokens.length * 0.45 + 0.5);
  const count = new Map<string, number>();
  for (const l of lines) count.set(l.tokens.join(" "), (count.get(l.tokens.join(" ")) ?? 0) + 1);
  const artistKey = fold(artist);

  const cands: { i: number; rep: number; same: boolean; conf: number }[] = [];
  const why = new Map<string, number>();
  const no = (r: string) => void why.set(r, (why.get(r) ?? 0) + 1);
  lines.forEach((l, i) => {
    if (i <= first) return;
    const { start } = at[i];
    const end = sungEnd(i);
    const words = l.tokens.length;
    const k = l.tokens.join(" ");
    if (start - clipStart < MIN_BEFORE) return no("pouca música antes");
    if (PREVIEW_SECS - end < MIN_AFTER) return no("pouca música depois");
    if (words < 4 || words > 12) return no("tamanho");
    if (words / Math.max(0.3, end - start) > 3.5) return no("rápida demais");
    if (/^\s*\(.*\)\s*$/.test(l.text)) return no("coro entre parênteses");
    if (l.tokens.every((w) => FILLER_RE.test(w))) return no("onomatopeia");
    if (artistKey && (k === artistKey || (k.includes(artistKey) && words <= artistKey.split(" ").length + 2))) return no("nome do artista");
    if ((conf.get(i) ?? 0) < 70) return no("confiança baixa");
    cands.push({ i, rep: count.get(k) ?? 1, same: lines[i - 1].tokens.join(" ") === k, conf: conf.get(i) ?? 0 });
  });
  if (!cands.length) {
    const top = [...why.entries()].sort((a, b) => b[1] - a[1]).map(([r]) => r).slice(0, 2).join(", ");
    return { ok: false, reason: `nenhuma linha serve${top ? ` (${top})` : ""}` };
  }
  // preferência: as que mais se repetem (refrão), depois diferente da anterior, depois confiança
  cands.sort((a, b) => b.rep - a.rep || Number(a.same) - Number(b.same) || b.conf - a.conf);
  const h = cands[0].i;
  const ctx: ContLine[] = [];
  for (let j = first; j < h; j++) ctx.push({ text: lines[j].text, start: r2(at[j].start), end: r2(at[j].end) });
  // as seguintes, até o fim da prévia (karaokê de "cantar junto")
  const after: ContLine[] = [];
  for (let j = h + 1; j < lines.length && at[j].start < PREVIEW_SECS - 0.3; j++) {
    after.push({ text: lines[j].text, start: r2(at[j].start), end: r2(Math.min(PREVIEW_SECS, at[j].end)) });
  }
  return {
    ok: true,
    offset: r2(offset),
    plan: {
      lines: ctx.slice(-12),
      hidden: { text: lines[h].text, start: r2(at[h].start), end: r2(Math.min(PREVIEW_SECS, sungEnd(h))) },
      after: after.slice(0, 12),
    },
  };
}

type Analysis = { lines: Line[]; aligned: SyncLine[]; result: SyncResult };

async function runAnalysis(t: { preview: string; titleShort: string; artist: string; duration?: number }): Promise<Analysis> {
  const [audioRes, lrc] = await Promise.all([
    fetch(t.preview, { cache: "no-store", signal: AbortSignal.timeout(15000) }),
    fetchLyricsRecord(t.titleShort, t.artist, t.duration).catch(() => null),
  ]);
  if (!audioRes.ok) throw new Error(`Prévia indisponível (${audioRes.status})`);
  if (!lrc) throw new Error("Sem letra na LRCLIB");
  const lines = lyricLines(lrc.plainLyrics, lrc.syncedLyrics);
  const g = await transcribe(await audioRes.arrayBuffer());
  const words = (g.words ?? []).filter((w) => typeof w.start === "number" && w.word?.trim());
  const r = align(words, lines);
  return {
    lines,
    aligned: r.lines,
    result: { language: g.language ?? null, transcript: (g.text ?? "").trim(), hasSynced: !!lrc.syncedLyrics?.trim(), ...r },
  };
}

/** /lab/sync: alinhamento + o que o modo "Continuar a letra" decidiria. */
export async function analyzeTrack(t: { preview: string; titleShort: string; artist: string; duration?: number }) {
  const a = await runAnalysis(t);
  return { ...a.result, continue: decideContinue(a.lines, a.aligned, t.artist) };
}

/** Preparação da partida: só o veredito (e o plano) do modo "Continuar a letra". */
export async function prepareContinue(t: { preview: string; titleShort: string; artist: string; duration?: number }): Promise<ContinueVerdict> {
  const a = await runAnalysis(t);
  if (!a.result.hasSynced) return { ok: false, reason: "sem letra sincronizada (LRC)" };
  return decideContinue(a.lines, a.aligned, t.artist);
}
