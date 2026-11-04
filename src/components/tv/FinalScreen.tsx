"use client";
import { useState } from "react";
import { Button, Logo, TeamChip } from "@/components/ui";
import { api } from "@/lib/api";
import { textOn } from "@/lib/colors";
import { friendlyError } from "@/lib/errors";
import { formatSeconds, matchStats, ranking } from "@/lib/game";
import type { RoomState } from "@/lib/types";
import { getMode } from "@/modes";
import { startMatch } from "./startMatch";
import type { TvCtx } from "./TvApp";

export function FinalScreen({ state, ctx }: { state: RoomState; ctx: TvCtx }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rank = ranking(state.teams);
  const podium = rank.slice(0, 3);
  const stats = matchStats(state);
  const votes = state.players.filter((p) => p.wants_rematch).length;

  const rematch = async () => {
    setBusy(true);
    setError(null);
    try {
      await startMatch(state, ctx);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  // pódio: 2º, 1º, 3º
  const order = [podium[1], podium[0], podium[2]].filter(Boolean);
  const heights: Record<number, string> = { 1: "h-64", 2: "h-48", 3: "h-36" };

  const fastestSecs = stats.fastest
    ? getMode(stats.fastest.round?.mode).stages[stats.fastest.attempt.stage - 1]?.seconds
    : null;

  return (
    <main className="flex flex-1 flex-col items-center gap-8 p-8">
      <Logo className="text-4xl" />
      <h1 className="font-display text-6xl font-bold text-yellow-300">Fim de jogo! 🏆</h1>

      <div className="flex items-end justify-center gap-4">
        {order.map(({ team, pos }) => (
          <div key={team.id} className="flex w-56 flex-col items-center gap-2">
            <span className="font-display text-3xl font-semibold text-center">{team.name}</span>
            <span className="font-display text-4xl font-bold">{team.score}</span>
            <div
              className={`npl-pop flex w-full items-start justify-center rounded-t-3xl pt-4 font-display text-7xl font-bold ${heights[pos] ?? "h-28"}`}
              style={{ background: team.color, color: textOn(team.color) }}
            >
              {pos}º
            </div>
          </div>
        ))}
      </div>

      {rank.length > 3 && (
        <div className="flex flex-wrap justify-center gap-3">
          {rank.slice(3).map(({ team, pos }) => (
            <TeamChip key={team.id} team={team} className="text-xl">
              {pos}º {team.name} · {team.score}
            </TeamChip>
          ))}
        </div>
      )}

      <div className="grid w-full max-w-5xl gap-4 md:grid-cols-3">
        <Stat title="⚡ Acerto mais rápido">
          {stats.fastest?.team ? (
            <>
              <TeamChip team={stats.fastest.team} /> em “{stats.fastest.round?.reveal?.title}”
              <br />
              com {fastestSecs ?? "?"}s de música ({formatSeconds(stats.fastest.attempt.ms_into_stage)}s após o trecho começar)
            </>
          ) : (
            "Ninguém acertou nada!"
          )}
        </Stat>
        <Stat title="🏴‍☠️ Mais roubos">
          {stats.topSteal?.team ? (
            <>
              <TeamChip team={stats.topSteal.team} /> com {stats.topSteal.count} roubo{stats.topSteal.count > 1 ? "s" : ""}
            </>
          ) : (
            "Nenhum roubo"
          )}
        </Stat>
        <Stat title="🙈 Ninguém acertou">
          {stats.nobody.length ? (
            <ul>
              {stats.nobody.slice(0, 4).map((r) => (
                <li key={r.id}>“{r.reveal?.title}” — {r.reveal?.artist}</li>
              ))}
              {stats.nobody.length > 4 && <li>e mais {stats.nobody.length - 4}</li>}
            </ul>
          ) : (
            "Todas as músicas foram acertadas!"
          )}
        </Stat>
      </div>

      {error && <p className="text-rose-300 text-lg">{error}</p>}
      <div className="flex flex-wrap justify-center gap-4">
        <Button className="text-3xl px-10 py-5" disabled={busy} onClick={rematch}>
          {busy ? "Sorteando…" : "🔁 Revanche (mesmos times)"}
        </Button>
        <Button variant="secondary" className="text-xl" onClick={() => api.setPhase(ctx.code, ctx.owner, "lobby").catch((e) => setError(friendlyError(e)))}>
          Mudar times
        </Button>
        <Button variant="secondary" className="text-xl" onClick={() => api.setPhase(ctx.code, ctx.owner, "config").catch((e) => setError(friendlyError(e)))}>
          ⚙️ Configurações
        </Button>
      </div>
      {votes > 0 && <p className="text-white/70 text-xl">{votes} jogador{votes > 1 ? "es querem" : " quer"} jogar de novo!</p>}
    </main>
  );
}

function Stat({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-3xl bg-white/10 border border-white/15 p-5 text-lg">
      <p className="font-display text-2xl font-semibold mb-2">{title}</p>
      <div className="text-white/85 leading-relaxed">{children}</div>
    </div>
  );
}
