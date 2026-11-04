"use client";
import { useEffect } from "react";
import { FinalControls } from "@/components/control/FinalControls";
import { Logo, TeamChip } from "@/components/ui";
import { textOn } from "@/lib/colors";
import { artistCredits, formatSeconds, isHostStyle, matchStats, ranking } from "@/lib/game";
import { sharedSfx } from "@/lib/sfx";
import type { RoomState } from "@/lib/types";
import { getMode } from "@/modes";
import type { TvCtx } from "./TvApp";

export function FinalScreen({ state, ctx }: { state: RoomState; ctx: TvCtx }) {
  const rank = ranking(state.teams);
  const podium = rank.slice(0, 3);
  const stats = matchStats(state);
  const votes = state.players.filter((p) => p.wants_rematch).length;
  const sounds = state.room.settings.sounds !== false;
  const sfxVolume = state.room.settings.sfxVolume;
  const matchNo = state.room.match_no;

  // fanfarra no pódio (uma vez por partida)
  useEffect(() => {
    const sfx = sharedSfx();
    sfx.setEnabled(sounds);
    sfx.setVolume(sfxVolume);
    ctx.audio.stopAll();
    sfx.play("fanfare");
  }, [matchNo, sounds, sfxVolume, ctx.audio]);

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
                <li key={r.id}>“{r.reveal?.title}” — {r.reveal ? artistCredits(r.reveal) : ""}</li>
              ))}
              {stats.nobody.length > 4 && <li>e mais {stats.nobody.length - 4}</li>}
            </ul>
          ) : (
            "Todas as músicas foram acertadas!"
          )}
        </Stat>
      </div>

      {isHostStyle(state) ? (
        <>
          <p className="font-display text-2xl text-white/70">O apresentador pode começar a revanche pelo celular.</p>
          {votes > 0 && <p className="text-white/70 text-xl">{votes} jogador{votes > 1 ? "es querem" : " quer"} jogar de novo!</p>}
        </>
      ) : (
        <FinalControls state={state} code={ctx.code} token={ctx.host} />
      )}
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
