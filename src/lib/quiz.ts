// Gerador das perguntas dos quizzes ("Quiz aberto" e "Quiz de alternativas").
// SÓ roda no servidor (rota /api/game/quiz): usa a API do Deezer e o banco de
// curiosidades (data/curiosidades.json).
import "server-only";
import bank from "../../data/curiosidades.json";
import {
  artistTopTrack,
  type DzArtist,
  type DzList,
  type DzTrack,
  VERSION_RE,
  albumVersionText,
  dzGet,
  fold,
  genreOf,
  getAlbum,
  getAuctionMeta,
  isCompilationAlbum,
  normTitle,
  shuffle,
} from "./deezer";
import type { MusicSource, PickedTrack, QuizKind, QuizPlan } from "./types";

export type QuizFormat = "open" | "choice";
export type QuizItem = PickedTrack & { format: QuizFormat };
export type QuizRequest = {
  items: QuizItem[];
  /** todas as músicas sorteadas para a partida (alternativas erradas, intrusa, "qual veio primeiro") */
  pool: PickedTrack[];
  sources: MusicSource[];
  curiosities: boolean;
  /** curiosidades usadas recentemente na sala (evitar repetir) */
  recent: string[];
  /** filtro de versões da sala (música de fundo das curiosidades) */
  versionFilter?: boolean;
};
export type QuizResult = { quiz: QuizPlan } | null;

type Trivia = {
  id: string;
  decada?: string;
  generos?: string[];
  artistas?: string[];
  pergunta: string;
  resposta: string;
  aceitas?: string[];
  erradas?: string[];
  formato?: "ambos" | "alternativas";
};
const TRIVIA: Trivia[] = ((bank as { perguntas?: Trivia[] }).perguntas ?? []).filter(
  (p) => p && p.id && p.pergunta && p.resposta && (p.erradas?.length ?? 0) >= 1,
);

/** Tipos que servem para cada formato (curiosidade é escolhida à parte). */
const KINDS: Record<QuizFormat, QuizKind[]> = {
  open: ["year", "album", "artist", "feat", "cover", "complete"],
  choice: ["year", "album", "artist", "feat", "top", "intruder", "older", "cover", "complete"],
};
/** Tipos que dependem de muitas consultas (pulados se o tempo apertar). */
const SLOW: QuizKind[] = ["year", "older", "album", "top", "intruder"];
/** Orçamento de tempo da rota (a Vercel corta em 60 s). */
const BUDGET_MS = 38000;

const STOP = new Set(
  (
    "o a os as um uma uns umas de do da dos das e em no na nos nas por pra pro para com que se sem ao aos " +
    "eu tu ele ela nos vos eles elas me te lhe meu minha seu sua teu tua mais mas nao sim so ja la ai ou " +
    "the a an of to in on and or my your me you i is it be at for by with from up we he she they his her our " +
    "el la los las y en mi tu te de lo un una del al es"
  ).split(" "),
);

const uniq = <T>(arr: T[], key: (x: T) => string) => {
  const seen = new Set<string>();
  return arr.filter((x) => {
    const k = key(x);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};
const pick = <T>(arr: T[]): T | undefined => arr[Math.floor(Math.random() * arr.length)];
/** Alternativas sorteadas: [certa, ...erradas] embaralhadas + índice da certa. */
function shuffleOptions(right: string, wrong: string[]) {
  const options = shuffle([right, ...wrong]);
  return { options, correct: options.indexOf(right) };
}
/** Tira sufixos de edição: "Álbum (Deluxe)" -> "Álbum", "Álbum - Remastered" -> "Álbum". */
const stripSuffix = (s: string) =>
  s
    .replace(/\s*[([].*?[)\]]\s*/g, " ")
    .replace(/\s[-–—]\s.*$/, "")
    .replace(/\s+/g, " ")
    .trim() || s.trim();
const sameName = (a: string, b: string) => fold(a) === fold(b);

/** Consultas com cache por requisição. */
function makeCache() {
  const track = new Map<number, Promise<DzTrack | null>>();
  const top = new Map<number, Promise<DzTrack[]>>();
  const albums = new Map<number, Promise<{ id: number; title?: string; record_type?: string }[]>>();
  const related = new Map<number, Promise<DzArtist[]>>();
  const years = new Map<number, Promise<number | null>>();
  return {
    track: (id: number) => {
      if (!track.has(id)) track.set(id, dzGet<DzTrack>(`/track/${id}`).catch(() => null));
      return track.get(id)!;
    },
    top: (artistId: number) => {
      if (!top.has(artistId))
        top.set(artistId, dzGet<DzList<DzTrack>>(`/artist/${artistId}/top?limit=50`).then((r) => r.data ?? []).catch(() => []));
      return top.get(artistId)!;
    },
    albums: (artistId: number) => {
      if (!albums.has(artistId))
        albums.set(
          artistId,
          dzGet<DzList<{ id: number; title?: string; record_type?: string }>>(`/artist/${artistId}/albums?limit=100`)
            .then((r) => r.data ?? [])
            .catch(() => []),
        );
      return albums.get(artistId)!;
    },
    related: (artistId: number) => {
      if (!related.has(artistId))
        related.set(artistId, dzGet<DzList<DzArtist>>(`/artist/${artistId}/related?limit=20`).then((r) => r.data ?? []).catch(() => []));
      return related.get(artistId)!;
    },
    /** ano corrigido (mesma lógica de regravações do Leilão); null = não confiável */
    year: (id: number) => {
      if (!years.has(id))
        years.set(
          id,
          Promise.race([
            getAuctionMeta(String(id)).then((m) => m.year),
            new Promise<null>((r) => setTimeout(() => r(null), 11000)),
          ]).catch(() => null),
        );
      return years.get(id)!;
    },
  };
}
type Cache = ReturnType<typeof makeCache>;

/** Contexto da partida: artistas e gêneros das fontes. */
type PoolArtist = { name: string; id: number | null; genre: string | null };

async function poolContext(req: QuizRequest) {
  const byName = new Map<string, PoolArtist>();
  for (const t of req.pool) {
    const k = fold(t.artist);
    if (k && !byName.has(k)) byName.set(k, { name: t.artist, id: t.artist_id ?? null, genre: null });
  }
  for (const s of req.sources) {
    if (s.type === "artist") {
      const k = fold(s.label);
      if (k && !byName.has(k)) byName.set(k, { name: s.label, id: Number(s.id) || null, genre: null });
    }
  }
  // gênero de um álbum por artista (no máximo 18 consultas)
  const firstAlbum = new Map<string, number>();
  for (const t of req.pool) {
    const k = fold(t.artist);
    if (t.album_id && !firstAlbum.has(k)) firstAlbum.set(k, t.album_id);
  }
  const entries = [...firstAlbum.entries()].slice(0, 18);
  for (let i = 0; i < entries.length; i += 6) {
    await Promise.all(
      entries.slice(i, i + 6).map(async ([k, albumId]) => {
        const a = await getAlbum(albumId);
        const p = byName.get(k);
        if (p) p.genre = genreOf(a);
      }),
    );
  }
  return { artists: [...byName.values()] };
}
type Ctx = Awaited<ReturnType<typeof poolContext>> & { cache: Cache; req: QuizRequest };

/** Artistas para alternativas erradas: das fontes (de preferência do mesmo gênero), depois relacionados. */
async function otherArtists(ctx: Ctx, exclude: string[], genre: string | null, artistId: number | null, n: number) {
  const ex = exclude.map(fold);
  const fromPool = shuffle(ctx.artists.filter((a) => !ex.includes(fold(a.name))));
  const same = fromPool.filter((a) => genre && a.genre && sameName(a.genre, genre));
  const rest = fromPool.filter((a) => !same.includes(a));
  let names = [...same, ...rest].map((a) => a.name);
  if (names.length < n && artistId) {
    const rel = await ctx.cache.related(artistId);
    names = [...names, ...shuffle(rel.map((r) => r.name).filter((x) => x && !ex.includes(fold(x))))];
  }
  return uniq(names, fold).slice(0, n);
}

/** Créditos da faixa: principal + participações (pela faixa completa do Deezer). */
async function credits(ctx: Ctx, t: PickedTrack) {
  const full = await ctx.cache.track(t.deezer_id);
  const names = [t.artist, ...(t.artists ?? []), ...(full?.contributors ?? []).map((c) => c.name)];
  return {
    full,
    all: uniq(names.filter(Boolean), fold),
    artistId: full?.artist?.id ?? t.artist_id ?? null,
    albumId: full?.album?.id ?? t.album_id ?? null,
  };
}

const titleOf = (t: { title_short?: string; title: string }) => stripSuffix(t.title_short ?? t.title);

// ---------------------------------------------------------------------
// Tipos de pergunta
// ---------------------------------------------------------------------
type Gen = (ctx: Ctx, t: PickedTrack, format: QuizFormat) => Promise<QuizPlan | null>;

const GENERATORS: Record<Exclude<QuizKind, "trivia" | "obra">, Gen> = {
  // "Em que ano saiu esta música?" — ano corrigido; erradas: anos próximos
  async year(ctx, t) {
    const year = await ctx.cache.year(t.deezer_id);
    if (!year) return null;
    const now = new Date().getFullYear();
    const near = shuffle([-6, -5, -4, -3, -2, -1, 1, 2, 3, 4, 5, 6])
      .map((d) => year + d)
      .filter((y) => y <= now && y >= 1900);
    const wrong = near.slice(0, 3).map(String);
    if (wrong.length < 3) return null;
    return { kind: "year", q: "Em que ano saiu esta música?", answer: String(year), accept: [String(year)], year, ...shuffleOptions(String(year), wrong) };
  },

  // "De qual álbum é esta música?" — erradas: outros álbuns de estúdio do artista
  async album(ctx, t, format) {
    const c = await credits(ctx, t);
    if (!c.albumId) return null;
    const album = await getAlbum(c.albumId);
    const name = album?.title ?? t.album;
    if (!album || !name || isCompilationAlbum(album)) return null;
    if (VERSION_RE.test(albumVersionText(name, ""))) return null; // ao vivo, acústico…
    const shown = stripSuffix(name);
    // single com o mesmo nome da música: a pergunta não faz sentido
    if (album.record_type !== "album" && normTitle(shown) === normTitle(titleOf(t))) return null;
    let wrong: string[] = [];
    if (format === "choice") {
      if (!c.artistId) return null;
      const list = await ctx.cache.albums(c.artistId);
      wrong = shuffle(
        uniq(
          list
            .filter((a) => a.record_type === "album" && a.title && !VERSION_RE.test(albumVersionText(a.title, "")))
            .map((a) => stripSuffix(a.title!))
            .filter((x) => normTitle(x) !== normTitle(shown)),
          normTitle,
        ),
      ).slice(0, 3);
      if (wrong.length < 3) return null;
    }
    return {
      kind: "album",
      q: "De qual álbum é esta música?",
      answer: shown,
      accept: uniq([shown, name], fold),
      ...(format === "choice" ? shuffleOptions(shown, wrong) : {}),
    };
  },

  // "Quem canta esta música?" — erradas: artistas das fontes, de preferência do mesmo gênero
  async artist(ctx, t, format) {
    const c = await credits(ctx, t);
    let wrong: string[] = [];
    if (format === "choice") {
      const album = c.albumId ? await getAlbum(c.albumId) : null;
      wrong = await otherArtists(ctx, c.all, genreOf(album), c.artistId, 3);
      if (wrong.length < 3) return null;
    }
    return {
      kind: "artist",
      q: "Quem canta esta música?",
      answer: t.artist,
      accept: c.all,
      artist_like: true,
      ...(format === "choice" ? shuffleOptions(t.artist, wrong) : {}),
    };
  },

  // "Quem participa desta música?" — só com mais de um artista creditado
  async feat(ctx, t, format) {
    const c = await credits(ctx, t);
    const guests = c.all.filter((n) => !sameName(n, t.artist));
    if (!guests.length) return null;
    const right = pick(guests)!;
    let wrong: string[] = [];
    if (format === "choice") {
      wrong = await otherArtists(ctx, c.all, null, c.artistId, 3);
      if (wrong.length < 3) return null;
    }
    return {
      kind: "feat",
      q: "Quem participa desta música?",
      answer: guests.join(", "),
      accept: guests,
      artist_like: true,
      ...(format === "choice" ? shuffleOptions(right, wrong) : {}),
    };
  },

  // "Qual destas é a mais ouvida de [artista]?" — top do Deezer x bem menos populares
  async top(ctx, t) {
    const c = await credits(ctx, t);
    if (!c.artistId) return null;
    const list = uniq(
      (await ctx.cache.top(c.artistId)).filter((x) => x.artist?.id === c.artistId && !VERSION_RE.test(titleOf(x))),
      (x) => normTitle(titleOf(x)),
    );
    if (list.length < 25) return null;
    const self = normTitle(titleOf(t));
    const right = list.slice(0, 3).find((x) => normTitle(titleOf(x)) !== self);
    const wrong = shuffle(list.slice(20).filter((x) => normTitle(titleOf(x)) !== self)).slice(0, 3);
    if (!right || wrong.length < 3) return null;
    return {
      kind: "top",
      q: `Qual destas é a mais ouvida de ${t.artist}?`,
      answer: titleOf(right),
      ...shuffleOptions(titleOf(right), wrong.map(titleOf)),
    };
  },

  // "Qual destas NÃO é de [artista]?" — 3 do artista + 1 de outro artista das fontes (mesmo gênero)
  async intruder(ctx, t) {
    const c = await credits(ctx, t);
    if (!c.artistId) return null;
    const own = uniq(
      (await ctx.cache.top(c.artistId)).filter((x) => x.artist?.id === c.artistId && !VERSION_RE.test(titleOf(x))),
      (x) => normTitle(titleOf(x)),
    );
    const self = normTitle(titleOf(t));
    const three = shuffle(own.slice(0, 20).filter((x) => normTitle(titleOf(x)) !== self)).slice(0, 3);
    if (three.length < 3) return null;
    const ownTitles = new Set(own.map((x) => normTitle(titleOf(x))));
    const album = c.albumId ? await getAlbum(c.albumId) : null;
    const genre = genreOf(album);
    // de preferência uma música que não toca em outra rodada
    const inItems = new Set(ctx.req.items.map((x) => x.deezer_id));
    const others = shuffle(ctx.req.pool.filter((x) => !c.all.some((n) => sameName(n, x.artist)) && !ownTitles.has(normTitle(titleOf(x))))).sort(
      (a, b) => Number(inItems.has(a.deezer_id)) - Number(inItems.has(b.deezer_id)),
    );
    const sameGenre = others.filter((x) => {
      const g = ctx.artists.find((a) => sameName(a.name, x.artist))?.genre;
      return genre && g && sameName(g, genre);
    });
    let intruder = sameGenre[0] ? titleOf(sameGenre[0]) : others[0] ? titleOf(others[0]) : null;
    if (!intruder) {
      // fontes de um artista só: música de um artista relacionado
      const rel = (await ctx.cache.related(c.artistId))[0];
      const relTop = rel ? (await ctx.cache.top(rel.id)).find((x) => !ownTitles.has(normTitle(titleOf(x)))) : null;
      intruder = relTop ? titleOf(relTop) : null;
    }
    if (!intruder) return null;
    return {
      kind: "intruder",
      q: `Qual destas NÃO é de ${t.artist}?`,
      answer: intruder,
      ...shuffleOptions(intruder, three.map(titleOf)),
    };
  },

  // "Qual foi lançada antes?" — 2 alternativas, anos confiáveis com 2+ anos de diferença
  async older(ctx, t) {
    const mine = await ctx.cache.year(t.deezer_id);
    if (!mine) return null;
    const others = shuffle(ctx.req.pool.filter((x) => x.deezer_id !== t.deezer_id && !sameName(x.artist, t.artist))).slice(0, 4);
    for (const o of others) {
      const y = await ctx.cache.year(o.deezer_id);
      if (!y || Math.abs(y - mine) < 2) continue;
      const a = `${titleOf(t)} — ${t.artist}`;
      const b = `${titleOf(o)} — ${o.artist}`;
      const right = y < mine ? b : a;
      return { kind: "older", q: "Qual foi lançada antes?", answer: right, ...shuffleOptions(right, [right === a ? b : a]) };
    }
    return null;
  },

  // Capa desfocada: "De qual artista é este álbum?" (a prévia não toca)
  async cover(ctx, t, format) {
    if (!t.cover) return null;
    const c = await credits(ctx, t);
    const album = c.albumId ? await getAlbum(c.albumId) : null;
    if (isCompilationAlbum(album)) return null;
    let wrong: string[] = [];
    if (format === "choice") {
      wrong = await otherArtists(ctx, c.all, genreOf(album), c.artistId, 3);
      if (wrong.length < 3) return null;
    }
    return {
      kind: "cover",
      q: "De qual artista é este álbum?",
      answer: t.artist,
      accept: c.all,
      artist_like: true,
      cover: t.cover,
      play: false,
      ...(format === "choice" ? shuffleOptions(t.artist, wrong) : {}),
    };
  },

  // "Complete o título desta música": uma palavra significativa vira "___"
  async complete(ctx, t, format) {
    const title = titleOf(t);
    const words = title.split(/\s+/);
    if (words.length < 2) return null;
    const cands = words
      .map((w, i) => ({ i, w, core: w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "") }))
      .filter((x) => x.core.length >= 3 && !STOP.has(fold(x.core)) && !/^\d+$/.test(x.core));
    if (!cands.length) return null;
    // de preferência as palavras mais longas
    const chosen = pick(cands.sort((a, b) => b.core.length - a.core.length).slice(0, 3))!;
    const masked = words.map((w, i) => (i === chosen.i ? w.replace(chosen.core, "___") : w)).join(" ");
    let wrong: string[] = [];
    if (format === "choice") {
      const lower = chosen.core === chosen.core.toLowerCase();
      const fromPool = ctx.req.pool
        .filter((x) => x.deezer_id !== t.deezer_id)
        .flatMap((x) => titleOf(x).split(/\s+/))
        .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
        .filter((w) => w.length >= 3 && !STOP.has(fold(w)) && !/^\d+$/.test(w) && fold(w) !== fold(chosen.core));
      const spare = ["Amor", "Coração", "Saudade", "Noite", "Tempo", "Vida", "Sonho", "Paixão", "Mundo", "Estrela", "Fogo", "Lua"];
      const fit = (w: string) => (lower ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase());
      wrong = uniq(
        [...shuffle(fromPool), ...shuffle(spare)].filter((w) => fold(w) !== fold(chosen.core)).map(fit),
        fold,
      ).slice(0, 3);
      if (wrong.length < 3) return null;
    }
    return {
      kind: "complete",
      q: "Complete o título desta música",
      answer: chosen.core,
      accept: [chosen.core],
      masked,
      ...(format === "choice" ? shuffleOptions(chosen.core, wrong) : {}),
    };
  },
};

// ---------------------------------------------------------------------
// Curiosidades
// ---------------------------------------------------------------------
/** Década das músicas (só as que já têm ano calculado) e gêneros das fontes. */
function matchProfile(ctx: Ctx, yearsKnown: number[]) {
  const decades = new Set(yearsKnown.map((y) => String(Math.floor((y % 100) / 10) * 10).padStart(2, "0")));
  const genres = ctx.artists.map((a) => a.genre).filter(Boolean).map((g) => fold(g!));
  return { decades, genres };
}

function chooseTrivia(ctx: Ctx, format: QuizFormat, used: Set<string>, profile: ReturnType<typeof matchProfile>) {
  const poolNames = ctx.artists.map((a) => fold(a.name));
  const recent = new Set(ctx.req.recent);
  const scored = TRIVIA.filter((p) => !used.has(p.id) && (format === "choice" || p.formato !== "alternativas")).map((p) => {
    const byArtist = (p.artistas ?? []).some((a) => poolNames.includes(fold(a)));
    const byDecade = !!p.decada && profile.decades.has(p.decada);
    const byGenre = (p.generos ?? []).some((g) => profile.genres.some((x) => x.includes(fold(g)) || fold(g).includes(x)));
    const score = (byArtist ? 4 : byDecade || byGenre ? 2 : 1) - (recent.has(p.id) ? 3 : 0) + Math.random() * 0.5;
    return { p, score };
  });
  return scored.sort((a, b) => b.score - a.score)[0]?.p ?? null;
}

/**
 * Curiosidade. Música só se for relacionada (de um dos artistas da pergunta);
 * sem música relacionada: play = false + hide_song = true (nada toca, nem na revelação).
 */
function triviaPlan(ctx: Ctx, p: Trivia, t: PickedTrack, format: QuizFormat): QuizPlan {
  const related = isRelated(p, t);
  const wrong = shuffle(p.erradas ?? []).slice(0, 3);
  return {
    kind: "trivia",
    q: p.pergunta,
    answer: p.resposta,
    accept: p.aceitas?.length ? p.aceitas : [p.resposta],
    trivia_id: p.id,
    ...(related ? {} : { play: false, hide_song: true }),
    ...(format === "choice" ? shuffleOptions(p.resposta, wrong) : {}),
  };
}

/** A música é de um dos artistas da pergunta? */
const isRelated = (p: Trivia, t: PickedTrack) =>
  (p.artistas ?? []).some((a) => sameName(a, t.artist) || (t.artists ?? []).some((x) => sameName(a, x)));

/**
 * Para curiosidades: troca a música da rodada por uma do artista relacionado,
 * se houver uma nas músicas sorteadas que não está em outra rodada.
 */
function relatedTrack(p: Trivia, spares: PickedTrack[]) {
  return spares.find((x) => isRelated(p, x));
}

/** Sem faixa do artista nas fontes: a mais popular dele no Deezer (top do artista). */
async function relatedTop(p: Trivia, versionFilter: boolean, exclude: Set<number>) {
  for (const name of shuffle([...(p.artistas ?? [])]).slice(0, 3)) {
    const t = await artistTopTrack(name, versionFilter, exclude).catch(() => null);
    if (t) return t;
  }
  return null;
}

// ---------------------------------------------------------------------
// Montagem
// ---------------------------------------------------------------------
/**
 * Uma pergunta por item (rodada de quiz), variando os tipos (nunca o mesmo
 * duas vezes seguidas, se der). Cerca de 1 a cada 4 é curiosidade. Item sem
 * pergunta possível -> null (a rodada vira outro modo).
 * `track` no resultado: a rodada passa a tocar outra música (curiosidade de
 * um artista que está nas fontes).
 */
export async function buildQuiz(req: QuizRequest): Promise<{ results: (({ quiz: QuizPlan; track?: PickedTrack }) | null)[] }> {
  const t0 = Date.now();
  const cache = makeCache();
  const ctx: Ctx = { ...(await poolContext(req)), cache, req };
  const n = req.items.length;
  const results: ({ quiz: QuizPlan; track?: PickedTrack } | null)[] = Array(n).fill(null);

  // quais rodadas são de curiosidade (~1 a cada 4, espalhadas)
  const triviaIdx = new Set<number>();
  if (req.curiosities && TRIVIA.length) {
    const want = Math.round(n / 4);
    const offset = Math.floor(Math.random() * 4);
    for (let i = offset; i < n && triviaIdx.size < want; i += 4) triviaIdx.add(i);
    for (const i of shuffle([...Array(n).keys()])) if (triviaIdx.size < want) triviaIdx.add(i);
  }

  const counts = new Map<QuizKind, number>();
  let prev: QuizKind | null = null;
  const usedTrivia = new Set<string>();
  const inMatch = new Set(req.items.map((x) => x.deezer_id));
  const spares = req.pool.filter((x) => !inMatch.has(x.deezer_id));
  const knownYears: number[] = [];

  for (let i = 0; i < n; i++) {
    const item = req.items[i];
    const { format, ...track } = item;
    if (triviaIdx.has(i)) {
      const p = chooseTrivia(ctx, format, usedTrivia, matchProfile(ctx, knownYears));
      if (p) {
        usedTrivia.add(p.id);
        // música só se for relacionada: a da rodada (se for do artista), uma dele das
        // fontes da partida ou, se não houver, a mais popular dele no Deezer
        let swap = relatedTrack(p, [track]) ? undefined : relatedTrack(p, spares);
        if (swap) spares.splice(spares.indexOf(swap), 1);
        else if (!relatedTrack(p, [track]) && (p.artistas ?? []).length) {
          swap = (await relatedTop(p, ctx.req.versionFilter !== false, inMatch)) ?? undefined;
          if (swap) inMatch.add(swap.deezer_id);
        }
        const t = swap ?? track;
        results[i] = { quiz: { ...triviaPlan(ctx, p, t, format), open: format === "open" }, ...(swap ? { track: swap } : {}) };
        counts.set("trivia", (counts.get("trivia") ?? 0) + 1);
        prev = "trivia";
        continue;
      }
    }
    const late = Date.now() - t0 > BUDGET_MS;
    const order = shuffle(KINDS[format])
      .filter((k) => !(late && SLOW.includes(k)))
      .sort((a, b) => (counts.get(a) ?? 0) - (counts.get(b) ?? 0));
    // evita o mesmo tipo duas vezes seguidas (fica por último)
    const tries = [...order.filter((k) => k !== prev), ...order.filter((k) => k === prev)];
    for (const kind of tries) {
      if (Date.now() - t0 > BUDGET_MS + 8000 && SLOW.includes(kind)) continue;
      let plan: QuizPlan | null = null;
      try {
        plan = await GENERATORS[kind as Exclude<QuizKind, "trivia" | "obra">](ctx, track, format);
      } catch {
        plan = null;
      }
      if (!plan) continue;
      if (format === "choice" && !(plan.options && plan.options.length >= 2)) continue;
      results[i] = { quiz: { ...plan, open: format === "open" } };
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
      prev = kind;
      if (plan.year) knownYears.push(plan.year);
      break;
    }
  }
  return { results };
}

