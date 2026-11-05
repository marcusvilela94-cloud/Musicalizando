"use client";
import { useState } from "react";
import { Button } from "@/components/ui";
import { api, deezer } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import type { ModeId, PickedTrack, RoomState, StemName, StemsVariant } from "@/lib/types";
import { obraPacksOf, pickObraTracks } from "@/lib/obra";
import { isQuizMode } from "@/modes/quiz/logic";
import { fmtDuration, stemsEta, stemsPlan } from "@/modes/stems/logic";
import { TURN_MODES, enabledModes, modeSchedule, playingTeamCount } from "@/modes/schedule";

/** Quantas das músicas das fontes já estão prontas no cache. */
const readyCountOf = (st: Awaited<ReturnType<typeof api.stemsStatus>> | null, pool: PickedTrack[]) => {
  const ids = new Set(pool.map((t) => t.deezer_id));
  return (st?.ready ?? []).filter((r) => ids.has(r.deezer_id)).length;
};

/** Músicas a mais sorteadas para a morte súbita (ficam de reserva no servidor). */
const TIEBREAK_RESERVE = 5;
/** "Continuar a letra": o Groq aceita 20 pedidos/minuto -> uma análise a cada 3,2 s. */
const CONTINUE_GAP_MS = 3200;

/** Falta de músicas para um modo que precisa de preparo. */
type Short = {
  mode: "lyrics" | "continue" | "stems";
  have: number;
  want: number;
  /** Instrumentos: por que não dá para preparar agora ("running" = dá: "Esperar preparar") */
  queue?: "off" | "paused" | "full" | "waking" | "running";
  /** Instrumentos: estimativa para a fila andar (segundos) */
  etaSeconds?: number;
};
/** Instrumentos: rodadas que esperam o separador (em segundo plano). */
type StemsBg = { positions: number[]; candidates: PickedTrack[]; variant: StemsVariant; instrument: StemName | "random" };
type Prepared = {
  tracks: PickedTrack[];
  rounds: number;
  warnings: string[];
  short: Short[];
  /** só um modo ligado (e é esse que faltou): joga menos rodadas */
  only: boolean;
  /** rodadas de "Continuar a letra" que serão preparadas depois de começar */
  background: { positions: number[]; candidates: PickedTrack[] } | null;
  /** Instrumentos: músicas do cache usadas (atualiza o "último uso") e o segundo plano */
  stemsUsed: number[];
  stemsBg: StemsBg | null;
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
async function prepareMatch(
  state: RoomState,
  code: string,
  token: string,
  onProgress: (p: Progress | null) => void,
  /** Instrumentos: false = só as prontas (padrão); true = as que faltam são preparadas durante a partida */
  waitStems = false,
): Promise<Prepared> {
  const s = state.room.settings;
  const modes = enabledModes(s);
  const extra = (s.tiebreak ?? "sudden") === "sudden" ? TIEBREAK_RESERVE : 0;
  let plan = modeSchedule(modes, s.modeOrder ?? "alternate", s.rounds);
  // "Um time por vez": rodadas desses modos num múltiplo do número de times (todos jogam o mesmo tanto)
  if ((s.turnFormat ?? "buzz") === "turns") {
    const teams = playingTeamCount(state.teams, state.players);
    const turnPlan = plan.filter((m) => TURN_MODES.includes(m)).length;
    const fill = modes.filter((m) => TURN_MODES.includes(m) && m !== "lyrics" && m !== "continue");
    const missing = turnPlan % teams ? teams - (turnPlan % teams) : 0;
    const fillWith = fill.length ? fill : modes.filter((m) => TURN_MODES.includes(m));
    if (turnPlan && fillWith.length) for (let i = 0; i < missing; i++) plan.push(fillWith[i % fillWith.length]);
  }
  // "Qual é a obra?": músicas só dos pacotes ligados (não das fontes), sem repetir obra
  const wantO = plan.filter((m) => m === "obra").length;
  const obraPool = wantO ? pickObraTracks(obraPacksOf(s), wantO) : [];
  const obraWarn: string[] = [];
  if (obraPool.length < wantO) {
    const others = modes.filter((m) => m !== "obra" && m !== "lyrics" && m !== "continue" && !isQuizMode(m));
    obraWarn.push(`Os pacotes escolhidos só têm ${obraPool.length} obra${obraPool.length === 1 ? "" : "s"} diferentes.`);
    let extraO = wantO - obraPool.length;
    if (modes.length === 1) {
      // só "Qual é a obra?": joga menos rodadas
      plan = plan.slice(0, obraPool.length);
    } else {
      // as rodadas que faltaram viram outro modo ligado (ou clássico)
      for (let i = plan.length - 1; i >= 0 && extraO > 0; i--)
        if (plan[i] === "obra") {
          plan[i] = others[extraO % Math.max(1, others.length)] ?? "classic";
          extraO--;
        }
    }
  }
  const useO = plan.filter((m) => m === "obra").length;
  const wantQ = plan.filter(isQuizMode).length;
  const wantL = plan.filter((m) => m === "lyrics").length;
  const wantC = plan.filter((m) => m === "continue").length;
  const contOnly = modes.length === 1 && modes[0] === "continue";

  onProgress({ label: "Sorteando músicas…", done: 0, total: 0 });
  // "Continuar a letra" descarta algumas músicas: pede candidatas a mais
  // (no teste, ~60% das músicas servem: pede 2× + 5 candidatas a mais)
  const spares = wantC ? Math.min(30, wantC * 2 + 5) : 0;
  // quizzes: algumas músicas a mais dão variedade às alternativas (e às curiosidades)
  const quizSpares = wantQ ? Math.min(8, 3 + Math.ceil(wantQ / 4) * 2) : 0;
  const { tracks: all, warnings: w } = await deezer.build(s.sources, plan.length - useO + extra + spares + quizSpares, s.versionFilter !== false, wantL);
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
  // Instrumentos: só músicas das fontes que já estão separadas no cache
  const wantS = plan.filter((m) => m === "stems").length;
  const variant: StemsVariant = s.stemsVariant ?? "layers";
  const instrument = s.stemsInstrument ?? "random";
  let stemsReady: PickedTrack[] = [];
  let stemsCandidates: PickedTrack[] = [];
  let workerOn = false;
  let queuePaused = false;
  let queueFull = false;
  let cloudWaking = false;
  let stemsEtaS: number | undefined;
  if (wantS) {
    onProgress({ label: "Conferindo os instrumentos prontos…", done: 0, total: 0 });
    const srcPool = await deezer.pool(s.sources, s.versionFilter !== false).then((r) => r.tracks).catch(() => all);
    const st = await api.stemsStatus(srcPool.map((t) => t.deezer_id)).catch(() => null);
    workerOn = !!st?.worker?.alive;
    queuePaused = !!st?.global?.paused;
    queueFull = !!st?.global?.full;
    const blocked = new Set(st?.blocked ?? []);
    stemsEtaS = stemsEta(st?.global)?.seconds;
    // nenhum separador ligado e faltam músicas: acorda o da nuvem (Hugging Face)
    if (!workerOn && readyCountOf(st, srcPool) < wantS) {
      const w = await deezer.wakeSeparator(code, token).catch(() => null);
      cloudWaking = !!w?.configured;
    }
    const readyMap = new Map((st?.ready ?? []).map((r) => [r.deezer_id, r]));
    const mixed = [...srcPool].sort(() => Math.random() - 0.5);
    stemsReady = mixed
      .filter((t) => readyMap.has(t.deezer_id))
      .slice(0, wantS)
      .map((t) => ({ ...t, lyrics: undefined, mode: "stems" as const, stems: stemsPlan(readyMap.get(t.deezer_id)!, variant, instrument) }));
    stemsCandidates = mixed.filter((t) => !readyMap.has(t.deezer_id) && !blocked.has(t.deezer_id));
  }
  const haveS = stemsReady.length;
  // padrão: só as prontas (não espera a fila). "Esperar preparar" (com o separador
  // ligado e a fila andando): as que faltam são preparadas em segundo plano
  const queueRuns = (workerOn || cloudWaking) && !queuePaused && !queueFull;
  const waitS = waitStems && queueRuns;
  const pendingS = waitS ? wantS - haveS : 0;

  // as que viraram "continuar" ou "instrumentos" saem das outras
  const usedC = new Set([...contOk, ...stemsReady].map((t) => t.deezer_id));
  const otherPool = rest.filter((t) => !usedC.has(t.deezer_id));

  const haveL = Math.min(wantL, lyricPool.length);
  const haveC = contOk.length;
  // misturado: as que faltam do "continuar" serão preparadas em segundo plano
  const pendingC = contOnly ? 0 : wantC - haveC;
  const short: Short[] = [];
  if (haveL < wantL) short.push({ mode: "lyrics", have: haveL, want: wantL });
  if (contOnly && haveC < wantC) short.push({ mode: "continue", have: haveC, want: wantC });
  if (!waitS && haveS < wantS)
    short.push({
      mode: "stems",
      have: haveS,
      want: wantS,
      queue: queuePaused ? "paused" : queueFull ? "full" : workerOn ? "running" : cloudWaking ? "waking" : "off",
      etaSeconds: stemsEtaS,
    });
  const only = modes.length === 1 && short.length > 0;

  // rodadas sem música pronta ("continuar" / "instrumentos"): vão para mais adiante (dá tempo de preparar)
  const postpone = (mode: ModeId, have: number, pending: number, early: number) => {
    const idx = plan.map((m, i) => (m === mode ? i : -1)).filter((i) => i >= 0);
    for (const i of idx.slice(have)) {
      if (i >= early) continue;
      const j = plan.findIndex((m, k) => k >= early && m !== mode && m !== "continue" && m !== "stems");
      if (j >= 0) [plan[i], plan[j]] = [plan[j], plan[i]];
    }
    plan = [...plan];
    return pending;
  };
  if (pendingC > 0) postpone("continue", haveC, pendingC, Math.min(plan.length - 1, 2 + Math.ceil(pendingC / 2))); // ~2 rodadas + análise
  // o separador leva ~1 min por música no PC: deixa umas 3 rodadas + 1 por música que falta
  if (pendingS > 0) postpone("stems", haveS, pendingS, Math.min(plan.length - 1, 3 + pendingS));

  // rodadas que ficaram sem música viram os outros modos ligados
  const fallback = modes.filter((m) => m !== "lyrics" && m !== "continue" && m !== "obra" && m !== "stems");
  let k = 0;
  let keepL = haveL;
  let keepS = haveS;
  const other = (m: ModeId) => (only ? m : (fallback[k++ % Math.max(1, fallback.length)] ?? "classic"));
  let finalPlan: ModeId[] = plan.map((m) =>
    m === "lyrics" && keepL-- <= 0 ? other(m) : m === "stems" && !waitS && keepS-- <= 0 ? other(m) : m,
  );
  if (only) finalPlan = finalPlan.slice(0, modes[0] === "lyrics" ? haveL : modes[0] === "stems" ? haveS : haveC);
  else if (contOnly) finalPlan = finalPlan.slice(0, haveC);

  // distribui as músicas pelas rodadas; "continuar" sem música pronta recebe uma
  // reserva (troca em segundo plano; se não der tempo, a rodada vira outro modo)
  const lp = [...lyricPool];
  const cp = [...contOk];
  // as candidatas ficam guardadas para o segundo plano (não viram músicas de outros modos)
  const bgSet = new Set(pendingC > 0 ? candidates.map((t) => t.deezer_id) : []);
  const op = [...otherPool.filter((t) => !bgSet.has(t.deezer_id)), ...otherPool.filter((t) => bgSet.has(t.deezer_id))];
  const obp = [...obraPool];
  const sp = [...stemsReady];
  let ordered: PickedTrack[] = [];
  // rodadas que serão preparadas em segundo plano (as posições saem no fim, depois dos ajustes)
  const pendingContT: PickedTrack[] = [];
  const pendingStemsT: PickedTrack[] = [];
  finalPlan.forEach((m) => {
    let t: PickedTrack | undefined;
    if (m === "stems") {
      // pronta no cache (já vem com o plano); senão uma reserva, trocada em segundo plano
      const ready = sp.shift();
      if (ready) {
        ordered.push(ready);
        return;
      }
      t = op.shift() ?? lp.shift();
      if (t) {
        const x: PickedTrack = { ...t, lyrics: undefined, mode: m };
        pendingStemsT.push(x);
        ordered.push(x);
      }
      return;
    }
    if (m === "obra") {
      // a faixa do pacote já vem com a obra (quiz) e o modo
      const o = obp.shift();
      if (o) ordered.push(o);
      return;
    }
    if (m === "lyrics") t = lp.shift();
    else if (m === "continue") {
      t = cp.shift();
      if (!t) {
        t = op.shift() ?? lp.shift();
        if (t) {
          const x: PickedTrack = { ...t, mode: m };
          pendingContT.push(x);
          ordered.push(x);
        }
        return;
      }
    } else t = op.shift() ?? lp.shift();
    if (t) ordered.push({ ...t, mode: m });
  });

  // quizzes: uma pergunta por rodada (no servidor, com dados do Deezer e o banco de curiosidades)
  const quizPos = ordered.map((t, i) => (isQuizMode(t.mode) ? i : -1)).filter((i) => i >= 0);
  if (quizPos.length) {
    onProgress({ label: "Preparando as perguntas do quiz…", done: 0, total: 0 });
    const slim = (t: PickedTrack): PickedTrack => ({
      deezer_id: t.deezer_id,
      title: t.title,
      title_short: t.title_short,
      artist: t.artist,
      artists: t.artists,
      cover: t.cover,
      album: t.album,
      album_id: t.album_id,
      artist_id: t.artist_id,
    });
    const res = await deezer
      .quiz({
        items: quizPos.map((i) => ({ ...slim(ordered[i]), format: ordered[i].mode === "quiz_choice" ? ("choice" as const) : ("open" as const) })),
        pool: all.map(slim),
        sources: s.sources,
        curiosities: s.curiosities !== false,
        recent: state.room.trivia_recent ?? [],
      })
      .catch(() => ({ results: [] as Awaited<ReturnType<typeof deezer.quiz>>["results"] }));
    const inUse = new Set(ordered.map((t) => t.deezer_id));
    const noQuiz = modes.find((m) => !isQuizMode(m) && m !== "lyrics" && m !== "continue" && m !== "obra") ?? "classic";
    quizPos.forEach((pos, k) => {
      const r = res.results[k];
      // sem pergunta: a rodada vira outro modo ligado (o servidor também confere)
      if (!r) {
        ordered[pos] = { ...ordered[pos], mode: noQuiz };
        return;
      }
      // curiosidade de um artista das fontes: toca uma música dele
      const swap = r.track && !inUse.has(r.track.deezer_id) ? all.find((x) => x.deezer_id === r.track!.deezer_id) ?? r.track : null;
      if (swap) inUse.add(swap.deezer_id);
      ordered[pos] = { ...(swap ?? ordered[pos]), lyrics: undefined, cont: undefined, mode: ordered[pos].mode, quiz: r.quiz };
    });
  }
  // faltou música e é "Um time por vez": rodadas desses modos num múltiplo do número de times
  // (todos jogam o mesmo tanto); as que sobram viram reserva
  const cut: PickedTrack[] = [];
  if ((s.turnFormat ?? "buzz") === "turns") {
    const teams = playingTeamCount(state.teams, state.players);
    const turnIdx = ordered.map((t, i) => (TURN_MODES.includes(t.mode ?? "classic") ? i : -1)).filter((i) => i >= 0);
    const over = teams > 1 ? turnIdx.length % teams : 0;
    if (over && ordered.length > over) {
      const drop = new Set(turnIdx.slice(-over));
      ordered.forEach((t, i) => drop.has(i) && cut.push(t));
      ordered = ordered.filter((_, i) => !drop.has(i));
    }
  }
  const pendingPos = pendingContT.map((t) => ordered.indexOf(t) + 1).filter((p) => p > 0);
  const pendingStems = pendingStemsT.map((t) => ordered.indexOf(t) + 1).filter((p) => p > 0);

  // reservas (morte súbita, sempre clássico): o que sobrou, sem os dados dos modos
  const usedIds = new Set(ordered.map((t) => t.deezer_id));
  const cutPlain = cut.filter((t) => !t.stems && t.mode !== "obra").map((t) => ({ ...t, mode: undefined, lyrics: undefined }));
  const leftovers = [...op, ...lp, ...cp, ...cutPlain]
    .filter((t) => !usedIds.has(t.deezer_id))
    .slice(0, extra)
    .map((t) => ({ ...t, cont: undefined, quiz: undefined }));
  const tracks = [...ordered, ...leftovers];
  // candidatas para o segundo plano: as que não entraram na partida
  const inMatch = new Set(tracks.map((t) => t.deezer_id));
  const background = pendingPos.length
    ? { positions: pendingPos, candidates: candidates.filter((t) => !inMatch.has(t.deezer_id)) }
    : null;
  const stemsBg: StemsBg | null = pendingStems.length
    ? { positions: pendingStems, candidates: stemsCandidates.filter((t) => !inMatch.has(t.deezer_id)), variant, instrument }
    : null;
  const stemsUsed = ordered.filter((t) => t.stems).map((t) => t.deezer_id);

  onProgress(null);
  // o aviso de "poucas músicas" só interessa se faltou para as rodadas (não para as reservas)
  const warnings = [...obraWarn, ...w.filter((x) => !x.startsWith("Só encontrei") || all.length < plan.length - useO)];
  return { tracks, rounds: ordered.length, warnings, short, only, background, stemsUsed, stemsBg };
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

/** Segundo plano dos Instrumentos (um por aba; a nova partida cancela a anterior). */
let stemsRun = 0;
/** Separador no PC: ~1 min por música. Desiste depois de 40 min sem terminar. */
const STEMS_POLL_MS = 6000;
const STEMS_GIVE_UP_MS = 40 * 60 * 1000;

/**
 * Pede ao separador as músicas que faltam e, conforme ficam prontas, põe cada
 * uma na próxima rodada de Instrumentos que ainda não começou (a que começar
 * antes vira outro modo ligado, no servidor).
 */
async function runStemsBackground(code: string, token: string, match: number, bg: StemsBg) {
  const my = ++stemsRun;
  const total = bg.positions.length;
  const want = bg.candidates.slice(0, total * 2 + 2);
  const ids = want.map((t) => t.deezer_id);
  let done = 0;
  let roundNo = 1;
  const queue = [...bg.positions];
  const used = new Set<number>();
  await api.stemsRequest(code, token, ids, want).catch(() => 0);
  await api.fillStems(code, token, match, 0, null, { active: true, done, total }).catch(() => {});
  // nenhum separador ligado: acorda o da nuvem (e insiste a cada ~1 min enquanto ninguém ligar)
  void deezer.wakeSeparator(code, token).catch(() => null);
  const t0 = Date.now();
  let polls = 0;
  while (queue.length && Date.now() - t0 < STEMS_GIVE_UP_MS) {
    await new Promise((r) => setTimeout(r, STEMS_POLL_MS));
    if (my !== stemsRun) return;
    const st = await api.stemsStatus(ids).catch(() => null);
    if (!st) continue;
    if (!st.worker?.alive && ++polls % 10 === 0) void deezer.wakeSeparator(code, token).catch(() => null);
    for (const r of st.ready) {
      if (used.has(r.deezer_id)) continue;
      while (queue.length && queue[0] <= roundNo) queue.shift(); // a rodada já começou: ficou com outro modo
      const pos = queue[0];
      if (!pos) break;
      const t = want.find((x) => x.deezer_id === r.deezer_id);
      if (!t) continue;
      used.add(r.deezer_id);
      const track: PickedTrack = { ...t, lyrics: undefined, mode: "stems", stems: stemsPlan(r, bg.variant, bg.instrument) };
      const res = await api.fillStems(code, token, match, pos, track, { active: true, done: done + 1, total }).catch(() => null);
      if (!res || res.reason === "match") return; // outra partida começou
      roundNo = res.round_no ?? roundNo;
      if (res.ok) {
        done++;
        queue.shift();
      }
    }
  }
  if (my === stemsRun) await api.fillStems(code, token, match, 0, null, { active: false, done, total }).catch(() => {});
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
    // "Fontes recentes": as desta partida vão para o topo dos atalhos
    void api.sourcesUsed(code, token).catch(() => {});
    // Instrumentos: marca o uso (o cache apaga as usadas há mais tempo) e prepara as que faltam
    if (p.stemsUsed.length) void api.stemsTouch(code, token, p.stemsUsed).catch(() => {});
    if (p.stemsBg) void runStemsBackground(code, token, r.match_no, p.stemsBg);
    else stemsRun++;
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
  // Instrumentos: "Esperar preparar" — sorteia de novo deixando as rodadas que faltam para o separador
  const waitStems = () =>
    run(async () => {
      setShort(null);
      const p = await prepareMatch(state, code, token, setProgress, true);
      if (p.short.length) setShort(p);
      else await begin(p);
    });
  const backToConfig = () => {
    setShort(null);
    api.setPhase(code, token, "config").catch((e) => setError(friendlyError(e)));
  };
  return { busy, error, short, progress, start, confirm, waitStems, backToConfig, dismiss: () => setShort(null) };
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

const SHORT_EMOJI: Record<Short["mode"], string> = { lyrics: "📝", continue: "🎤", stems: "🥁" };
const STEMS_WHY: Record<NonNullable<Short["queue"]>, string> = {
  off: "e o separador está desligado",
  paused: "e a fila do separador está pausada",
  full: "e a biblioteca está cheia de músicas fixadas (libere espaço em /biblioteca)",
  running: "(o separador ainda está preparando as outras)",
  waking: "(acordando o separador da nuvem para preparar as outras)",
};
const SHORT_TEXT: Record<Short["mode"], (x: Short) => string> = {
  stems: ({ have: n, want, queue }) =>
    `Só ${n} de ${want} música${want === 1 ? "" : "s"} com instrumentos prontos ${STEMS_WHY[queue ?? "off"]}: ${n} rodada${n === 1 ? "" : "s"} de Instrumentos.`,
  lyrics: ({ have: n }) => `Só encontramos ${n} música${n === 1 ? "" : "s"} com letra nessas playlists.`,
  continue: ({ have: n }) =>
    `Só ${n} música${n === 1 ? "" : "s"} servem para “Continuar a letra” (precisa de letra sincronizada e voz clara).`,
};

/** Aviso antes de começar quando faltou música preparada. */
export function LyricsShortNotice({ m, compact }: { m: MatchStarter; compact?: boolean }) {
  const p = m.short;
  if (!p?.short.length) return null;
  const canWait = p.short.find((x) => x.mode === "stems" && (x.queue === "running" || x.queue === "waking"));
  return (
    <div className="npl-pop flex w-full flex-col items-center gap-3 rounded-3xl border-2 border-yellow-300 bg-black/40 p-5 text-center">
      {p.short.map((x) => (
        <p key={x.mode} className={`font-display ${compact ? "text-xl" : "text-3xl"}`}>
          {SHORT_EMOJI[x.mode]} {SHORT_TEXT[x.mode](x)}
        </p>
      ))}
      {!p.only && (
        <p className="text-white/70">As rodadas que faltaram viram rodadas dos outros modos ligados ({p.rounds} músicas no total).</p>
      )}
      {canWait && (
        <p className="text-white/70">
          “Esperar preparar”: começa já, as rodadas de Instrumentos vão mais para o fim e entram conforme o separador termina.
        </p>
      )}
      <div className={`flex flex-wrap justify-center gap-3 ${compact ? "w-full flex-col" : ""}`}>
        <Button className={compact ? "text-xl py-3" : "text-2xl px-8 py-3"} disabled={m.busy || p.rounds === 0} onClick={m.confirm}>
          Jogar com {p.rounds} música{p.rounds === 1 ? "" : "s"}
        </Button>
        {canWait && (
          <Button variant="secondary" className="text-xl" disabled={m.busy} onClick={m.waitStems}>
            ⏳ Esperar preparar
            {canWait.etaSeconds ? <span className="text-base opacity-70"> (fila: ~{fmtDuration(canWait.etaSeconds)})</span> : null}
          </Button>
        )}
        <Button variant="secondary" className="text-xl" onClick={m.backToConfig}>
          Trocar as playlists
        </Button>
      </div>
    </div>
  );
}
