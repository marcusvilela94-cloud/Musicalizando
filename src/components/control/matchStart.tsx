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
  /** rodadas de "Continuar a letra" que serão preparadas depois de começar */
  background: { positions: number[]; candidates: PickedTrack[] } | null;
};
export type Progress = { label: string; done: number; total: number };

/**
 * Sorteia as músicas e monta o plano da partida: o modo de cada rodada segue a
 * "Ordem dos modos"; "Só pela letra" recebe só músicas com letra e
 * "Continuar a letra" só músicas analisadas (LRC + Groq) que deram certo.
 *  - O cache da análise (npl_sync_cache) vem primeiro: as já analisadas não
 *    passam pelo Groq.
 *  - Só "Continuar a letra" ligado: prepara tudo antes de começar.
 *  - Misturado: começa com as que já estão prontas (cache); as outras rodadas
 *    desse modo vão para mais adiante e são preparadas em segundo plano
 *    (se não ficarem prontas a tempo, viram outro modo ligado).
 */
async function prepareMatch(state: RoomState, code: string, token: string, onProgress: (p: Progress | null) => void): Promise<Prepared> {
  const s = state.room.settings;
  const modes = enabledModes(s);
  const extra = (s.tiebreak ?? "sudden") === "sudden" ? TIEBREAK_RESERVE : 0;
  let plan = modeSchedule(modes, s.modeOrder ?? "alternate", s.rounds);
  const wantL = plan.filter((m) => m === "lyrics").length;
  const wantC = plan.filter((m) => m === "continue").length;
  const contOnly = modes.length === 1 && modes[0] === "continue";

  onProgress({ label: "Sorteando músicas…", done: 0, total: 0 });
  // "Continuar a letra" descarta algumas músicas: pede candidatas a mais
  // (no teste, ~60% das músicas servem: pede 2× + 5 candidatas a mais)
  const spares = wantC ? Math.min(30, wantC * 2 + 5) : 0;
  const { tracks: all, warnings: w } = await deezer.build(s.sources, s.rounds + extra + spares, s.versionFilter !== false, wantL);
  const withL = all.filter((t) => t.lyrics);
  const lyricPool = withL.slice(0, wantL);
  const rest = [...all.filter((t) => !t.lyrics), ...withL.slice(wantL)];

  // candidatas do "Continuar a letra": já analisadas e boas primeiro; as descartadas por último
  let candidates: PickedTrack[] = [];
  const contOk: PickedTrack[] = [];
  if (wantC) {
    const cache = new Map((await api.syncGet(rest.map((t) => t.deezer_id)).catch(() => [])).map((c) => [Number(c.deezer_id), c.ok]));
    const rank = (t: PickedTrack) => (cache.get(t.deezer_id) === true ? 0 : cache.has(t.deezer_id) ? 2 : 1);
    candidates = [...rest].sort((a, b) => rank(a) - rank(b));
    // agora: as que estão no cache (rápido); só "Continuar a letra" ligado -> todas (com o Groq)
    let last = 0;
    while (contOk.length < wantC && candidates.length) {
      if (!contOnly && rank(candidates[0]) !== 0) break; // o resto fica para o segundo plano
      const t = candidates.shift()!;
      onProgress({ label: `Preparando “Continuar a letra”: ${t.title}`, done: contOk.length, total: wantC });
      const wait = last + CONTINUE_GAP_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try {
        const v = await deezer.continuePlan(t.deezer_id, code, token);
        if (v.groq) last = Date.now();
        if (v.ok) contOk.push({ ...t, cont: v.plan });
      } catch {
        last = Date.now();
      }
    }
    if (contOnly) onProgress({ label: "Preparando músicas…", done: contOk.length, total: wantC });
  }
  // as que viraram "continuar" saem das outras
  const usedC = new Set(contOk.map((t) => t.deezer_id));
  const otherPool = rest.filter((t) => !usedC.has(t.deezer_id));

  const haveL = Math.min(wantL, lyricPool.length);
  const haveC = contOk.length;
  // misturado: as que faltam do "continuar" serão preparadas em segundo plano
  const pendingC = contOnly ? 0 : wantC - haveC;
  const short: Short[] = [];
  if (haveL < wantL) short.push({ mode: "lyrics", have: haveL, want: wantL });
  if (contOnly && haveC < wantC) short.push({ mode: "continue", have: haveC, want: wantC });
  const only = modes.length === 1 && short.length > 0;

  // rodadas de "continuar" sem música pronta: vão para mais adiante (dá tempo de preparar)
  if (pendingC > 0) {
    const cIdx = plan.map((m, i) => (m === "continue" ? i : -1)).filter((i) => i >= 0);
    const pendingIdx = cIdx.slice(haveC); // as primeiras rodadas de "continuar" usam as prontas
    const early = Math.min(plan.length - 1, 2 + Math.ceil(pendingC / 2)); // ~2 rodadas + tempo de análise
    for (const i of pendingIdx) {
      if (i >= early) continue;
      const j = plan.findIndex((m, k) => k >= early && m !== "continue");
      if (j >= 0) [plan[i], plan[j]] = [plan[j], plan[i]];
    }
    plan = [...plan];
  }

  // rodadas que ficaram sem música viram os outros modos ligados
  const fallback = modes.filter((m) => m !== "lyrics" && m !== "continue");
  let k = 0;
  let keepL = haveL;
  let finalPlan: ModeId[] = plan.map((m) =>
    m === "lyrics" && keepL-- <= 0 ? (only ? m : (fallback[k++ % Math.max(1, fallback.length)] ?? "classic")) : m,
  );
  if (only) finalPlan = finalPlan.slice(0, modes[0] === "lyrics" ? haveL : haveC);
  else if (contOnly) finalPlan = finalPlan.slice(0, haveC);

  // distribui as músicas pelas rodadas; "continuar" sem música pronta recebe uma
  // reserva (troca em segundo plano; se não der tempo, a rodada vira outro modo)
  const lp = [...lyricPool];
  const cp = [...contOk];
  // as candidatas ficam guardadas para o segundo plano (não viram músicas de outros modos)
  const bgSet = new Set(pendingC > 0 ? candidates.map((t) => t.deezer_id) : []);
  const op = [...otherPool.filter((t) => !bgSet.has(t.deezer_id)), ...otherPool.filter((t) => bgSet.has(t.deezer_id))];
  const ordered: PickedTrack[] = [];
  const pendingPos: number[] = [];
  finalPlan.forEach((m) => {
    let t: PickedTrack | undefined;
    if (m === "lyrics") t = lp.shift();
    else if (m === "continue") {
      t = cp.shift();
      if (!t) {
        t = op.shift() ?? lp.shift();
        if (t) pendingPos.push(ordered.length + 1);
      }
    } else t = op.shift() ?? lp.shift();
    if (t) ordered.push({ ...t, mode: m });
  });
  // reservas (morte súbita, sempre clássico): o que sobrou, sem os dados dos modos
  const leftovers = [...op, ...lp, ...cp].slice(0, extra).map((t) => ({ ...t, cont: undefined }));
  const tracks = [...ordered, ...leftovers];
  // candidatas para o segundo plano: as que não entraram na partida
  const inMatch = new Set(tracks.map((t) => t.deezer_id));
  const background = pendingPos.length
    ? { positions: pendingPos, candidates: candidates.filter((t) => !inMatch.has(t.deezer_id)) }
    : null;

  onProgress(null);
  // o aviso de "poucas músicas" só interessa se faltou para as rodadas (não para as reservas)
  const warnings = w.filter((x) => !x.startsWith("Só encontrei") || all.length < s.rounds);
  return { tracks, rounds: ordered.length, warnings, short, only, background };
}

/** Preparação em segundo plano em andamento (uma por aba; a nova cancela a anterior). */
let bgRun = 0;

/**
 * Segundo plano: analisa as candidatas (uma por vez, ~3 s entre as do Groq) e
 * põe cada música pronta na próxima rodada pendente que ainda não começou.
 * Atualiza o progresso na sala (a TV mostra discretamente).
 */
async function runBackground(code: string, token: string, match: number, positions: number[], candidates: PickedTrack[]) {
  const my = ++bgRun;
  const total = positions.length;
  let done = 0;
  let roundNo = 1;
  const prep = (active: boolean) => ({ active, done, total });
  await api.fillCont(code, token, match, 0, null, prep(true)).catch(() => {});
  let last = 0;
  const queue = [...candidates];
  for (const pos of positions) {
    if (pos <= roundNo) continue; // a rodada já começou: fica com o outro modo
    while (queue.length) {
      if (my !== bgRun) return;
      const t = queue.shift()!;
      const wait = last + CONTINUE_GAP_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      let v;
      try {
        v = await deezer.continuePlan(t.deezer_id, code, token);
        if (v.groq) last = Date.now();
      } catch {
        last = Date.now();
        continue;
      }
      if (!v.ok) continue;
      const r = await api.fillCont(code, token, match, pos, { ...t, mode: "continue", cont: v.plan }, { active: true, done: done + 1, total }).catch(() => null);
      if (!r || r.reason === "match") return; // outra partida começou
      roundNo = r.round_no ?? roundNo;
      if (r.ok) {
        done++;
        break;
      }
      queue.unshift(t); // a rodada já começou: usa esta música na próxima posição
      break;
    }
  }
  if (my === bgRun) await api.fillCont(code, token, match, 0, null, prep(false)).catch(() => {});
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
    const r = await api.startMatch(code, token, p.tracks, p.rounds);
    if (p.warnings.length) setError(p.warnings.join(" "));
    // segue preparando em segundo plano (sem travar a partida); sem pendências, zera o progresso
    if (p.background) void runBackground(code, token, r.match_no, p.background.positions, p.background.candidates);
    else {
      bgRun++;
      void api.fillCont(code, token, r.match_no, 0, null, { active: false, done: 0, total: 0 }).catch(() => {});
    }
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
      const p = await prepareMatch(state, code, token, setProgress);
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
