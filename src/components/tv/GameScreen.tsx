"use client";
import { useEffect, useRef, useState } from "react";
import { Button, Equalizer, Spinner, TeamChip } from "@/components/ui";
import { useNow } from "@/hooks/useNow";
import { api } from "@/lib/api";
import { textOn } from "@/lib/colors";
import { friendlyError } from "@/lib/errors";
import {
  currentAttempt,
  currentRound,
  formatSeconds,
  lateTaps,
  ranking,
  roundAttempts,
  roundDelta,
  teamById,
} from "@/lib/game";
import type { Attempt, RoomState, Round } from "@/lib/types";
import { getMode } from "@/modes";
import type { TvCtx } from "./TvApp";

const REVEAL_MS = 11000; // revelação (a música toca alguns segundos)
const SCOREBOARD_MS = 7000; // placar entre as rodadas

export function GameScreen({ state, ctx }: { state: RoomState; ctx: TvCtx }) {
  const round = currentRound(state);
  const attempt = currentAttempt(state, round);
  const paused = state.room.paused;
  const [loaded, setLoaded] = useState<{ roundId: string; buffer: AudioBuffer } | null>(null);
  const [loadMsg, setLoadMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { code, owner, audio } = ctx;

  const roundId = round?.id;
  const roundNo = round?.round_no ?? 0;
  const status = round?.status;

  // ao trocar de rodada: silencia o que estiver tocando
  useEffect(() => {
    audio.stopAll();
  }, [roundId, audio]);

  // carrega a música da rodada (link atualizado da prévia) e pré-carrega a próxima
  useEffect(() => {
    if (!roundId) return;
    let alive = true;
    (async () => {
      for (let tries = 1; tries <= 3 && alive; tries++) {
        try {
          const list = await api.hostTracks(code, owner);
          const cur = list.find((t) => t.round_no === roundNo);
          if (!cur) throw new Error("Música não encontrada");
          const { buffer, artists } = await audio.load(cur.deezer_id);
          if (!alive) return;
          setLoaded({ roundId, buffer });
          setLoadMsg(null);
          const next = list.find((t) => t.round_no === roundNo + 1);
          if (next) audio.load(next.deezer_id).catch(() => {});
          await api.roundBegin(code, owner, roundId, artists); // não faz nada se a rodada já abriu
          return;
        } catch (e) {
          if (!alive) return;
          setLoadMsg(`Problema ao carregar a música (${(e as Error).message}). Tentativa ${tries}/3…`);
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
      // não deu: pula a música para o jogo não travar
      if (alive) api.skipRound(code, owner, roundId).catch(() => {});
    })();
    return () => {
      alive = false;
    };
  }, [roundId, roundNo, code, owner, audio]);

  const buffer = loaded && loaded.roundId === roundId ? loaded.buffer : null;

  // revelação: toca a música alguns segundos
  const revealedFor = useRef<string | null>(null);
  useEffect(() => {
    if (status !== "revealed" || !buffer || !roundId || revealedFor.current === roundId) return;
    revealedFor.current = roundId;
    audio.stopAll();
    audio.play(buffer, 0, REVEAL_MS / 1000 - 0.5, undefined, 2.5);
  }, [status, buffer, roundId, audio]);

  // avanço automático: revelação -> placar -> próxima rodada (a pausa segura)
  useEffect(() => {
    if (!roundId || paused) return;
    if (status === "revealed") {
      const t = setTimeout(() => api.showScoreboard(code, owner, roundId).catch(() => {}), REVEAL_MS);
      return () => clearTimeout(t);
    }
    if (status === "scoreboard") {
      const t = setTimeout(() => api.nextRound(code, owner, roundNo).catch(() => {}), SCOREBOARD_MS);
      return () => clearTimeout(t);
    }
  }, [status, roundId, roundNo, paused, code, owner]);

  // fim do tempo de resposta: pede ao servidor para conferir o prazo
  const deadline = attempt?.status === "open" ? attempt.deadline : null;
  useEffect(() => {
    if (!deadline || paused) return;
    const ms = Date.parse(deadline) + 1600 - ctx.serverNow();
    const t = setTimeout(() => api.tick(code).catch(() => {}), Math.max(0, ms));
    return () => clearTimeout(t);
  }, [deadline, paused, code, ctx]);

  // pausa: silencia na hora
  useEffect(() => {
    if (paused) audio.stopAll();
  }, [paused, audio]);

  if (!round) return <div className="flex flex-1 items-center justify-center"><Spinner label="Preparando…" /></div>;
  const mode = getMode(round.mode);
  const Engine = mode.TvEngine;
  const attemptCount = state.attempts.filter((a) => a.round_id === round.id).length;

  const run = (fn: () => Promise<unknown>) => {
    setError(null);
    fn().catch((e) => setError(friendlyError(e)));
  };

  return (
    <div className="relative flex flex-1 flex-col gap-4 p-6 lg:p-8">
      <Engine code={code} owner={owner} round={round} paused={paused} attemptCount={attemptCount} buffer={buffer} audio={audio} />
      <TopBar state={state} round={round} />

      <div className="flex flex-1 flex-col items-center justify-center">
        {round.status === "loading" && (
          <div className="flex flex-col items-center gap-4">
            <Spinner label={loadMsg ?? "Preparando a música…"} />
          </div>
        )}
        {(round.status === "playing" || round.status === "answering" || round.status === "doubt") && (
          <RoundView state={state} round={round} attempt={attempt} ctx={ctx} />
        )}
        {round.status === "revealed" && <RevealView state={state} round={round} ctx={ctx} onError={setError} />}
        {round.status === "scoreboard" && <ScoreboardView state={state} round={round} ctx={ctx} />}
      </div>

      {error && <p className="text-center text-rose-300">{error}</p>}

      {/* controles do dono */}
      <div className="flex flex-wrap items-center justify-center gap-3 opacity-80 hover:opacity-100">
        <Button variant="secondary" onClick={() => run(() => api.pause(code, owner, !paused))}>
          {paused ? "▶ Continuar" : "⏸ Pausar"}
        </Button>
        {["loading", "playing", "answering", "doubt"].includes(round.status) && (
          <Button variant="secondary" onClick={() => run(() => api.skipRound(code, owner, round.id))}>⏭ Pular música</Button>
        )}
        {attempt?.status === "open" && (
          <Button variant="secondary" onClick={() => run(() => api.endTurn(code, owner, attempt.id))}>⏹ Encerrar vez (erro)</Button>
        )}
        {(round.status === "revealed" || round.status === "scoreboard") && (
          <Button variant="secondary" onClick={() => run(() => api.nextRound(code, owner, round.round_no))}>
            {state.room.round_no >= state.room.total_rounds ? "🏁 Ver resultado" : "Próxima música →"}
          </Button>
        )}
        <Button
          variant="ghost"
          onClick={() => {
            if (window.confirm("Encerrar a partida agora?")) run(() => api.finishMatch(code, owner));
          }}
        >
          Encerrar partida
        </Button>
      </div>

      {paused && (
        <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-black/60">
          <p className="font-display text-8xl font-bold text-yellow-300">PAUSADO</p>
        </div>
      )}
    </div>
  );
}

function TopBar({ state, round }: { state: RoomState; round: Round }) {
  return (
    <div className="flex flex-wrap items-center gap-4">
      <div className="font-display text-3xl">
        Rodada <b className="text-yellow-300">{round.round_no}</b>
        <span className="text-white/50"> / {state.room.total_rounds}</span>
      </div>
      <div className="ml-auto flex flex-wrap gap-2">
        {ranking(state.teams).map(({ team }) => (
          <TeamChip key={team.id} team={team} className="text-xl">
            {team.name} <b>{team.score}</b>
          </TeamChip>
        ))}
      </div>
      <div className="rounded-xl bg-white/10 px-3 py-1 font-display text-xl">Sala {state.room.code}</div>
    </div>
  );
}

function StageBar({ round }: { round: Round }) {
  const mode = getMode(round.mode);
  return (
    <div className="grid w-full max-w-5xl gap-2" style={{ gridTemplateColumns: `repeat(${mode.stages.length}, 1fr)` }}>
      {mode.stages.map((s, i) => {
        const n = i + 1;
        const state = n < round.stage ? "past" : n === round.stage ? "now" : "next";
        return (
          <div
            key={n}
            className={`rounded-2xl px-2 py-3 text-center font-display transition ${
              state === "now"
                ? "bg-yellow-300 text-violet-950 scale-105 shadow-lg"
                : state === "past"
                  ? "bg-white/10 text-white/40"
                  : "bg-white/20 text-white/90"
            }`}
          >
            <div className="text-2xl font-bold">{s.seconds}s</div>
            <div className="text-lg">{s.points} pts</div>
          </div>
        );
      })}
    </div>
  );
}

function RoundView({ state, round, attempt, ctx }: { state: RoomState; round: Round; attempt?: Attempt; ctx: TvCtx }) {
  const mode = getMode(round.mode);
  const pts = mode.stages[Math.max(0, round.stage - 1)]?.points ?? 0;
  const locked = teamById(state, round.locked_team_id);
  const scoring = state.room.settings.scoring;
  return (
    <div className="flex w-full flex-col items-center gap-8">
      <StageBar round={round} />
      <div className="flex flex-wrap items-center justify-center gap-4 font-display text-3xl">
        <span>
          Valendo <b className="text-yellow-300 text-5xl">{round.had_error ? Math.round(pts / 2) : pts}</b> pts
          {scoring === "artist_title" && <span className="text-white/60 text-2xl"> (+50% com o título)</span>}
        </span>
        {round.had_error && <span className="rounded-full bg-pink-500 px-4 py-1 text-2xl">🏴‍☠️ roubo vale metade</span>}
        {locked && (
          <span className="rounded-full bg-slate-500 px-4 py-1 text-2xl">
            🔒 {locked.name} bloqueado
          </span>
        )}
      </div>

      {round.status === "playing" && (
        <div className="flex flex-col items-center gap-4 text-pink-300">
          <Equalizer className="h-24 [&>span]:w-5" />
          <p className="font-display text-4xl text-white">Sabe qual é? Aperte <b className="text-yellow-300">EU SEI!</b> no celular</p>
        </div>
      )}
      {round.status === "answering" && attempt && <TurnPanel state={state} attempt={attempt} ctx={ctx} />}
      {round.status === "doubt" && attempt && <DoubtPanel state={state} attempt={attempt} ctx={ctx} />}
    </div>
  );
}

function TurnPanel({ state, attempt, ctx }: { state: RoomState; attempt: Attempt; ctx: TvCtx }) {
  const team = teamById(state, attempt.team_id);
  const player = state.players.find((p) => p.id === attempt.player_id);
  const now = useNow(ctx.serverNow, 100);
  const left = attempt.deadline ? Math.max(0, Date.parse(attempt.deadline) - now) : null;
  const late = lateTaps(state, attempt);
  if (!team) return null;
  return (
    <div className="npl-pop flex w-full max-w-4xl flex-col items-center gap-4 rounded-[2.5rem] p-8 text-center" style={{ background: team.color, color: textOn(team.color) }}>
      <p className="font-display text-3xl opacity-80">{player?.nickname ?? "Alguém"} apertou!</p>
      <p className="font-display text-7xl font-bold">{team.name}</p>
      <p className="font-display text-3xl">está respondendo…</p>
      {left !== null ? (
        <p className="font-display text-9xl font-bold tabular-nums">{Math.ceil(left / 1000)}</p>
      ) : (
        <p className="font-display text-3xl opacity-80">sem limite de tempo</p>
      )}
      {late.length > 0 && (
        <div className="flex flex-wrap justify-center gap-2 text-xl">
          {late.map((l, i) =>
            l.team ? (
              <TeamChip key={i} team={l.team} className="border-2 border-black/20">
                {l.team.name} apertou {formatSeconds(l.ms)}s depois
              </TeamChip>
            ) : null,
          )}
        </div>
      )}
    </div>
  );
}

function DoubtPanel({ state, attempt, ctx }: { state: RoomState; attempt: Attempt; ctx: TvCtx }) {
  const team = teamById(state, attempt.team_id);
  const [answer, setAnswer] = useState<{ title: string; artist: string; artists: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.hostAnswer(ctx.code, ctx.owner).then(setAnswer).catch(() => {});
  }, [ctx.code, ctx.owner, attempt.id]);
  const judge = async (accept: boolean) => {
    setBusy(true);
    try {
      await api.judge(ctx.code, ctx.owner, attempt.id, accept);
    } finally {
      setBusy(false);
    }
  };
  const showArtist = state.room.settings.scoring === "artist_title";
  return (
    <div className="npl-pop flex w-full max-w-5xl flex-col items-center gap-6 rounded-[2.5rem] bg-white/10 border-4 border-yellow-300 p-8">
      <p className="font-display text-6xl font-bold text-yellow-300">Valeu ou não valeu?</p>
      {team && <TeamChip team={team} className="text-3xl px-6 py-2" />}
      <div className="grid w-full gap-4 text-2xl md:grid-cols-2">
        {showArtist && (
          <Compare label="Artista" typed={attempt.answer_artist} right={answer ? answer.artists.join(", ") : "…"} result={attempt.artist_result} />
        )}
        <Compare label="Música" typed={attempt.answer_title} right={answer?.title ?? "…"} result={attempt.title_result} />
      </div>
      <div className="flex gap-6">
        <Button variant="success" className="text-4xl px-12 py-5" disabled={busy} onClick={() => judge(true)}>👍 Valeu</Button>
        <Button variant="danger" className="text-4xl px-12 py-5" disabled={busy} onClick={() => judge(false)}>👎 Não valeu</Button>
      </div>
      <p className="text-white/60">Só o dono da sala decide.</p>
    </div>
  );
}

function Compare({ label, typed, right, result }: { label: string; typed: string | null; right: string; result: string | null }) {
  const tag = result === "ok" ? "✅" : result === "doubt" ? "🤔" : result === "wrong" ? "❌" : "—";
  return (
    <div className={`rounded-2xl p-4 ${result === "doubt" ? "bg-yellow-300/20 border-2 border-yellow-300" : "bg-black/20"}`}>
      <p className="text-white/60 text-lg">{label} {tag}</p>
      <p>Digitado: <b>{typed || "—"}</b></p>
      <p>Certo: <b className="text-emerald-300">{right}</b></p>
    </div>
  );
}

function RevealView({ state, round, ctx, onError }: { state: RoomState; round: Round; ctx: TvCtx; onError: (m: string) => void }) {
  const r = round.reveal;
  const winner = teamById(state, round.winner_team_id);
  const attempts = roundAttempts(state, round);
  const winAttempt = attempts.find((a) => a.status === "correct" && a.team_id === round.winner_team_id);
  return (
    <div className="flex w-full max-w-6xl flex-col items-center gap-6 lg:flex-row lg:items-center lg:gap-10">
      {r?.cover && (
        // eslint-disable-next-line @next/next/no-img-element -- capa do Deezer
        <img src={r.cover} alt="" className="npl-pop h-72 w-72 rounded-3xl shadow-2xl lg:h-96 lg:w-96" />
      )}
      <div className="flex flex-1 flex-col gap-4 text-center lg:text-left">
        <p className="font-display text-6xl font-bold leading-tight">{r?.title}</p>
        <p className="font-display text-4xl text-pink-300">{r?.artists?.join(", ") || r?.artist}</p>
        {winner ? (
          <div className="flex flex-wrap items-center justify-center gap-3 lg:justify-start">
            <TeamChip team={winner} className="text-4xl px-6 py-2">🎉 {winner.name}</TeamChip>
            <span className="font-display text-5xl font-bold text-yellow-300">+{round.points}</span>
            {winAttempt?.steal && <span className="rounded-full bg-pink-500 px-3 py-1 text-xl">roubo</span>}
          </div>
        ) : (
          <p className="font-display text-4xl text-white/70">{round.skipped ? "Música pulada" : "Ninguém acertou 😅"}</p>
        )}
        {attempts.length > 0 && (
          <ul className="flex flex-col gap-2 text-lg">
            {attempts.map((a) => (
              <AttemptRow key={a.id} state={state} a={a} ctx={ctx} onError={onError} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function AttemptRow({ state, a, ctx, onError }: { state: RoomState; a: Attempt; ctx: TvCtx; onError: (m: string) => void }) {
  const team = teamById(state, a.team_id);
  const label = { correct: "acertou", wrong: "errou", timeout: "tempo esgotado", open: "respondendo", doubt: "em dúvida", cancelled: "", late: "" }[a.status];
  const typed = [a.answer_artist, a.answer_title].filter(Boolean).join(" · ");
  return (
    <li className="flex flex-wrap items-center gap-3 rounded-xl bg-white/10 px-3 py-2">
      {team && <TeamChip team={team} />}
      <span className={a.status === "correct" ? "text-emerald-300" : "text-rose-300"}>{label}</span>
      {typed && <span className="text-white/70">“{typed}”</span>}
      <span className="font-display">{a.points > 0 ? `+${a.points}` : a.points < 0 ? a.points : ""}</span>
      {a.overridden && <span className="text-xs text-yellow-300">(decisão do dono)</span>}
      {(a.status === "correct" || a.status === "wrong" || a.status === "timeout") && (
        <button
          className="ml-auto rounded-lg bg-white/15 px-3 py-1 text-sm hover:bg-white/25"
          onClick={() => api.override(ctx.code, ctx.owner, a.id, a.status !== "correct").catch((e) => onError(friendlyError(e)))}
        >
          {a.status === "correct" ? "Inverter: não valeu" : "Inverter: valeu"}
        </button>
      )}
    </li>
  );
}

function ScoreboardView({ state, round, ctx }: { state: RoomState; round: Round; ctx: TvCtx }) {
  const delta = roundDelta(state, round);
  return (
    <div className="flex w-full max-w-4xl flex-col gap-3">
      <p className="font-display text-5xl font-bold text-center mb-2">Placar</p>
      {ranking(state.teams).map(({ team, pos }) => {
        const d = delta.get(team.id) ?? 0;
        return (
          <div key={team.id} className="npl-pop flex items-center gap-4 rounded-3xl px-6 py-4" style={{ background: team.color, color: textOn(team.color) }}>
            <span className="font-display text-5xl font-bold w-16">{pos}º</span>
            <span className="font-display text-4xl font-semibold flex-1 truncate">{team.name}</span>
            {d !== 0 && <span className="font-display text-3xl opacity-80">{d > 0 ? `+${d}` : d}</span>}
            <span className="font-display text-5xl font-bold tabular-nums">{team.score}</span>
            <span className="flex flex-col gap-1">
              <button className="rounded bg-black/20 px-2 text-sm" title="Corrigir placar +10" onClick={() => api.adjustScore(ctx.code, ctx.owner, team.id, 10)}>+10</button>
              <button className="rounded bg-black/20 px-2 text-sm" title="Corrigir placar −10" onClick={() => api.adjustScore(ctx.code, ctx.owner, team.id, -10)}>−10</button>
            </span>
          </div>
        );
      })}
    </div>
  );
}
