"use client";
import { useEffect, useState } from "react";
import { FinalControls } from "@/components/control/FinalControls";
import { GameControls, OverrideButtons, useGameActions } from "@/components/control/GameControls";
import { SettingsForm } from "@/components/control/SettingsForm";
import { TeamsBoard } from "@/components/control/TeamsBoard";
import { RoomTheme } from "@/components/EmojiRain";
import { Button, Spinner, TeamChip } from "@/components/ui";
import { useNow } from "@/hooks/useNow";
import { type Peers, useRoom } from "@/hooks/useRoom";
import { useWakeLock } from "@/hooks/useWakeLock";
import { api } from "@/lib/api";
import { textOn } from "@/lib/colors";
import { friendlyError } from "@/lib/errors";
import {
  attemptParts,
  currentRound,
  lockedTeams,
  lockLabel,
  artistCredits,
  missingParts,
  partPoints,
  ranking,
  roundAttempts,
  teamById,
  finalRanking,
  tiebreakLeft,
  tiebreakOf,
} from "@/lib/game";
import type { Attempt, RoomState, Round } from "@/lib/types";
import { getMode } from "@/modes";
import { teamLabel } from "@/lib/icons";

type Answer = { round_id: string; title: string; artist: string; artists: string[]; line?: string | null } | null;

/** Celular do apresentador (estilo "Com apresentador"): ele não joga, só comanda. */
export function PresenterApp({ code, token }: { code: string; token: string }) {
  const { state, notFound, connected, peers, serverNow } = useRoom(code, { kind: "owner", owner: true });
  useWakeLock(true);

  if (notFound) return <p className="p-8 text-center font-display text-2xl">Sala {code} não encontrada 😕</p>;
  if (!state) return <div className="flex flex-1 items-center justify-center"><Spinner label="Conectando…" /></div>;
  const phase = state.room.phase;

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <RoomTheme theme={state.room.settings.theme} />
      <header className="flex items-center gap-2 bg-black/30 px-4 py-2">
        <span className="font-display text-lg font-semibold">🎤 Apresentador</span>
        <span className="font-display text-white/70">· Sala {code}</span>
        {!connected && <span className="ml-auto h-2 w-2 rounded-full bg-amber-400" title="reconectando" />}
      </header>
      <TvWarning peers={peers} connected={connected} />
      <main className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
        {phase === "config" && (
          <SettingsForm state={state} code={code} token={token} onDone={() => api.setPhase(code, token, "lobby").catch(() => {})} />
        )}
        {phase === "lobby" && (
          <TeamsBoard
            state={state}
            online={peers.players}
            compact
            control={{ code, token, onConfig: () => api.setPhase(code, token, "config").catch(() => {}) }}
          />
        )}
        {phase === "playing" && <PresenterGame state={state} code={code} token={token} serverNow={serverNow} />}
        {phase === "finished" && (
          <div className="flex flex-col gap-4">
            <p className="text-center font-display text-4xl font-bold text-yellow-300">Fim de jogo!</p>
            <ScoreList state={state} />
            <FinalControls state={state} code={code} token={token} compact />
          </div>
        )}
      </main>
    </div>
  );
}

function TvWarning({ peers, connected }: { peers: Peers; connected: boolean }) {
  if (!connected) return null;
  const msg = !peers.tv ? "⚠️ A TV não está conectada." : !peers.tvAudio ? "⚠️ Clique em “Começar” na TV para liberar o som." : null;
  return msg ? <p className="bg-amber-500/90 px-4 py-2 text-sm text-black">{msg}</p> : null;
}

function PresenterGame({ state, code, token, serverNow }: { state: RoomState; code: string; token: string; serverNow: () => number }) {
  const g = useGameActions(state, code, token);
  const { round, attempt } = g;
  const now = useNow(serverNow, 250);
  const [answer, setAnswer] = useState<Answer>(null);
  const roundId = round?.id;
  const status = round?.status;

  // resposta certa: o apresentador não joga, então vê desde o início da rodada
  useEffect(() => {
    if (!roundId || status === "loading") return;
    let alive = true;
    api
      .hostAnswer(code, token)
      .then((a) => alive && setAnswer(a))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [roundId, status, code, token]);

  if (!round) return <Spinner label="Preparando…" />;
  const ans = answer && answer.round_id === round.id ? answer : null;
  const mode = getMode(round.mode);
  const stage = mode.stages[round.stage - 1];
  const ModePanel = mode.PresenterRoundView;
  const locks = lockedTeams(state, round, now);
  const tb = tiebreakOf(round);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between font-display">
        {tb ? (
          <span className="text-xl font-bold text-rose-300">☠️ Morte súbita{tb.n > 1 ? ` · extra ${tb.n}` : ""}</span>
        ) : (
          <span className="text-xl">Rodada <b className="text-yellow-300">{round.round_no}</b>/{state.room.total_rounds}</span>
        )}
        {stage && round.status !== "loading" && (
          <span className="text-lg text-white/80">
            {round.mode === "lyrics" ? `Verso ${round.stage}` : `Trecho ${round.stage} · ${stage.seconds}s`}
            {tb ? "" : ` · ${stage.points} pts`}
          </span>
        )}
      </div>
      {tb && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl bg-rose-500/15 px-3 py-2">
          <span className="text-sm text-rose-200">Desempate (vale a música):</span>
          {tb.teams.map((id) => {
            const t = teamById(state, id);
            const out = !tiebreakLeft(tb).includes(id);
            return t ? <TeamChip key={id} team={t} className={out ? "opacity-40 line-through" : ""}>{t.name}</TeamChip> : null;
          })}
        </div>
      )}

      {round.status === "loading" ? (
        <Spinner label="Carregando a música na TV…" />
      ) : (
        <AnswerCard state={state} round={round} answer={ans} />
      )}

      {ModePanel && ["playing", "answering", "doubt"].includes(round.status) && <ModePanel state={state} round={round} now={now} />}

      {locks.length > 0 && round.status === "playing" && (
        <div className="flex flex-wrap gap-2">
          {locks.map((l) => (
            <TeamChip key={l.team.id} team={l.team} className="opacity-70 tabular-nums">🔒 {l.team.name} {lockLabel(l, round)}</TeamChip>
          ))}
        </div>
      )}

      {round.status === "answering" && attempt && <TurnCard state={state} attempt={attempt} now={now} code={code} token={token} />}
      {round.status === "doubt" && attempt && <DoubtCard state={state} attempt={attempt} answer={ans} code={code} token={token} />}
      {(round.status === "revealed" || round.status === "scoreboard") && <Decisions state={state} round={round} code={code} token={token} />}

      <GameControls g={g} state={state} />
      {state.room.paused && (
        <p className="rounded-xl bg-yellow-300 px-3 py-2 text-center font-display text-violet-950">
          ⏸ Jogo pausado{state.room.pause_reason === "owner_away" ? " (seu celular tinha desconectado)" : ""}
        </p>
      )}
      <ScoreFix state={state} code={code} token={token} />
    </div>
  );
}

function AnswerCard({ state, round, answer }: { state: RoomState; round: Round; answer: Answer }) {
  const need = missingParts(state, round);
  const both = state.room.settings.scoring === "artist_title";
  return (
    <div className="rounded-2xl border-2 border-emerald-400/60 bg-emerald-500/10 p-3 text-left">
      <p className="text-xs uppercase tracking-wide text-emerald-300">Resposta certa (só você vê)</p>
      {answer?.line && round.mode === "continue" && (
        <p className="mb-2 rounded-xl bg-yellow-300 px-3 py-2 font-display text-2xl font-bold text-violet-950">
          🎤 “{answer.line}” {!need.title && "✓"}
        </p>
      )}
      {answer ? (
        <>
          <p className="font-display text-2xl font-bold">
            🎵 {answer.title} {!need.title && round.mode !== "continue" && <span className="text-emerald-300">✓</span>}
          </p>
          <p className="font-display text-xl text-pink-200">
            🎤 {artistCredits(answer)}{" "}
            {both && !need.artist && <span className="text-emerald-300">✓</span>}
          </p>
        </>
      ) : (
        <p className="text-white/60">carregando…</p>
      )}
    </div>
  );
}

function TurnCard({ state, attempt, now, code, token }: { state: RoomState; attempt: Attempt; now: number; code: string; token: string }) {
  const team = teamById(state, attempt.team_id);
  const round = currentRound(state)!;
  const left = attempt.deadline ? Math.max(0, Date.parse(attempt.deadline) - now) : null;
  const spoken = state.room.settings.answerMode === "spoken";
  const need = missingParts(state, round);
  const pts = (n: number) => (n ? ` +${n}` : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decide = async (artist: boolean, title: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await api.decide(code, token, attempt.id, artist, title);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };
  if (!team) return null;
  const btn = "flex-1 min-w-[45%] text-lg py-4";
  return (
    <div className="flex flex-col gap-3 rounded-2xl p-3" style={{ background: `${team.color}33`, border: `3px solid ${team.color}` }}>
      <div className="flex items-center justify-between rounded-xl px-3 py-2" style={{ background: team.color, color: textOn(team.color) }}>
        <span className="font-display text-xl font-bold">{teamLabel(team)} {spoken ? "vai falar" : "está digitando"}</span>
        <span className="font-display text-4xl font-bold tabular-nums">{left !== null ? Math.ceil(left / 1000) : "∞"}</span>
      </div>
      {spoken ? (
        <div className="flex flex-wrap gap-2">
          {need.artist && (
            <Button variant="success" className={btn} disabled={busy} onClick={() => decide(true, false)}>🎤 Artista certo{pts(partPoints(round, "artist"))}</Button>
          )}
          {need.title && (
            <Button variant="success" className={btn} disabled={busy} onClick={() => decide(false, true)}>{round.mode === "continue" ? "✅ Acertou" : "🎵 Música certa"}{pts(partPoints(round, "title"))}</Button>
          )}
          {need.artist && need.title && (
            <Button variant="success" className={btn} disabled={busy} onClick={() => decide(true, true)}>✅ Os dois{pts(partPoints(round, "artist") + partPoints(round, "title"))}</Button>
          )}
          <Button variant="danger" className={btn} disabled={busy} onClick={() => decide(false, false)}>❌ Errou</Button>
        </div>
      ) : (
        <p className="text-center text-white/70">O sistema confere a resposta digitada. Se ficar em dúvida, você decide aqui.</p>
      )}
      {error && <p className="text-rose-300">{error}</p>}
    </div>
  );
}

function DoubtCard({ state, attempt, answer, code, token }: { state: RoomState; attempt: Attempt; answer: Answer; code: string; token: string }) {
  const team = teamById(state, attempt.team_id);
  const [busy, setBusy] = useState(false);
  const judge = async (accept: boolean) => {
    setBusy(true);
    try {
      await api.judge(code, token, attempt.id, accept);
    } finally {
      setBusy(false);
    }
  };
  const rows: [string, string | null, string, string | null][] = [];
  if (attempt.answer_artist !== null || attempt.artist_result === "doubt")
    rows.push(["Artista", attempt.answer_artist, answer ? artistCredits(answer) : "…", attempt.artist_result]);
  const contRound = state.rounds.find((r) => r.id === attempt.round_id)?.mode === "continue";
  rows.push(contRound ? ["Linha", attempt.answer_title, answer?.line ?? "…", attempt.title_result] : ["Música", attempt.answer_title, answer?.title ?? "…", attempt.title_result]);
  return (
    <div className="flex flex-col gap-3 rounded-2xl border-4 border-yellow-300 bg-white/10 p-3">
      <p className="text-center font-display text-3xl font-bold text-yellow-300">Valeu ou não valeu?</p>
      {team && <TeamChip team={team} className="self-center text-xl" />}
      {rows.map(([label, typed, right, res]) => (
        <div key={label} className={`rounded-xl p-2 text-left ${res === "doubt" ? "border-2 border-yellow-300 bg-yellow-300/15" : "bg-black/20"}`}>
          <p className="text-sm text-white/60">{label} {res === "ok" ? "✅" : res === "doubt" ? "🤔" : res === "wrong" ? "❌" : "—"}</p>
          <p>Digitado: <b>{typed || "—"}</b></p>
          <p>Certo: <b className="text-emerald-300">{right}</b></p>
        </div>
      ))}
      <div className="flex gap-2">
        <Button variant="success" className="flex-1 text-2xl py-4" disabled={busy} onClick={() => judge(true)}>👍 Valeu</Button>
        <Button variant="danger" className="flex-1 text-2xl py-4" disabled={busy} onClick={() => judge(false)}>👎 Não valeu</Button>
      </div>
    </div>
  );
}

/** Tentativas da rodada com "Inverter decisão". */
function Decisions({ state, round, code, token }: { state: RoomState; round: Round; code: string; token: string }) {
  const [error, setError] = useState<string | null>(null);
  const attempts = roundAttempts(state, round).filter((a) => ["correct", "wrong", "timeout"].includes(a.status));
  if (!attempts.length) return <p className="text-center text-white/60">{round.skipped ? "Música pulada" : "Ninguém acertou"}</p>;
  return (
    <div className="flex flex-col gap-2">
      <p className="font-display text-lg">Decisões (toque para inverter)</p>
      {attempts.map((a) => {
        const t = teamById(state, a.team_id);
        return (
          <div key={a.id} className="flex flex-col gap-1 rounded-xl bg-white/10 p-2">
            <div className="flex flex-wrap items-center gap-2">
              {t && <TeamChip team={t} />}
              <span className={a.status === "correct" ? "text-emerald-300" : "text-rose-300"}>
                {a.status === "correct" ? `acertou ${attemptParts(a)}` : a.status === "timeout" ? "tempo esgotado" : "errou"}
              </span>
              <span className="font-display">{a.points > 0 ? `+${a.points}` : a.points || ""}</span>
            </div>
            {(a.answer_artist || a.answer_title) && (
              <p className="text-sm text-white/70">“{[a.answer_artist, a.answer_title].filter(Boolean).join(" · ")}”</p>
            )}
            <OverrideButtons state={state} attempt={a} code={code} token={token} onError={setError} />
          </div>
        );
      })}
      {error && <p className="text-rose-300">{error}</p>}
    </div>
  );
}

function ScoreList({ state }: { state: RoomState }) {
  return (
    <div className="flex flex-col gap-2">
      {finalRanking(state).map(({ team, pos, wonTiebreak }) => (
        <div key={team.id} className="flex items-center gap-3 rounded-xl px-3 py-2" style={{ background: team.color, color: textOn(team.color) }}>
          <span className="font-display text-2xl font-bold w-10">{pos}º</span>
          <span className="flex-1 font-display text-xl truncate">
            {teamLabel(team)}
            {wonTiebreak && <span className="block text-xs font-sans opacity-80">venceu no desempate</span>}
          </span>
          <span className="font-display text-2xl font-bold tabular-nums">{team.score}</span>
        </div>
      ))}
    </div>
  );
}

/** Corrigir placar (±10). */
function ScoreFix({ state, code, token }: { state: RoomState; code: string; token: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <Button variant="ghost" onClick={() => setOpen((v) => !v)}>{open ? "▾" : "▸"} Placar / corrigir pontos</Button>
      {open &&
        ranking(state.teams).map(({ team, pos }) => (
          <div key={team.id} className="flex items-center gap-2 rounded-xl px-3 py-2" style={{ background: team.color, color: textOn(team.color) }}>
            <span className="font-display w-8">{pos}º</span>
            <span className="flex-1 truncate font-display">{teamLabel(team)}</span>
            <button className="rounded-lg bg-black/25 px-3 py-1" onClick={() => api.adjustScore(code, token, team.id, -10).catch(() => {})}>−10</button>
            <span className="w-12 text-center font-display text-xl tabular-nums">{team.score}</span>
            <button className="rounded-lg bg-black/25 px-3 py-1" onClick={() => api.adjustScore(code, token, team.id, 10).catch(() => {})}>+10</button>
          </div>
        ))}
    </div>
  );
}
