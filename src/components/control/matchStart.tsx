"use client";
import { useState } from "react";
import { Button } from "@/components/ui";
import { api, deezer } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import type { ModeId, PickedTrack, RoomState } from "@/lib/types";
import { enabledModes, modeSchedule } from "@/modes/schedule";

/** Músicas a mais sorteadas para a morte súbita (ficam de reserva no servidor). */
const TIEBREAK_RESERVE = 5;
/** "Continuar a letra": o Groq aceita 20 pedidos/minuto -> uma análise a cada 3,2 s. */
const CONTINUE_GAP_MS = 3200;

/** Falta de músicas para um modo que precisa de preparo. */
type Short = { mode: "lyrics" | "continue"; have: number; want: number };
type Prepared = {
  tracks: PickedTrack[];
  rounds: number;
  warnings: string[];
  short: Short[];
  /** só um modo ligado (e é esse que faltou): joga menos rodadas */
  only: boolean;
};
export type Progress = { label: string; done: number; total: number };

/**
 * Sorteia as músicas e monta o plano da partida: o modo de cada rodada segue a
 * "Ordem dos modos"; "Só pela letra" recebe só músicas com letra e
 * "Continuar a letra" só músicas analisadas (LRC + Groq) que deram certo — as
 * que não servem são trocadas por outras das mesmas fontes. Faltou: só esse
 * modo -> joga menos rodadas; misturado -> as rodadas que sobraram viram outros modos.
 */
async function prepareMatch(state: RoomState, onProgress: (p: Progress | null) => void): Promise<Prepared> {
  const s = state.room.settings;
  const modes = enabledModes(s);
  const extra = (s.tiebreak ?? "sudden") === "sudden" ? TIEBREAK_RESERVE : 0;
  const plan = modeSchedule(modes, s.modeOrder ?? "alternate", s.rounds);
  const wantL = plan.filter((m) => m === "lyrics").length;
  const wantC = plan.filter((m) => m === "continue").length;

  onProgress({ label: "Sorteando músicas…", done: 0, total: 0 });
  // "Continuar a letra" descarta algumas músicas: pede candidatas a mais
  // (no teste, ~40% das músicas servem: pede 2× + 5 candidatas a mais)
  const spares = wantC ? Math.min(30, wantC * 2 + 5) : 0;
  const { tracks: all, warnings: w } = await deezer.build(s.sources, s.rounds + extra + spares, s.versionFilter !== false, wantL);
  const withL = all.filter((t) => t.lyrics);
  const lyricPool = withL.slice(0, wantL);
  const rest = [...all.filter((t) => !t.lyrics), ...withL.slice(wantL)];

  // análise das candidatas do "Continuar a letra" (uma por vez, com intervalo)
  const contOk: PickedTrack[] = [];
  let last = 0;
  for (const t of rest) {
    if (contOk.length >= wantC) break;
    onProgress({ label: `Preparando “Continuar a letra”: ${t.title}`, done: contOk.length, total: wantC });
    const wait = last + CONTINUE_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    try {
      const v = await deezer.continuePlan(t.deezer_id);
      if (v.ok) contOk.push({ ...t, cont: v.plan });
    } catch {
      /* não serve: segue para a próxima */
    }
  }
  if (wantC) onProgress({ label: "Preparando músicas…", done: contOk.length, total: wantC });
  // as que viraram "continuar" saem das outras
  const usedC = new Set(contOk.map((t) => t.deezer_id));
  const otherPool = rest.filter((t) => !usedC.has(t.deezer_id));

  const haveL = Math.min(wantL, lyricPool.length);
  const haveC = contOk.length;
  const short: Short[] = [];
  if (haveL < wantL) short.push({ mode: "lyrics", have: haveL, want: wantL });
  if (haveC < wantC) short.push({ mode: "continue", have: haveC, want: wantC });
  const only = modes.length === 1 && short.length > 0;

  // rodadas que ficaram sem música preparada viram os outros modos ligados
  const fallback = modes.filter((m) => m !== "lyrics" && m !== "continue");
  let k = 0;
  let keepL = haveL;
  let keepC = haveC;
  let finalPlan: ModeId[] = plan.map((m) => {
    if (m === "lyrics" && keepL-- <= 0) return only ? m : (fallback[k++ % Math.max(1, fallback.length)] ?? "classic");
    if (m === "continue" && keepC-- <= 0) return only ? m : (fallback[k++ % Math.max(1, fallback.length)] ?? "classic");
    return m;
  });
  if (only) finalPlan = finalPlan.slice(0, modes[0] === "lyrics" ? haveL : haveC);

  // distribui as músicas pelas rodadas
  const lp = [...lyricPool];
  const cp = [...contOk];
  const op = [...otherPool];
  const ordered: PickedTrack[] = [];
  for (const m of finalPlan) {
    const t = m === "lyrics" ? lp.shift() : m === "continue" ? cp.shift() : (op.shift() ?? lp.shift());
    if (t) ordered.push({ ...t, mode: m });
  }
  // reservas (morte súbita, sempre clássico): o que sobrou, sem os dados dos modos
  const leftovers = [...op, ...lp, ...cp].slice(0, extra).map((t) => ({ ...t, cont: undefined }));
  const tracks = [...ordered, ...leftovers];

  onProgress(null);
  // o aviso de "poucas músicas" só interessa se faltou para as rodadas (não para as reservas)
  const warnings = w.filter((x) => !x.startsWith("Só encontrei") || all.length < s.rounds);
  return { tracks, rounds: ordered.length, warnings, short, only };
}

/**
 * Começar / revanche. Se faltou música preparada ("Só pela letra" ou
 * "Continuar a letra"), pergunta antes de começar.
 */
export function useMatchStarter(state: RoomState, code: string, token: string) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [short, setShort] = useState<Prepared | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);

  const begin = async (p: Prepared) => {
    await api.startMatch(code, token, p.tracks, p.rounds);
    if (p.warnings.length) setError(p.warnings.join(" "));
  };
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };
  const start = () =>
    run(async () => {
      const p = await prepareMatch(state, setProgress);
      if (p.short.length) setShort(p);
      else await begin(p);
    });
  const confirm = () =>
    short &&
    run(async () => {
      const p = short;
      setShort(null);
      await begin(p);
    });
  const backToConfig = () => {
    setShort(null);
    api.setPhase(code, token, "config").catch((e) => setError(friendlyError(e)));
  };
  return { busy, error, short, progress, start, confirm, backToConfig, dismiss: () => setShort(null) };
}

export type MatchStarter = ReturnType<typeof useMatchStarter>;

/** Barra de progresso da preparação ("Preparando músicas…"). */
export function PrepareProgress({ m, compact }: { m: MatchStarter; compact?: boolean }) {
  const p = m.progress;
  if (!p) return null;
  const pct = p.total ? Math.round((p.done / p.total) * 100) : null;
  return (
    <div className="flex w-full flex-col gap-2 rounded-2xl bg-black/30 p-4">
      <p className={`font-display ${compact ? "text-lg" : "text-2xl"}`}>
        ⏳ Preparando músicas…{p.total ? ` ${p.done}/${p.total}` : ""}
      </p>
      <div className="h-3 w-full overflow-hidden rounded-full bg-white/15">
        <div
          className={`h-full rounded-full bg-yellow-300 transition-all ${pct === null ? "w-1/3 animate-pulse" : ""}`}
          style={pct === null ? undefined : { width: `${Math.max(4, pct)}%` }}
        />
      </div>
      <p className="truncate text-sm text-white/60">{p.label}</p>
    </div>
  );
}

const SHORT_TEXT: Record<Short["mode"], (n: number) => string> = {
  lyrics: (n) => `Só encontramos ${n} música${n === 1 ? "" : "s"} com letra nessas playlists.`,
  continue: (n) => `Só ${n} música${n === 1 ? "" : "s"} servem para “Continuar a letra” (precisa de letra sincronizada e voz clara).`,
};

/** Aviso antes de começar quando faltou música preparada. */
export function LyricsShortNotice({ m, compact }: { m: MatchStarter; compact?: boolean }) {
  const p = m.short;
  if (!p?.short.length) return null;
  return (
    <div className="npl-pop flex w-full flex-col items-center gap-3 rounded-3xl border-2 border-yellow-300 bg-black/40 p-5 text-center">
      {p.short.map((x) => (
        <p key={x.mode} className={`font-display ${compact ? "text-xl" : "text-3xl"}`}>
          {x.mode === "lyrics" ? "📝" : "🎤"} {SHORT_TEXT[x.mode](x.have)}
        </p>
      ))}
      {!p.only && (
        <p className="text-white/70">As rodadas que faltaram viram rodadas dos outros modos ligados ({p.rounds} músicas no total).</p>
      )}
      <div className={`flex flex-wrap justify-center gap-3 ${compact ? "w-full flex-col" : ""}`}>
        <Button className={compact ? "text-xl py-3" : "text-2xl px-8 py-3"} disabled={m.busy || p.rounds === 0} onClick={m.confirm}>
          Jogar com {p.rounds} música{p.rounds === 1 ? "" : "s"}
        </Button>
        <Button variant="secondary" className="text-xl" onClick={m.backToConfig}>
          Trocar as playlists
        </Button>
      </div>
    </div>
  );
}
