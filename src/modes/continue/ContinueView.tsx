"use client";
import type { Round } from "@/lib/types";
import type { PresenterRoundViewProps } from "../types";
import { contClip, contOf } from "./logic";

/** Lacunas do tamanho da linha escondida: "___ ___ ___". */
function Blanks({ n, size }: { n: number; size: string }) {
  return (
    <span className={`flex flex-wrap justify-center gap-3 ${size}`}>
      {Array.from({ length: n }, (_, i) => (
        <span key={i} className="inline-block min-w-[2.2em] border-b-4 border-yellow-300" />
      ))}
    </span>
  );
}

/**
 * TV durante a rodada: título e artista desde o início; as linhas de
 * contexto acendem quando começam (karaokê); quando para, a linha escondida
 * aparece como lacunas, uma por palavra.
 */
export function ContinueStack({
  round,
  title,
  artist,
  now,
  playing,
  size = "tv",
}: {
  round: Round;
  title?: string | null;
  artist?: string | null;
  now: number;
  playing: boolean;
  size?: "tv" | "phone";
}) {
  const c = contOf(round);
  if (!c) return null;
  const tv = size === "tv";
  // posição na prévia enquanto toca (relógio do servidor desde o "Tocar")
  const { from, to } = contClip(c);
  const pos = playing && round.play_at ? Math.min(to, from + (now - Date.parse(round.play_at)) / 1000) : null;
  const stopped = !playing && round.played_stage > 0;
  return (
    <div className={`flex w-full flex-col items-center ${tv ? "max-w-6xl gap-4" : "gap-2"}`}>
      {(title || artist) && (
        <p className={`text-center font-display ${tv ? "text-4xl" : "text-lg"}`}>
          🎵 <b>{title}</b> <span className="text-pink-300">— {artist}</span>
        </p>
      )}
      <div className={`flex w-full flex-col items-center ${tv ? "gap-2" : "gap-1"}`}>
        {c.lines.map((l, i) => {
          const lit = pos !== null ? pos >= Number(l.start) - 0.05 : stopped;
          const singing = pos !== null && lit && (i === c.lines.length - 1 || pos < Number(c.lines[i + 1].start));
          return (
            <p
              key={`${i}-${l.text}`}
              className={`text-center font-display leading-snug transition-all duration-200 ${tv ? "text-5xl" : "text-lg"} ${
                singing ? "scale-105 text-yellow-300" : lit ? "text-white" : "text-white/30"
              }`}
            >
              {l.text}
            </p>
          );
        })}
      </div>
      <div
        className={`npl-pop flex w-full flex-col items-center rounded-[2rem] border-2 ${stopped ? "border-yellow-300 bg-black/30" : "border-white/15 bg-black/10"} ${
          tv ? "px-8 py-6" : "px-3 py-3"
        }`}
      >
        <p className={`font-sans uppercase tracking-widest text-yellow-300 ${tv ? "mb-3 text-lg" : "mb-1 text-xs"}`}>
          {stopped ? "E agora? Continue a letra!" : playing ? "ouça…" : "Prontos?"} · {c.hidden.words} palavras
        </p>
        <Blanks n={c.hidden.words} size={tv ? "text-6xl h-16" : "text-2xl h-8"} />
      </div>
    </div>
  );
}

/**
 * Revelação: a linha escondida em karaokê (palavra por palavra) enquanto a
 * música continua de onde parou. `elapsed` = segundos desde que a linha voltou a tocar.
 */
export function ContinueRevealLine({ round, elapsed, size = "tv" }: { round: Round; elapsed: number | null; size?: "tv" | "phone" }) {
  const c = contOf(round);
  const line = c?.reveal;
  if (!line) return null;
  const words = line.text.split(/\s+/).filter(Boolean);
  const dur = Math.max(0.5, Number(line.end) - Number(line.start));
  // a música volta 0,3 s antes da linha: desconta isso
  const t = elapsed === null ? dur : elapsed - 0.3;
  const lit = Math.max(0, Math.min(words.length, Math.floor((t / dur) * words.length) + (t > 0 ? 1 : 0)));
  const tv = size === "tv";
  return (
    <p className={`rounded-[2rem] border-4 border-yellow-300 bg-black/30 text-center font-display font-bold leading-snug ${tv ? "px-8 py-5 text-6xl" : "px-3 py-2 text-xl"}`}>
      {words.map((w, i) => (
        <span key={i} className={`transition-colors ${i < lit ? "text-yellow-300" : "text-white/40"}`}>
          {w}{" "}
        </span>
      ))}
    </p>
  );
}

/** Celular do apresentador: contexto atual (a linha certa aparece no cartão de resposta). */
export function ContinuePresenterView({ round }: PresenterRoundViewProps) {
  const c = contOf(round);
  if (!c) return null;
  return (
    <div className="flex flex-col gap-1 rounded-xl bg-black/20 p-2 text-center">
      <p className="text-xs text-white/60">{c.ctx} linhas de contexto · linha escondida com {c.hidden.words} palavras</p>
      {c.lines.map((l, i) => (
        <p key={i} className="text-sm text-white/80">{l.text}</p>
      ))}
    </div>
  );
}

/**
 * "Cantar junto" (revelação): a linha escondida em destaque e as seguintes,
 * acendendo em karaokê até o fim da prévia. `pos` = segundo da prévia tocando
 * agora (null = ainda não voltou a tocar). `corner` = quem acertou + pontos.
 */
export function SingAlong({ round, pos, corner }: { round: Round; pos: number | null; corner?: React.ReactNode }) {
  const c = contOf(round);
  if (!c?.reveal) return null;
  const all = [{ ...c.reveal, hidden: true }, ...(c.after ?? []).map((l) => ({ ...l, hidden: false }))];
  // linha atual = a última que já começou
  const cur = pos === null ? -1 : all.reduce((acc, l, i) => (pos >= Number(l.start) - 0.05 ? i : acc), -1);
  // mostra a atual e algumas em volta (as próximas um pouco apagadas)
  const fromIdx = Math.max(0, cur - 1);
  const shown = all.slice(fromIdx, fromIdx + 4);
  return (
    <div className="relative flex w-full max-w-6xl flex-col items-center gap-5">
      {corner && <div className="absolute -top-2 right-0">{corner}</div>}
      <p className="font-display text-3xl text-white/70">🎤 Todo mundo canta junto!</p>
      {shown.map((l, k) => {
        const i = fromIdx + k;
        const now = i === cur;
        const past = i < cur;
        return (
          <p
            key={`${i}-${l.text}`}
            className={`text-center font-display font-bold leading-snug transition-all duration-300 ${
              now ? "scale-105 text-7xl text-yellow-300" : past ? "text-4xl text-white/40" : "text-5xl text-white/60"
            } ${l.hidden ? "rounded-[2rem] border-4 border-yellow-300 bg-black/30 px-8 py-3" : ""}`}
          >
            {l.text}
          </p>
        );
      })}
    </div>
  );
}
