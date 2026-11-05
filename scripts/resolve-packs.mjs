// Resolve os pacotes do modo "Qual é a obra?" (data/pacotes.json) para faixas
// do Deezer com prévia e grava data/pacotes-resolvidos.json (o jogo só usa este).
//
// Uso: npm run resolver-pacotes
//
// Para cada item:
//  1. busca track:"música" artist:"artista" (e depois "música artista");
//  2. escolhe o resultado com título e artista batendo (após normalização),
//     com prévia e que não seja outra versão (ao vivo, karaokê, cover…);
//  3. se não achar, tenta a busca_alternativa (quando ela pede a versão
//     brasileira, covers/versões são aceitos).
// No fim, mostra um relatório por pacote e a lista dos NÃO encontrados.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const SRC = join(root, "data", "pacotes.json");
const OUT = join(root, "data", "pacotes-resolvidos.json");
const API = "https://api.deezer.com";

// ---- normalização (a mesma ideia de src/lib/deezer.ts) ----
const fold = (s) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
/** Título sem parênteses/colchetes e sem " - complemento". */
const normTitle = (s) =>
  fold(
    String(s ?? "")
      .replace(/\(.*?\)|\[.*?\]/g, "")
      .replace(/\s+[-–—]\s+.*$/, ""),
  );

// ---- filtro de versões (copiado de src/lib/deezer.ts) ----
const VERSION_WORDS_RE =
  /\b(ao vivo|live|acustico|acoustic|unplugged|remix|mix|karaoke|instrumental|cover|tributo|tribute|versao|version|regravacao|re ?recorded|sped up|slowed)\b/;
const SAME_RECORDING_RE =
  /\b(deluxe|super deluxe|international|expanded|bonus tracks?|special|standard|explicit|clean|edited|album|original|single|radio|anniversary|soundtrack|film|movie|extended|remaster\w*)( edition)? (version|versao)\b|\b(versao|version) (remaster\w*|original|do album|deluxe)\b/g;
function titleVersionText(t) {
  const title = t.title ?? "";
  const bits = [...title.matchAll(/\(([^)]*)\)|\[([^\]]*)\]/g)].map((m) => m[1] ?? m[2] ?? "");
  const dash = title.match(/\s[-–—]\s(.*)$/);
  if (dash) bits.push(dash[1]);
  if (t.title_version) bits.push(t.title_version);
  return fold(bits.join(" "));
}
function albumVersionText(albumTitle, trackTitle) {
  const a = fold(albumTitle ?? "");
  const t = fold(trackTitle);
  return t && a.startsWith(t) ? a.slice(t.length) : a;
}
const isOtherVersion = (t) =>
  VERSION_WORDS_RE.test(`${titleVersionText(t)} | ${albumVersionText(t.album?.title, t.title_short ?? t.title)}`.replace(SAME_RECORDING_RE, " "));

// ---- Deezer ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function search(q) {
  for (let tries = 0; tries < 4; tries++) {
    const res = await fetch(`${API}/search?q=${encodeURIComponent(q)}&limit=25`, { signal: AbortSignal.timeout(15000) }).catch(() => null);
    if (res?.ok) {
      const j = await res.json();
      if (!j.error) return j.data ?? [];
      if (j.error.code !== 4) return []; // 4 = muitas requisições: espera e tenta de novo
    }
    await sleep(1500 * (tries + 1));
  }
  return [];
}

/** Sem espaços: "Ikimono-gakari" = "Ikimonogakari", "Butter-Fly" = "Butterfly". */
const compact = (s) => fold(s).replace(/ /g, "");
/** Distância de edição (para "Sukwinder" x "Sukhwinder"). */
function edits(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
const close = (a, b) => a === b || (Math.min(a.length, b.length) >= 8 && edits(a, b) <= 2);
/** Título em outra escrita (japonês, chinês…): nada de letras latinas depois de normalizar. */
const nonLatin = (s) => !normTitle(s);

const artistNames = (t) => [t.artist?.name, ...(t.contributors ?? []).map((c) => c.name)].filter(Boolean);
/** "Bill Medley & Jennifer Warnes" -> os dois nomes. */
// " e " e " x " só com espaços dos dois lados ("Samuel E. Wright" não divide)
const artistParts = (wanted) =>
  String(wanted)
    .split(/\s*(?:&|,|\s+e\s+|\s+and\s+|feat\.?|ft\.?|\s+x\s+|\/)\s*/i)
    .map((p) => p.trim())
    .filter((p) => fold(p).length >= 2);
/**
 * Os títulos batem? Igual, quase igual, ou um é o começo/fim do outro em
 * palavras inteiras ("Superman" x "Superman Theme"; mas "Flying" x "The Flying Car" não).
 */
function titleMatches(found, wanted) {
  const a = compact(normTitle(found));
  const b = compact(normTitle(wanted));
  if (!a || !b) return false;
  if (close(a, b)) return true;
  const wa = normTitle(found).split(" ");
  const wb = normTitle(wanted).split(" ");
  const [short, long] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  if (short.join("").length < 4) return false;
  const head = long.slice(0, short.length).join(" ") === short.join(" ");
  const tail = long.slice(long.length - short.length).join(" ") === short.join(" ");
  // também começo/fim sem espaços ("JOJO SONO CHINO SADAME" x "Sono Chi no Sadame")
  return head || tail || (b.length >= 8 && (a.startsWith(b) || a.endsWith(b))) || (a.length >= 8 && (b.startsWith(a) || b.endsWith(a)));
}
/** Nomes artísticos com outro nome no Deezer. */
const ARTIST_ALIASES = { "tom jobim": ["antonio carlos jobim"] };
/** Algum artista bate? ("Bill Medley & Jennifer Warnes" vale com qualquer um dos dois) */
function artistMatches(t, wanted) {
  // o nome inteiro também conta ("JUDY AND MARY" é uma banda, não duas pessoas)
  const parts = [wanted, ...artistParts(wanted)].flatMap((p) => [p, ...(ARTIST_ALIASES[fold(p)] ?? [])]);
  const names = artistNames(t);
  return parts.some((p) =>
    names.some((name) => {
      // sem "and"/"e"/"&" ("JUDY AND MARY" = "Judy & Mary")
      const n = compact(name.replace(/\s(?:and|e|&)\s/gi, " "));
      const c = compact(p.replace(/\s(?:and|e|&)\s/gi, " "));
      // contém: só se a parte que sobra for pequena ("Audrey" não vale por "Audrey Hepburn")
      const contains = (x, y) => y.length >= 4 && x.includes(y) && y.length >= 0.6 * x.length;
      if (close(n, c) || contains(n, c) || contains(c, n)) return true;
      // "Joe Esposito" x "Joe "Bean" Esposito": todas as palavras do nome procurado aparecem
      const words = new Set(fold(name).split(" "));
      const want = fold(p).split(" ");
      return want.length >= 2 && want.every((w) => words.has(w));
    }),
  );
}
const playable = (t) => !!t.preview && t.readable !== false;

const BR_RE = /vers[aã]o brasileira|em portugu[eê]s|dublad/i;
/** Texto da busca_alternativa sem as observações entre parênteses. */
const altQuery = (alt) =>
  String(alt)
    .replace(/\(.*?\)/g, " ")
    .replace(/vers[aã]o brasileira|vers[aã]o do remake[^)]*/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Tentativa principal: música + artista. */
async function findMain(item) {
  const first = artistParts(item.artista)[0] ?? item.artista;
  const queries = [
    `track:"${item.musica}" artist:"${item.artista}"`,
    `${normTitle(item.musica)} ${fold(item.artista)}`,
    `${normTitle(item.musica)} ${fold(first)}`,
  ];
  // "Main Title (Star Wars)": o que está entre parênteses tem que aparecer (senão vira o de "Jaws")
  // (só barra quando o resultado tem os próprios parênteses com outra coisa, como "Theme From Jaws";
  //  "Bang Bang" sem "(My Baby Shot Me Down)" ou com "(2004 Remaster)" passa)
  const must = [...String(item.musica).matchAll(/\(([^)]*)\)/g)].map((m) => compact(m[1])).filter((k) => k.length >= 3);
  const NEUTRAL = new Set(["remaster", "remastered", "from", "the", "theme", "original", "soundtrack", "version", "mono", "stereo", "edit", "single", "motion", "picture", "score", "main", "title", "extended", "film", "movie", "ost"]);
  // título genérico ("Main Title", "Theme"…): o complemento entre parênteses é obrigatório
  const generic = /^(main title|main theme|theme|end title|opening|title)$/.test(normTitle(item.musica));
  const conflicts = (t) => {
    if (!must.length) return false;
    const text = compact(`${t.title} ${t.album?.title ?? ""}`);
    if (must.every((k) => text.includes(k))) return false;
    if (generic) return true;
    const own = [...String(t.title).matchAll(/\(([^)]*)\)|\[([^\]]*)\]/g)].flatMap((m) => fold(m[1] ?? m[2] ?? "").split(" "));
    return own.some((w) => w && !NEUTRAL.has(w) && !/^\d+$/.test(w));
  };
  const names = [item.obra, ...(item.aceitas ?? [])].map(compact).filter((k) => k.length >= 3);
  /** Menor = melhor: a trilha do filme/anime primeiro, depois o título com menos "extras" (remix, edit…). */
  const rank = (t) => {
    const text = compact(`${t.title} ${t.album?.title ?? ""}`);
    const fromWork = names.some((n) => text.includes(n)) ? 0 : 1;
    const extra = compact(t.title).length - compact(normTitle(item.musica)).length;
    const reprise = /reprise/i.test(t.title) ? 500 : 0;
    return fromWork * 1000 + reprise + Math.max(0, extra);
  };
  for (const q of queries) {
    const rows = await search(q);
    const ok = rows.filter(
      (t) =>
        playable(t) &&
        !isOtherVersion(t) &&
        titleMatches(t.title_short ?? t.title, item.musica) &&
        artistMatches(t, item.artista) &&
        !conflicts(t),
    );
    if (ok.length) return { track: [...ok].sort((a, b) => rank(a) - rank(b))[0], query: q };
    await sleep(150);
  }
  // título em japonês etc. no Deezer ("アイドル"): o artista bate e a busca cita a música/obra
  for (const q of [`${normTitle(item.musica)} ${fold(first)}`, `${fold(first)} ${fold(item.obra)}`]) {
    const rows = await search(q);
    const ok = rows.filter((t) => playable(t) && !isOtherVersion(t) && nonLatin(t.title_short ?? t.title) && artistMatches(t, item.artista));
    if (ok.length) return { track: ok[0], query: q, script: true };
    await sleep(150);
  }
  return null;
}

/** busca_alternativa: texto livre. Versão brasileira aceita covers/versões. */
async function findAlt(item) {
  const alt = item.busca_alternativa;
  if (!alt) return null;
  const br = BR_RE.test(alt);
  const q = altQuery(alt);
  const inParens = [...String(alt).matchAll(/\(([^)]*)\)/g)].map((m) => m[1]);
  // palavras que identificam a faixa certa: a obra, o texto da busca e o que está entre parênteses
  const keys = [item.obra, ...(item.aceitas ?? []), q, ...inParens, item.musica].map(fold).filter((k) => k.length >= 4);
  const words = new Set(keys.flatMap((k) => k.split(" ")).filter((w) => w.length >= 4 && !["versao", "brasileira", "tema", "abertura", "remake"].includes(w)));
  const tries = [q, `${q} ${item.obra}`];
  for (const query of tries) {
    const rows = await search(query);
    const ok = rows.filter((t) => {
      if (!playable(t)) return false;
      if (!br && isOtherVersion(t)) return false;
      const text = fold(`${t.title} ${t.album?.title ?? ""} ${artistNames(t).join(" ")}`);
      const hits = [...words].filter((w) => text.includes(w)).length;
      // pelo menos duas palavras-chave (ou uma, se só houver uma)
      return hits >= Math.min(2, words.size);
    });
    if (ok.length) return { track: ok[0], query, br };
    await sleep(150);
  }
  return null;
}

/** Aceitas: obra + nomes alternativos + o nome principal antes de ":" ("Top Gun: Ases Indomáveis" -> "Top Gun"). */
function acceptList(item) {
  const all = [item.obra, ...(item.aceitas ?? [])];
  const withMain = all.flatMap((a) => (a.includes(":") ? [a, a.split(":")[0].trim()] : [a]));
  const seen = new Set();
  return withMain.filter((a) => a && !seen.has(fold(a)) && seen.add(fold(a)));
}

const data = JSON.parse(readFileSync(SRC, "utf8"));
const out = { versao: 1, gerado_em: new Date().toISOString(), pacotes: [] };
const missing = [];
const viaAlt = [];
const summary = [];

for (const pack of data.pacotes) {
  const items = [];
  for (const item of pack.itens) {
    let r = await findMain(item);
    let via = "principal";
    if (!r) {
      r = await findAlt(item);
      via = "alternativa";
    }
    if (!r) {
      missing.push({ pacote: pack.nome, obra: item.obra, buscas: [`${item.musica} — ${item.artista}`, item.busca_alternativa].filter(Boolean) });
      process.stdout.write("✗");
      continue;
    }
    process.stdout.write(via === "principal" ? "." : "a");
    const t = r.track;
    if (r.script) viaAlt.push({ pacote: pack.nome, obra: item.obra, achou: `${t.title} — ${t.artist?.name}`, busca: `${r.query} (título em outra escrita)` });
    if (via === "alternativa") viaAlt.push({ pacote: pack.nome, obra: item.obra, achou: `${t.title} — ${t.artist?.name}`, busca: r.query });
    items.push({
      obra: item.obra,
      aceitas: acceptList(item),
      ...(item.tipo ? { tipo: item.tipo } : {}),
      musica: item.musica,
      artista: item.artista,
      via,
      deezer_id: t.id,
      title: t.title,
      title_short: t.title_short ?? t.title,
      artist: t.artist?.name ?? item.artista,
      artists: [...new Set(artistNames(t))],
      cover: t.album?.cover_big ?? t.album?.cover_medium ?? null,
      album: t.album?.title ?? null,
    });
    await sleep(120);
  }
  out.pacotes.push({ id: pack.id, nome: pack.nome, emoji: pack.emoji, itens: items });
  summary.push(`${pack.emoji} ${pack.nome}: ${items.length}/${pack.itens.length} resolvidos`);
}

writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
console.log("\n\n=== Relatório ===");
for (const s of summary) console.log(s);
if (viaAlt.length) {
  console.log(`\nResolvidos pela busca alternativa ou com título em outra escrita (${viaAlt.length}) — confira se é a versão certa:`);
  for (const v of viaAlt) console.log(`  ${v.pacote} · ${v.obra}: ${v.achou}   [busca: ${v.busca}]`);
}
if (missing.length) {
  console.log(`\nNÃO encontrados (${missing.length}):`);
  for (const m of missing) console.log(`  ${m.pacote} · ${m.obra}: ${m.buscas.join("  |  ")}`);
} else {
  console.log("\nTodos os itens foram encontrados.");
}
console.log(`\nGravado em data/pacotes-resolvidos.json`);
