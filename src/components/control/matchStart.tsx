"use client";
import { useState } from "react";
import { Button } from "@/components/ui";
import { api, deezer } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import type { ModeId, PickedTrack, RoomState } from "@/lib/types";
import { enabledModes, modeSchedule } from "@/modes/schedule";

/** Músicas a mais sorteadas para a morte súbita (ficam de reserva no servidor). */
const TIEBREAK_RESERVE = 5;

type Prepared = {
  tracks: PickedTrack[];
  rounds: number;
  warnings: string[];
  /** faltou letra: quantas rodadas de letra dá para jogar / quantas eram */
  short: { have: number; want: number; only: boolean } | null;
};

/**
 * Sorteia as músicas e monta o plano da partida: o modo de cada rodada segue a
 * "Ordem dos modos" e as rodadas de "Só pela letra" recebem só músicas com
 * letra. Faltou letra: só modo letra -> joga menos rodadas; misturado -> as
 * rodadas de letra que sobraram viram outros modos ligados.
 */
async function prepareMatch(state: RoomState): Promise<Prepared> {
  const s = state.room.settings;
  const modes = enabledModes(s);
  const extra = (s.tiebreak ?? "sudden") === "sudden" ? TIEBREAK_RESERVE : 0;
  const plan = modeSchedule(modes, s.modeOrder ?? "alternate", s.rounds);
  const want = plan.filter((m) => m === "lyrics").length;

  const { tracks: all, warnings: w } = await deezer.build(s.sources, s.rounds + extra, s.versionFilter !== false, want);
  const withL = all.filter((t) => t.lyrics);
  const without = all.filter((t) => !t.lyrics);
  const have = Math.min(want, withL.length);
  const only = modes.length === 1 && modes[0] === "lyrics";

  // sem letra suficiente (misturado): troca as últimas rodadas de letra por outros modos ligados
  const others = modes.filter((m) => m !== "lyrics");
  let finalPlan: ModeId[] = plan;
  if (have < want && !only) {
    let keep = have;
    let k = 0;
    finalPlan = plan.map((m) => {
      if (m !== "lyrics") return m;
      if (keep > 0) return keep--, m;
      return others[k++ % others.length] ?? "classic";
    });
  }
  const rounds = only ? Math.min(s.rounds, have) : Math.min(s.rounds, all.length);
  finalPlan = finalPlan.slice(0, rounds);

  // distribui: rodada de letra <- música com letra; as outras <- sem letra primeiro
  const lyricPool = [...withL];
  const otherPool = [...without];
  const ordered: PickedTrack[] = [];
  for (const m of finalPlan) {
    const t = m === "lyrics" ? lyricPool.shift() : (otherPool.shift() ?? lyricPool.shift());
    if (t) ordered.push({ ...t, mode: m });
  }
  // reservas (morte súbita, sempre clássico): o que sobrou
  const tracks = [...ordered, ...otherPool, ...lyricPool];

  // o aviso de "poucas músicas" só interessa se faltou para as rodadas (não para as reservas)
  const warnings = w.filter((x) => !x.startsWith("Só encontrei") || all.length < s.rounds);
  return { tracks, rounds: ordered.length, warnings, short: have < want ? { have, want, only } : null };
}

/**
 * Começar / revanche. Se faltou letra para as rodadas de "Só pela letra",
 * pergunta antes: "Só encontramos X músicas com letra…".
 */
export function useMatchStarter(state: RoomState, code: string, token: string) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [short, setShort] = useState<Prepared | null>(null);

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
    }
  };
  const start = () =>
    run(async () => {
      const p = await prepareMatch(state);
      if (p.short) setShort(p);
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
  return { busy, error, short, start, confirm, backToConfig, dismiss: () => setShort(null) };
}

export type MatchStarter = ReturnType<typeof useMatchStarter>;

/** Aviso antes de começar quando faltou letra. */
export function LyricsShortNotice({ m, compact }: { m: MatchStarter; compact?: boolean }) {
  const info = m.short?.short;
  if (!info) return null;
  const n = info.have;
  return (
    <div className="npl-pop flex w-full flex-col items-center gap-3 rounded-3xl border-2 border-yellow-300 bg-black/40 p-5 text-center">
      <p className={`font-display ${compact ? "text-xl" : "text-3xl"}`}>
        📝 Só encontramos <b className="text-yellow-300">{n}</b> música{n === 1 ? "" : "s"} com letra nessas playlists.
      </p>
      {!info.only && (
        <p className="text-white/70">
          Eram {info.want} rodadas de “Só pela letra”; as outras {info.want - n} viram rodadas dos outros modos ligados.
        </p>
      )}
      <div className={`flex flex-wrap justify-center gap-3 ${compact ? "w-full flex-col" : ""}`}>
        <Button className={compact ? "text-xl py-3" : "text-2xl px-8 py-3"} disabled={m.busy || (info.only && n === 0)} onClick={m.confirm}>
          {info.only ? `Jogar com ${n}` : `Jogar com ${n} de letra`}
        </Button>
        <Button variant="secondary" className="text-xl" onClick={m.backToConfig}>
          Trocar as playlists
        </Button>
      </div>
    </div>
  );
}
