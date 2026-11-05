import type { Round, StemName, StemsPlan, StemsState, StemsStatus, StemsVariant } from "@/lib/types";
import type { StemDefLike } from "./types";

/** Ordem das camadas (a voz fecha: é a música completa). */
export const STEM_ORDER: StemName[] = ["drums", "bass", "guitar", "vocals"];
export const STEM_LABEL: Record<StemName, string> = { drums: "Bateria", bass: "Baixo", guitar: "Guitarra", vocals: "Voz" };
export const STEM_EMOJI: Record<StemName, string> = { drums: "🥁", bass: "🎸", guitar: "🎸", vocals: "🎤" };
/** Camadas: pontos por instrumento que entra (espelhado em npl_stems_view). */
export const LAYER_POINTS: Record<StemName, number> = { drums: 100, bass: 75, guitar: 50, vocals: 20 };
/** Um instrumento só: trechos de 5/15/30 s valendo 100/60/30 (espelhado em npl_stems_view). */
export const SINGLE_STAGES: StemDefLike[] = [
  { seconds: 5, points: 100 },
  { seconds: 15, points: 60 },
  { seconds: 30, points: 30 },
];

/** Estado da rodada (null fora do Instrumentos ou antes de a rodada abrir). */
export function stemsOf(r: Round | null | undefined): StemsState | null {
  const s = r?.mode === "stems" ? r.stems : null;
  return s && typeof s.key === "string" && Array.isArray(s.points) ? (s as StemsState) : null;
}

/** Só a voz: vale o ARTISTA, com bônus (metade) pelo título. */
export const vocalsOnly = (r: Round | null | undefined) => {
  const s = stemsOf(r);
  return !!s && s.variant === "single" && s.instrument === "vocals";
};

/** Rótulo do estágio atual: "Bateria + Baixo" (camadas) ou "Baixo · 5s" (um só). */
export function stemsStageLabel(s: StemsState, stage: number) {
  if (s.variant === "single") return `${STEM_LABEL[s.instrument ?? "drums"]} · ${s.secs?.[stage - 1] ?? "?"}s`;
  return (s.layers ?? []).slice(0, Math.max(1, stage)).map((l) => STEM_LABEL[l]).join(" + ");
}

/** Endereço público de uma faixa no bucket (só leitura). */
export function stemUrl(key: string, name: StemName) {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  return `${base}/storage/v1/object/public/npl_stems/${key}/${name}.mp3`;
}

type Ready = StemsStatus["ready"][number];

/**
 * Plano da música: camadas sem a guitarra vazia (a voz sempre fecha) ou o
 * instrumento escolhido (se estiver vazio nesta música, sorteia outro audível).
 */
export function stemsPlan(r: Ready, variant: StemsVariant, instrument: StemName | "random"): StemsPlan {
  const audible = (n: StemName) => r.audible?.[n] !== false;
  if (variant === "layers") {
    // a guitarra pode faltar (funk, eletrônica); a bateria e o baixo também, em casos raros
    const layers = STEM_ORDER.filter((n) => n === "vocals" || audible(n));
    return { key: r.key, variant, layers };
  }
  const ok = STEM_ORDER.filter(audible);
  const pool = ok.length ? ok : STEM_ORDER;
  const pick = instrument !== "random" && audible(instrument) ? instrument : pool[Math.floor(Math.random() * pool.length)];
  return { key: r.key, variant, instrument: pick };
}

/** Tempo por música quando ainda não há histórico (separador na CPU). */
const FALLBACK_SECONDS = 60;

/**
 * Estimativa do tempo que falta para esvaziar a fila: média por música ×
 * pendentes, mais o que falta da atual. null quando não há nada na fila.
 * guessed = ainda sem histórico (usa ~1 min por música).
 */
export function stemsEta(g: StemsStatus["global"], now = Date.now()): { seconds: number; avg: number; guessed: boolean } | null {
  if (!g || g.pending + g.processing === 0) return null;
  const guessed = !g.avg_seconds;
  const avg = g.avg_seconds || FALLBACK_SECONDS;
  const elapsed = g.current_started_at ? (now - new Date(g.current_started_at).getTime()) / 1000 : 0;
  const current = g.processing > 0 ? Math.max(avg * 0.1, avg - elapsed) : 0;
  return { seconds: Math.round(g.pending * avg + current), avg, guessed };
}

/** 45 s · 3 min · 1 h 20 min */
export function fmtDuration(s: number) {
  if (s < 60) return `${Math.max(1, Math.round(s))} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
}
