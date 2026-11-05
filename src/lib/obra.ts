// "Qual é a obra?": pacotes temáticos já resolvidos para faixas do Deezer
// (data/pacotes-resolvidos.json, gerado por `npm run resolver-pacotes`).
// A partida só usa este arquivo: na hora de tocar, a TV pega o link atualizado
// da prévia pelo deezer_id, como nos outros modos.
import resolved from "../../data/pacotes-resolvidos.json";
import type { ObraPackId, PickedTrack, QuizPlan } from "./types";

type ResolvedItem = {
  obra: string;
  aceitas: string[];
  tipo?: string;
  deezer_id: number;
  title: string;
  title_short: string;
  artist: string;
  artists: string[];
  cover: string | null;
  album: string | null;
};
type ResolvedPack = { id: string; nome: string; emoji: string; itens: ResolvedItem[] };

const PACKS = (resolved as { pacotes: ResolvedPack[] }).pacotes;

/** Pacotes na ordem da configuração. */
export const OBRA_PACKS: { id: ObraPackId; label: string; emoji: string; count: number }[] = PACKS.map((p) => ({
  id: p.id as ObraPackId,
  label: p.nome,
  emoji: p.emoji,
  count: p.itens.length,
}));
export const ALL_OBRA_PACKS: ObraPackId[] = OBRA_PACKS.map((p) => p.id);

/** Pacotes ligados (nenhum = todos). */
export const obraPacksOf = (s: { obraPacks?: ObraPackId[] }) => (s.obraPacks?.length ? s.obraPacks : ALL_OBRA_PACKS);

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
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

/** Nomes aceitos: obra + alternativas + o nome principal antes de ":" ("Top Gun: Ases Indomáveis" -> "Top Gun"). */
function acceptOf(it: ResolvedItem) {
  const names = [it.obra, ...(it.aceitas ?? [])].flatMap((a) => (a.includes(":") ? [a, a.split(":")[0].trim()] : [a]));
  const seen = new Set<string>();
  return names.filter((a) => a && !seen.has(fold(a)) && seen.add(fold(a))).slice(0, 12);
}

/**
 * Sorteia até `n` músicas dos pacotes ligados, sem repetir obra (no Anime há
 * duas de Naruto Shippuden: entra no máximo uma) nem faixa já usada.
 */
export function pickObraTracks(packs: ObraPackId[], n: number, usedIds: Set<number> = new Set()): PickedTrack[] {
  const on = new Set(packs);
  const pool = shuffle(PACKS.filter((p) => on.has(p.id as ObraPackId)).flatMap((p) => p.itens.map((it) => ({ p, it }))));
  const seenWork = new Set<string>();
  const out: PickedTrack[] = [];
  for (const { p, it } of pool) {
    if (out.length >= n) break;
    const key = fold(it.obra);
    if (seenWork.has(key) || usedIds.has(it.deezer_id)) continue;
    seenWork.add(key);
    const quiz: QuizPlan = {
      kind: "obra",
      q: "Qual é a obra?",
      answer: it.obra,
      accept: acceptOf(it),
      pack: p.id as ObraPackId,
      emoji: p.emoji,
      ...(it.tipo === "abertura" || it.tipo === "tema" ? { tipo: it.tipo } : {}),
    };
    out.push({
      deezer_id: it.deezer_id,
      title: it.title,
      title_short: it.title_short,
      artist: it.artist,
      artists: it.artists?.length ? it.artists : [it.artist],
      cover: it.cover,
      album: it.album,
      mode: "obra",
      quiz,
    });
  }
  return out;
}
