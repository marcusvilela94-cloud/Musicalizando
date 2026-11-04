"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { GameControls, OverrideButtons, useGameActions } from "@/components/control/GameControls";
import { Button, Equalizer, Spinner, TeamChip } from "@/components/ui";
import { useNow } from "@/hooks/useNow";
import { api } from "@/lib/api";
import type { PlayHandle } from "@/lib/audio";
import { textOn } from "@/lib/colors";
import {
  artistPoints,
  attemptParts,
  currentAttempt,
  currentRound,
  formatSeconds,
  isHostStyle,
  lateTaps,
  lockedTeams,
  lockLabel,
  artistCredits,
  missingParts,
  ranking,
  recentDecision,
  roundAttempts,
  roundDelta,
  stagePoints,
  teamById,
} from "@/lib/game";
import { sharedSfx } from "@/lib/sfx";
import type { Attempt, RoomState, Round } from "@/lib/types";
import { getMode } from "@/modes";
import type { TvCtx } from "./TvApp";

/** A música da revelação espera o efeito sonoro terminar. */
const REVEAL_MUSIC_DELAY_MS = 1200;

export function GameScreen({ state, ctx }: { state: RoomState; ctx: TvCtx }) {
  const round = currentRound(state);
  const attempt = currentAttempt(state, round);
  const paused = state.room.paused;
  const hostStyle = isHostStyle(state);
  const [loaded, setLoaded] = useState<{ roundId: string; buffer: AudioBuffer } | null>(null);
  const [loadMsg, setLoadMsg] = useState<string | null>(null);
  const [clipPlaying, setClipPlaying] = useState(false);
  const { code, host, audio, serverNow } = ctx;
  const sfx = sharedSfx();
  const now = useNow(serverNow, 250);

  // "Todos jogam": quem está na frente da TV comanda (botões + teclado)
  const g = useGameActions(state, code, host);

  const roundId = round?.id;
  const roundNo = round?.round_no ?? 0;
  const status = round?.status;
  const revealing = status === "revealed" || status === "scoreboard";

  useEffect(() => {
    sharedSfx().setEnabled(state.room.settings.sounds !== false);
    sharedSfx().setVolume(state.room.settings.sfxVolume);
  }, [state.room.settings.sounds, state.room.settings.sfxVolume]);

  // ao trocar de rodada: silencia o que estiver tocando
  useEffect(() => {
    audio.stopAll();
  }, [roundId, audio]);

  // carrega a música (link atualizado da prévia), sorteia os pontos de cada trecho e abre a rodada
  useEffect(() => {
    if (!roundId) return;
    let alive = true;
    (async () => {
      for (let tries = 1; tries <= 3 && alive; tries++) {
        try {
          const list = await api.hostTracks(code, host);
          const cur = list.find((t) => t.round_no === roundNo);
          if (!cur) throw new Error("Música não encontrada");
          const { buffer, artists } = await audio.load(cur.deezer_id);
          if (!alive) return;
          setLoaded({ roundId, buffer });
          setLoadMsg(null);
          const next = list.find((t) => t.round_no === roundNo + 1);
          if (next) audio.load(next.deezer_id).catch(() => {});
          // "Em sequência": todos os trechos começam no início da prévia; "Alternando": pontos sorteados
          const mode = getMode(currentRound(state)?.mode);
          const offsets = state.room.settings.clipMode === "alternate"
            ? mode.pickOffsets(buffer.duration)
            : mode.stages.map(() => 0);
          await api.roundBegin(code, host, roundId, artists, offsets); // não faz nada se a rodada já abriu
          return;
        } catch (e) {
          if (!alive) return;
          setLoadMsg(`Problema ao carregar a música (${(e as Error).message}). Tentativa ${tries}/3…`);
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
      // não deu: pula a música para o jogo não travar
      if (alive) api.skipRound(code, host, roundId).catch(() => {});
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- só ao trocar de rodada
  }, [roundId, roundNo, code, host, audio]);

  const buffer = loaded && loaded.roundId === roundId ? loaded.buffer : null;

  // ---- efeitos sonoros ----
  // "apertou!" quando um time ganha a vez
  const lastBuzz = useRef<string | null>(null);
  const openAttemptId = attempt?.status === "open" ? attempt.id : null;
  useEffect(() => {
    if (!openAttemptId || lastBuzz.current === openAttemptId) return;
    lastBuzz.current = openAttemptId;
    audio.stopAll();
    sfx.play("buzz");
  }, [openAttemptId, audio, sfx]);

  // acerto / erro
  const latest = round
    ? state.attempts
        .filter((a) => a.round_id === round.id && a.kind === "turn" && a.decided_at && ["correct", "wrong", "timeout"].includes(a.status))
        .sort((a, b) => Date.parse(b.decided_at!) - Date.parse(a.decided_at!))[0]
    : undefined;
  const latestKey = latest ? `${latest.id}:${latest.status}:${latest.artist_result}:${latest.title_result}` : null;
  const seenDecision = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (seenDecision.current === undefined) {
      seenDecision.current = latestKey; // ao carregar a tela não toca nada antigo
      return;
    }
    if (!latestKey || seenDecision.current === latestKey) return;
    seenDecision.current = latestKey;
    sfx.play(latestKey.split(":")[1] === "correct" ? "correct" : "wrong");
  }, [latestKey, sfx]);

  // tique-taque nos últimos 5 s do tempo de resposta
  const deadline = attempt?.status === "open" ? attempt.deadline : null;
  const lastTick = useRef<number | null>(null);
  useEffect(() => {
    if (!deadline || paused) return;
    const id = setInterval(() => {
      const left = Math.ceil((Date.parse(deadline) - serverNow()) / 1000);
      if (left >= 1 && left <= 5 && lastTick.current !== left) {
        lastTick.current = left;
        sfx.play("tick", { last: left === 1 });
      }
    }, 100);
    return () => clearInterval(id);
  }, [deadline, paused, serverNow, sfx]);

  // fim do tempo de resposta: pede ao servidor para conferir o prazo
  useEffect(() => {
    if (!deadline || paused) return;
    const ms = Date.parse(deadline) + 1600 - serverNow();
    const t = setTimeout(() => api.tick(code).catch(() => {}), Math.max(0, ms));
    return () => clearTimeout(t);
  }, [deadline, paused, code, serverNow]);

  // ---- revelação: efeito sonoro e depois a música (pausa para e continua de onde parou) ----
  const reveal = useRef<{ roundId: string; pos: number; done: boolean; announced: boolean } | null>(null);
  useEffect(() => {
    if (!revealing || !buffer || !roundId) return;
    if (!reveal.current || reveal.current.roundId !== roundId) {
      reveal.current = { roundId, pos: 0, done: false, announced: false };
    }
    const r = reveal.current;
    if (paused || r.done) return;
    let delay = 0;
    if (!r.announced) {
      r.announced = true;
      // acerto já tocou o som de acerto; sem vencedor toca o som de revelação
      const winner = !!currentRound(state)?.winner_team_id;
      if (!winner) sfx.play("reveal");
      delay = sfx.enabled ? Math.max(REVEAL_MUSIC_DELAY_MS, sfx.length(winner ? "correct" : "reveal") * 1000) : 0;
    }
    let handle: PlayHandle | null = null;
    const from = r.pos;
    const t = setTimeout(() => {
      audio.stopAll();
      handle = audio.play(buffer, from, buffer.duration - from, () => (r.done = true), 2.5);
    }, delay);
    return () => {
      clearTimeout(t);
      if (handle) r.pos = Math.min(buffer.duration, from + handle.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a revelação depende só destes sinais
  }, [revealing, buffer, roundId, paused, audio, sfx]);

  // pausa: silencia na hora
  useEffect(() => {
    if (paused) audio.stopAll();
  }, [paused, audio]);

  // atalhos de teclado ("Todos jogam"): espaço = Tocar, R = Repetir, → = Próximo trecho, P = Pausar
  const a = g.actions;
  const onKey = useCallback(
    (e: KeyboardEvent) => {
      if (hostStyle || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      const k = e.key.toLowerCase();
      if (k === " " || k === "r") {
        e.preventDefault();
        a.play();
      } else if (k === "arrowright") {
        e.preventDefault();
        if (g.can.next) a.next();
        else if (g.can.nextRound) a.nextRound();
      } else if (k === "p") {
        e.preventDefault();
        a.togglePause();
      }
    },
    [hostStyle, a, g.can.next, g.can.nextRound],
  );
  useEffect(() => {
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onKey]);

  if (!round) return <div className="flex flex-1 items-center justify-center"><Spinner label="Preparando…" /></div>;
  const Engine = getMode(round.mode).TvEngine;
  const flash = recentDecision(state, round, now);

  return (
    <div className="relative flex flex-1 flex-col gap-4 p-6 lg:p-8">
      <Engine round={round} paused={paused} buffer={buffer} audio={audio} serverNow={serverNow} onPlayingChange={setClipPlaying} />
      <TopBar state={state} round={round} now={now} />

      <div className="flex flex-1 flex-col items-center justify-center">
        {round.status === "loading" && <Spinner label={loadMsg ?? "Preparando a música…"} />}
        {(round.status === "playing" || round.status === "answering" || round.status === "doubt") && (
          <RoundView state={state} round={round} attempt={attempt} now={now} clipPlaying={clipPlaying} />
        )}
        {round.status === "revealed" && <RevealView state={state} round={round} ctx={ctx} contest={!hostStyle} />}
        {round.status === "scoreboard" && <ScoreboardView state={state} round={round} />}
      </div>

      {!hostStyle && (
        <div className="opacity-90 hover:opacity-100">
          <GameControls g={g} state={state} size="tv" />
        </div>
      )}

      {flash && round.status !== "revealed" && round.status !== "scoreboard" && <DecisionFlash state={state} attempt={flash} />}

      {paused && (
        <div className="pointer-events-none absolute inset-0 z-40 flex flex-col items-center justify-center gap-4 bg-black/60">
          <p className="font-display text-8xl font-bold text-yellow-300">PAUSADO</p>
          {!hostStyle && <p className="font-display text-2xl text-white/80">Aperte P ou “Continuar”</p>}
        </div>
      )}
    </div>
  );
}

function TopBar({ state, round, now }: { state: RoomState; round: Round; now: number }) {
  const locks = new Map(lockedTeams(state, round, now).map((l) => [l.team.id, l]));
  return (
    <div className="flex flex-wrap items-center gap-4">
      <div className="font-display text-3xl">
        Rodada <b className="text-yellow-300">{round.round_no}</b>
        <span className="text-white/50"> / {state.room.total_rounds}</span>
      </div>
      <div className="ml-auto flex flex-wrap gap-2">
        {ranking(state.teams).map(({ team }) => (
          <TeamChip key={team.id} team={team} className={`text-xl ${locks.has(team.id) ? "opacity-60" : ""}`}>
            {team.name} <b>{team.score}</b>
            {locks.has(team.id) && <span className="tabular-nums">🔒{locks.get(team.id)!.waiting ? "" : lockLabel(locks.get(team.id)!)}</span>}
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
        const st = n < round.stage ? "past" : n === round.stage ? "now" : "next";
        return (
          <div
            key={n}
            className={`rounded-2xl px-2 py-3 text-center font-display transition ${
              st === "now" ? "bg-yellow-300 text-violet-950 scale-105 shadow-lg" : st === "past" ? "bg-white/10 text-white/40" : "bg-white/20 text-white/90"
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

/** "Valendo": música 100%, artista 50% (o que ainda falta descobrir). */
function Worth({ state, round }: { state: RoomState; round: Round }) {
  const pts = stagePoints(round);
  const need = missingParts(state, round);
  if (state.room.settings.scoring === "title") {
    return <span>Valendo <b className="text-yellow-300 text-5xl">{pts}</b> pts</span>;
  }
  if (need.artist && need.title) {
    return (
      <span>
        Música <b className="text-yellow-300 text-5xl">{pts}</b> · Artista <b className="text-yellow-300 text-4xl">{artistPoints(pts)}</b>
        <span className="text-white/60 text-2xl"> · os dois {pts + artistPoints(pts)}</span>
      </span>
    );
  }
  return (
    <span>
      {need.title ? "Música" : "Artista"} valendo <b className="text-yellow-300 text-5xl">{need.title ? pts : artistPoints(pts)}</b> pts
    </span>
  );
}

function FoundParts({ state, round }: { state: RoomState; round: Round }) {
  const f = round.found ?? {};
  if (!f.artist && !f.title) return null;
  const need = missingParts(state, round);
  return (
    <div className="npl-pop flex flex-wrap items-center justify-center gap-3 rounded-2xl bg-emerald-500/20 border-2 border-emerald-400 px-6 py-3 font-display text-3xl">
      {f.artist && <span>Artista: <b>{f.artist}</b> ✓</span>}
      {f.title && <span>Música: <b>{f.title}</b> ✓</span>}
      <span className="text-white/70">— falta {need.title ? "a música" : "o artista"}</span>
    </div>
  );
}

function RoundView({ state, round, attempt, now, clipPlaying }: { state: RoomState; round: Round; attempt?: Attempt; now: number; clipPlaying: boolean }) {
  const locks = lockedTeams(state, round, now);
  return (
    <div className="flex w-full flex-col items-center gap-6">
      <StageBar round={round} />
      <div className="flex flex-wrap items-center justify-center gap-4 font-display text-3xl">
        <Worth state={state} round={round} />
        {locks.map((l) => (
          <span key={l.team.id} className="rounded-full px-4 py-1 text-2xl tabular-nums" style={{ background: l.team.color, color: textOn(l.team.color), opacity: 0.75 }}>
            🔒 {l.team.name} {lockLabel(l)}
          </span>
        ))}
      </div>
      <FoundParts state={state} round={round} />

      {round.status === "playing" && (
        <div className="flex flex-col items-center gap-4 text-pink-300">
          {clipPlaying ? (
            <Equalizer className="h-24 [&>span]:w-5" />
          ) : (
            <p className="font-display text-3xl text-white/60">
              {round.played_stage === 0 ? "🎧 Prontos? A música vai começar…" : "⏸ Trecho terminou"}
            </p>
          )}
          <p className="font-display text-4xl text-white">
            Sabe qual é? Aperte <b className="text-yellow-300">EU SEI!</b> no celular
          </p>
        </div>
      )}
      {round.status === "answering" && attempt && <TurnPanel state={state} attempt={attempt} now={now} />}
      {round.status === "doubt" && attempt && (
        <div className="npl-pop flex flex-col items-center gap-4 rounded-[2.5rem] border-4 border-yellow-300 bg-white/10 p-8">
          {teamById(state, attempt.team_id) && <TeamChip team={teamById(state, attempt.team_id)!} className="text-3xl px-6 py-2" />}
          <p className="font-display text-5xl text-yellow-300">Aguardando o apresentador decidir…</p>
        </div>
      )}
    </div>
  );
}

function TurnPanel({ state, attempt, now }: { state: RoomState; attempt: Attempt; now: number }) {
  const team = teamById(state, attempt.team_id);
  const player = state.players.find((p) => p.id === attempt.player_id);
  const left = attempt.deadline ? Math.max(0, Date.parse(attempt.deadline) - now) : null;
  const late = lateTaps(state, attempt);
  const spoken = state.room.settings.roomStyle === "host" && state.room.settings.answerMode === "spoken";
  if (!team) return null;
  return (
    <div className="npl-pop flex w-full max-w-4xl flex-col items-center gap-4 rounded-[2.5rem] p-8 text-center" style={{ background: team.color, color: textOn(team.color) }}>
      <p className="font-display text-3xl opacity-80">{player?.nickname ?? "Alguém"} apertou!</p>
      <p className="font-display text-7xl font-bold">{team.name}</p>
      <p className="font-display text-3xl">{spoken ? "Respondendo…" : "digitando a resposta…"}</p>
      {left !== null ? (
        <p className={`font-display text-9xl font-bold tabular-nums ${left <= 5000 ? "animate-pulse" : ""}`}>{Math.ceil(left / 1000)}</p>
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

/** Animação rápida de acerto/erro (sem revelar a resposta). */
function DecisionFlash({ state, attempt }: { state: RoomState; attempt: Attempt }) {
  const team = teamById(state, attempt.team_id);
  const ok = attempt.status === "correct";
  const parts = attemptParts(attempt);
  return (
    <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center">
      <div className={`npl-pop flex flex-col items-center gap-2 rounded-[3rem] px-16 py-10 shadow-2xl ${ok ? "bg-emerald-500" : "bg-rose-600"}`}>
        <p className="font-display text-9xl">{ok ? "✓" : "✗"}</p>
        <p className="font-display text-6xl font-bold">{ok ? `Acertou ${parts || ""}!` : attempt.status === "timeout" ? "Tempo esgotado!" : "Errou!"}</p>
        {team && <p className="font-display text-4xl">{team.name} {attempt.points > 0 ? `+${attempt.points}` : attempt.points < 0 ? attempt.points : ""}</p>}
      </div>
    </div>
  );
}

function RevealView({ state, round, ctx, contest }: { state: RoomState; round: Round; ctx: TvCtx; contest: boolean }) {
  const r = round.reveal;
  const attempts = roundAttempts(state, round);
  const delta = roundDelta(state, round);
  const artistTeam = teamById(state, round.artist_team_id);
  const titleTeam = teamById(state, round.title_team_id);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decided = attempts.filter((a) => ["correct", "wrong", "timeout"].includes(a.status));
  return (
    <div className="flex w-full max-w-6xl flex-col items-center gap-6 lg:flex-row lg:items-center lg:gap-10">
      {r?.cover && (
        // eslint-disable-next-line @next/next/no-img-element -- capa do Deezer
        <img src={r.cover} alt="" className="npl-pop h-72 w-72 rounded-3xl shadow-2xl lg:h-96 lg:w-96" />
      )}
      <div className="flex flex-1 flex-col gap-4 text-center lg:text-left">
        <p className="font-display text-6xl font-bold leading-tight">{r?.title}</p>
        <p className="font-display text-4xl text-pink-300">{r ? artistCredits(r) : ""}</p>
        {artistTeam || titleTeam ? (
          <div className="flex flex-wrap items-center justify-center gap-3 lg:justify-start">
            {titleTeam && titleTeam.id === artistTeam?.id ? (
              <TeamChip team={titleTeam} className="text-4xl px-6 py-2">🎉 {titleTeam.name} acertou tudo</TeamChip>
            ) : (
              <>
                {artistTeam && <TeamChip team={artistTeam} className="text-3xl px-5 py-2">🎤 Artista: {artistTeam.name}</TeamChip>}
                {titleTeam && <TeamChip team={titleTeam} className="text-3xl px-5 py-2">🎵 Música: {titleTeam.name}</TeamChip>}
              </>
            )}
            {[...delta.entries()].filter(([, d]) => d > 0).map(([tid, d]) => (
              <span key={tid} className="font-display text-4xl font-bold text-yellow-300">+{d}</span>
            ))}
          </div>
        ) : (
          <p className="font-display text-4xl text-white/70">{round.skipped ? "Música pulada" : "Ninguém acertou 😅"}</p>
        )}
        {attempts.length > 0 && (
          <ul className="flex flex-col gap-2 text-lg">
            {attempts.map((a) => (
              <AttemptRow key={a.id} state={state} a={a} />
            ))}
          </ul>
        )}
        {contest && decided.length > 0 && (
          <div className="flex flex-col gap-2">
            <Button variant="secondary" className="self-center lg:self-start" onClick={() => setOpen((v) => !v)}>
              {open ? "Fechar" : "⚖️ Contestar"}
            </Button>
            {open && (
              <div className="flex flex-col gap-2 rounded-2xl bg-black/30 p-3">
                <p className="text-white/70">O que cada tentativa realmente acertou? O placar é recalculado.</p>
                {decided.map((a) => {
                  const t = teamById(state, a.team_id);
                  return (
                    <div key={a.id} className="flex flex-wrap items-center gap-2">
                      {t && <TeamChip team={t} />}
                      <span className="text-white/70">“{[a.answer_artist, a.answer_title].filter(Boolean).join(" · ") || "—"}”</span>
                      <OverrideButtons state={state} attempt={a} code={ctx.code} token={ctx.host} onError={setError} />
                    </div>
                  );
                })}
                {error && <p className="text-rose-300">{error}</p>}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function AttemptRow({ state, a }: { state: RoomState; a: Attempt }) {
  const team = teamById(state, a.team_id);
  const parts = attemptParts(a);
  const label =
    a.status === "correct" ? `acertou ${parts}` : a.status === "timeout" ? "tempo esgotado" : a.status === "wrong" ? "errou" : a.status === "open" ? "respondendo" : "";
  const typed = [a.answer_artist, a.answer_title].filter(Boolean).join(" · ");
  return (
    <li className="flex flex-wrap items-center gap-3 rounded-xl bg-white/10 px-3 py-2">
      {team && <TeamChip team={team} />}
      <span className={a.status === "correct" ? "text-emerald-300" : "text-rose-300"}>{label}</span>
      {typed && <span className="text-white/70">“{typed}”</span>}
      <span className="font-display">{a.points > 0 ? `+${a.points}` : a.points < 0 ? a.points : ""}</span>
      {a.steal && a.status === "correct" && <span className="rounded-full bg-pink-500 px-2 text-sm">roubo</span>}
      {a.overridden && <span className="text-xs text-yellow-300">(decisão revista)</span>}
    </li>
  );
}

function ScoreboardView({ state, round }: { state: RoomState; round: Round }) {
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
          </div>
        );
      })}
    </div>
  );
}
