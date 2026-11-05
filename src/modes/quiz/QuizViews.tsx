"use client";
import { useEffect, useRef, useState } from "react";
import { TeamChip } from "@/components/ui";
import { vibrate } from "@/components/phone/answer";
import { api } from "@/lib/api";
import { textOn } from "@/lib/colors";
import { friendlyError } from "@/lib/errors";
import { sharedSfx } from "@/lib/sfx";
import type { QuizState, RoomState, Round } from "@/lib/types";
import type { PhoneRoundViewProps, PresenterRoundViewProps, TvRoundViewProps } from "../types";
import { CHOICE_STYLE, QUIZ_KIND_LABEL, coverBlur, quizOf } from "./logic";

/** Capa do álbum que fica nítida aos poucos. */
function BlurCover({ q, startedAt, now, className }: { q: QuizState; startedAt: string | null | undefined; now: number; className: string }) {
  if (!q.cover) return null;
  return (
    <div className={`overflow-hidden rounded-3xl shadow-2xl ${className}`}>
      {/* eslint-disable-next-line @next/next/no-img-element -- capa do Deezer */}
      <img
        src={q.cover}
        alt=""
        className="h-full w-full scale-110 object-cover transition-[filter] duration-500"
        style={{ filter: `blur(${coverBlur(startedAt, now)}px)` }}
      />
    </div>
  );
}

/** Título com a palavra escondida em destaque. */
function Masked({ text, className }: { text: string; className: string }) {
  return (
    <p className={className}>
      {text.split(/(___)/).map((p, i) =>
        p === "___" ? <span key={i} className="mx-1 inline-block min-w-[2.5em] border-b-4 border-yellow-300 align-baseline" /> : <span key={i}>{p}</span>,
      )}
    </p>
  );
}

/** Pergunta na TV (quiz aberto e alternativas). */
export function QuizQuestion({ round, now, size = "tv" }: { round: Round; now: number; size?: "tv" | "phone" }) {
  const q = quizOf(round);
  if (!q) return null;
  const tv = size === "tv";
  const started = round.mode === "quiz_choice" ? q.starts_at : round.stage_started_at;
  return (
    <div className={`flex w-full flex-col items-center ${tv ? "max-w-6xl gap-5" : "gap-2"}`}>
      <span className={`rounded-full bg-white/10 px-4 py-1 font-display ${tv ? "text-2xl" : "text-sm"}`}>{QUIZ_KIND_LABEL[q.kind] ?? "❓ Pergunta"}</span>
      <div className={`flex w-full items-center justify-center ${tv ? "gap-8" : "flex-col gap-2"}`}>
        <BlurCover q={q} startedAt={started} now={now} className={tv ? "h-72 w-72 shrink-0" : "h-32 w-32"} />
        <div className="flex flex-col items-center gap-3">
          <p className={`npl-pop text-center font-display font-bold leading-tight ${tv ? "text-6xl" : "text-xl"}`}>{q.q}</p>
          {q.masked && <Masked text={q.masked} className={`text-center font-display text-yellow-100 ${tv ? "text-5xl" : "text-lg"}`} />}
        </div>
      </div>
    </div>
  );
}

/** Alternativas (A, B, C, D) com as cores; na revelação, contagem e a certa. */
function OptionGrid({ q, tv, reveal }: { q: QuizState; tv: boolean; reveal?: boolean }) {
  const opts = q.options ?? [];
  const max = Math.max(1, ...(q.counts ?? [0]));
  return (
    <div className={`grid w-full gap-3 ${tv ? "max-w-6xl grid-cols-2" : "grid-cols-1"}`}>
      {opts.map((text, i) => {
        const st = CHOICE_STYLE[i];
        const right = reveal && q.correct === i;
        const dim = reveal && q.correct !== i;
        const n = q.counts?.[i] ?? 0;
        return (
          <div
            key={i}
            className={`relative flex items-center gap-4 overflow-hidden rounded-2xl px-5 font-display font-semibold text-white transition ${
              tv ? "min-h-24 py-4 text-4xl" : "py-2 text-lg"
            } ${dim ? "opacity-35" : ""} ${right ? "ring-8 ring-emerald-300 scale-[1.02]" : ""}`}
            style={{ background: st.color }}
          >
            {reveal && q.counts && (
              <span className="absolute inset-y-0 left-0 bg-black/25" style={{ width: `${(n / max) * 100}%` }} aria-hidden />
            )}
            <span className="relative">{st.shape}</span>
            <span className="relative flex-1 leading-tight">{text}</span>
            {reveal && q.counts && <span className="relative tabular-nums">{n}</span>}
            {right && <span className="relative">✓</span>}
          </div>
        );
      })}
    </div>
  );
}

/** Quiz de alternativas na TV: pergunta, alternativas, prazo e quem já respondeu. */
export function QuizChoiceTv({ state, round, now }: TvRoundViewProps) {
  const q = quizOf(round);
  const paused = state.room.paused;
  const start = q?.starts_at ? Date.parse(q.starts_at) : 0;
  const end = q?.deadline ? Date.parse(q.deadline) : 0;
  const nowRef = useRef(now);
  useEffect(() => {
    nowRef.current = now;
  }, [now]);

  // tique-taque nos últimos 5 s; no fim do prazo pede ao servidor para fechar
  const lastTick = useRef<number | null>(null);
  const leftSecs = end ? Math.ceil((end - now) / 1000) : 99;
  useEffect(() => {
    if (paused || leftSecs < 1 || leftSecs > 5 || lastTick.current === leftSecs) return;
    lastTick.current = leftSecs;
    sharedSfx().play("tick", { last: leftSecs === 1 });
  }, [leftSecs, paused]);
  useEffect(() => {
    if (!end || paused) return;
    const t = setTimeout(() => api.tick(state.room.code).catch(() => {}), Math.max(0, end + 700 - nowRef.current));
    return () => clearTimeout(t);
  }, [end, paused, state.room.code]);

  if (!q) return null;
  const before = now < start;
  const answered = new Set(q.answered ?? []);
  const left = Math.max(0, end - now);
  return (
    <div className="flex w-full flex-col items-center gap-6">
      <QuizQuestion round={round} now={now} />
      {before ? (
        <p className="npl-pop font-display text-5xl text-yellow-300">Prepare-se… {Math.max(1, Math.ceil((start - now) / 1000))}</p>
      ) : (
        <>
          <OptionGrid q={q} tv />
          {end ? (
            <div className="flex w-full max-w-6xl items-center gap-4">
              <div className="h-4 flex-1 overflow-hidden rounded-full bg-white/15">
                <div className="h-full rounded-full bg-yellow-300 transition-[width] duration-200" style={{ width: `${Math.min(100, (left / Math.max(1, end - start)) * 100)}%` }} />
              </div>
              <span className={`w-20 text-right font-display text-6xl font-bold tabular-nums ${left <= 5000 ? "animate-pulse text-rose-300" : ""}`}>
                {Math.ceil(left / 1000)}
              </span>
            </div>
          ) : (
            <p className="font-display text-2xl text-white/70">Sem limite de tempo: fecha quando todos responderem.</p>
          )}
        </>
      )}
      <div className="flex flex-wrap justify-center gap-2">
        {state.teams.map((t) => (
          <TeamChip key={t.id} team={t} className={`text-2xl ${answered.has(t.id) ? "" : "opacity-40"}`}>
            {t.name} {answered.has(t.id) ? "✓" : "…"}
          </TeamChip>
        ))}
      </div>
      <p className="font-display text-3xl text-white/80">Respondam pelo celular — vale o primeiro toque do time!</p>
    </div>
  );
}

const CHOOSE_REASONS: Record<string, string> = {
  already: "Seu time já respondeu.",
  closed: "O tempo acabou!",
  paused: "Jogo pausado.",
  early: "Calma, ainda não liberou!",
  not_yet: "Você joga a partir da próxima rodada.",
  no_team: "Escolha um time primeiro.",
};

/** Quiz de alternativas no celular: botões grandes A/B/C/D nas cores da TV. */
export function QuizChoicePhone({ ctx, round, now, onFeedback }: PhoneRoundViewProps) {
  const q = quizOf(round);
  const team = ctx.team!;
  const [mine, setMine] = useState<{ roundId: string; choice: number } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!q) return null;
  const start = q.starts_at ? Date.parse(q.starts_at) : 0;
  const end = q.deadline ? Date.parse(q.deadline) : 0;
  const answered = (q.answered ?? []).includes(team.id);
  const myChoice = mine && mine.roundId === round.id ? mine.choice : null;
  const left = Math.max(0, end - now);

  const choose = async (i: number) => {
    if (busy || answered) return;
    setBusy(true);
    vibrate(40);
    try {
      const r = await api.quizChoose(ctx.code, ctx.token, round.id, i);
      if (r.ok) setMine({ roundId: round.id, choice: i });
      else onFeedback(CHOOSE_REASONS[r.reason ?? ""] ?? "Não deu.");
    } catch (e) {
      onFeedback(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  if (now < start) {
    return (
      <>
        <p className="font-display text-5xl">👀</p>
        <p className="font-display text-3xl">Leia a pergunta na TV…</p>
        <p className="font-display text-6xl font-bold text-yellow-300 tabular-nums">{Math.max(1, Math.ceil((start - now) / 1000))}</p>
      </>
    );
  }
  if (answered) {
    const st = myChoice !== null ? CHOICE_STYLE[myChoice] : null;
    return (
      <div className="flex w-full max-w-sm flex-col items-center gap-4">
        {st ? (
          <div className="npl-pop flex w-full flex-col items-center gap-2 rounded-3xl p-6 text-white" style={{ background: st.color }}>
            <p className="font-display text-6xl">{st.shape}</p>
            <p className="font-display text-2xl">Vocês escolheram {st.letter}</p>
            <p className="text-lg opacity-90">{q.options?.[myChoice!]}</p>
          </div>
        ) : (
          <p className="font-display text-3xl">✓ Seu time já respondeu</p>
        )}
        <p className="text-lg text-white/70">Aguardando os outros times…</p>
      </div>
    );
  }
  const opts = q.options ?? [];
  return (
    <div className="flex h-full w-full max-w-md flex-1 flex-col gap-3">
      <div className="flex items-center justify-between rounded-2xl px-4 py-2" style={{ background: team.color, color: textOn(team.color) }}>
        <span className="font-display text-lg">Escolham uma!</span>
        {end > 0 && <span className={`font-display text-4xl font-bold tabular-nums ${left <= 5000 ? "animate-pulse" : ""}`}>{Math.ceil(left / 1000)}</span>}
      </div>
      <div className={`grid flex-1 gap-3 ${opts.length > 2 ? "grid-cols-2" : "grid-cols-1"}`}>
        {opts.map((text, i) => {
          const st = CHOICE_STYLE[i];
          return (
            <button
              key={i}
              disabled={busy}
              onPointerDown={(e) => {
                e.preventDefault();
                choose(i);
              }}
              className="flex min-h-32 flex-col items-center justify-center gap-1 rounded-3xl p-3 font-display text-white shadow-[0_8px_0_rgba(0,0,0,0.35)] transition active:translate-y-2 active:shadow-none disabled:opacity-60"
              style={{ background: st.color }}
            >
              <span className="text-5xl">{st.shape}</span>
              <span className="text-xl font-bold">{st.letter}</span>
              <span className="line-clamp-2 text-sm leading-tight opacity-90">{text}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Celular do apresentador: a pergunta (e no de alternativas, quem já respondeu). */
export function QuizPresenterView({ state, round, now }: PresenterRoundViewProps) {
  const q = quizOf(round);
  if (!q) return null;
  const answered = new Set(q.answered ?? []);
  return (
    <div className="flex flex-col gap-2 rounded-2xl bg-black/20 p-3">
      <QuizQuestion round={round} now={now} size="phone" />
      {round.mode === "quiz_choice" && (
        <>
          <OptionGrid q={q} tv={false} />
          <div className="flex flex-wrap gap-1">
            {state.teams.map((t) => (
              <TeamChip key={t.id} team={t} className={answered.has(t.id) ? "" : "opacity-40"}>
                {t.name} {answered.has(t.id) ? "✓" : "…"}
              </TeamChip>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** Pergunta no celular do jogador (quiz aberto), acima do EU SEI!. */
export function QuizPhoneQuestion({ round, now }: { round: Round; now: number }) {
  if (!quizOf(round)) return null;
  return (
    <div className="w-full rounded-2xl bg-black/25 p-3">
      <QuizQuestion round={round} now={now} size="phone" />
    </div>
  );
}

/** Revelação na TV: a pergunta, a resposta certa e (alternativas) quantos escolheram cada uma. */
export function QuizRevealTv({ state, round }: { state: RoomState; round: Round }) {
  const q = quizOf(round);
  if (!q) return null;
  const choice = round.mode === "quiz_choice";
  const results = state.teams.map((t) => {
    const a = state.attempts.find((x) => x.round_id === round.id && x.team_id === t.id && x.kind === "turn" && ["correct", "wrong", "timeout"].includes(x.status));
    return { t, a };
  });
  return (
    <div className="flex w-full max-w-6xl flex-col items-center gap-5">
      <span className="rounded-full bg-white/10 px-4 py-1 font-display text-2xl">{QUIZ_KIND_LABEL[q.kind] ?? "❓ Pergunta"}</span>
      <p className="text-center font-display text-4xl text-white/85">{q.q}</p>
      {q.masked && <Masked text={q.masked} className="text-center font-display text-3xl text-white/70" />}
      {choice ? (
        <OptionGrid q={q} tv reveal />
      ) : (
        <p className="npl-pop rounded-3xl border-4 border-emerald-300 bg-emerald-500/20 px-10 py-5 text-center font-display text-6xl font-bold">
          {q.answer}
        </p>
      )}
      {choice && (
        <div className="flex flex-wrap justify-center gap-3">
          {results.map(({ t, a }) => (
            <TeamChip key={t.id} team={t} className={`px-5 py-2 text-3xl ${a?.status === "correct" ? "" : "opacity-60"}`}>
              {t.name}{" "}
              {a ? (a.status === "correct" ? <b>+{a.points}</b> : "✗") : <span className="text-xl">não respondeu</span>}
            </TeamChip>
          ))}
        </div>
      )}
    </div>
  );
}

/** Resposta certa (celulares, na revelação). */
export function QuizAnswerLine({ round }: { round: Round }) {
  const q = quizOf(round);
  if (!q?.answer) return null;
  return (
    <div className="w-full rounded-2xl bg-black/25 p-3 text-left">
      <p className="text-sm text-white/70">{q.q}</p>
      <p className="font-display text-2xl font-bold text-emerald-300">✓ {q.answer}</p>
    </div>
  );
}

