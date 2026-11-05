"use client";
import type { Round } from "@/lib/types";
import type { PresenterRoundViewProps } from "../types";
import { LYRICS_STAGES } from "./stages";

/** Estado da letra na rodada (null fora do modo letra ou antes de abrir). */
export function lyricsOf(r: Round | null | undefined) {
  const l = r?.mode === "lyrics" ? r.lyrics : null;
  return l && typeof l.total === "number" && Array.isArray(l.shown) ? { total: l.total, shown: l.shown, plain: l.plain } : null;
}

/** Quantos versos a rodada tem (para o "Próximo verso" / "Revelar"). */
export const lyricsTotal = (r: Round | null | undefined) => lyricsOf(r)?.total ?? LYRICS_STAGES.length;

/** "___" em destaque. */
function Line({ text }: { text: string }) {
  const parts = text.split(/(___)/);
  return (
    <>
      {parts.map((p, i) =>
        p === "___" ? (
          <span key={i} className="mx-1 inline-block min-w-[2.5em] border-b-4 border-yellow-300/80 align-baseline" />
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

/**
 * Versos revelados empilhados: o mais novo grande e em destaque, os
 * anteriores menores acima. `size="tv"` = legível de longe.
 */
export function LyricsStack({ round, size = "tv" }: { round: Round; size?: "tv" | "phone" }) {
  const l = lyricsOf(round);
  if (!l || !l.shown.length) return null;
  const tv = size === "tv";
  const last = l.shown.length - 1;
  return (
    <div className={`flex w-full flex-col items-center ${tv ? "max-w-6xl gap-4" : "gap-2"}`}>
      {l.shown.map((seg, i) => {
        const latest = i === last;
        return (
          <div
            key={i}
            className={`w-full text-center font-display leading-snug transition ${
              latest
                ? `npl-pop rounded-[2rem] border-2 border-yellow-300/70 bg-black/30 ${tv ? "px-10 py-6 text-6xl" : "px-3 py-2 text-xl"}`
                : `${tv ? "text-3xl" : "text-sm"} text-white/55`
            }`}
          >
            <span className={`block font-sans uppercase tracking-widest ${tv ? (latest ? "mb-2 text-xl text-yellow-300" : "text-base") : "text-xs"}`}>
              {i + 1}º verso{i === l.total - 1 ? " · refrão" : ""}
            </span>
            {seg.map((line, j) => (
              <p key={j}>
                <Line text={line} />
              </p>
            ))}
          </div>
        );
      })}
    </div>
  );
}

/** Revelação: o verso em que acertaram, sem "___". */
export function LyricsReveal({ round, stage, size = "tv" }: { round: Round; stage: number | null; size?: "tv" | "phone" }) {
  const l = lyricsOf(round);
  if (!l?.plain?.length) return null;
  const idx = Math.max(0, Math.min(l.plain.length - 1, (stage ?? l.shown.length) - 1));
  const tv = size === "tv";
  return (
    <div className={`rounded-2xl bg-black/30 text-left ${tv ? "px-6 py-4 text-2xl" : "px-3 py-2 text-sm"}`}>
      <p className={`font-sans uppercase tracking-widest text-yellow-300 ${tv ? "text-base" : "text-xs"}`}>
        {stage ? `Acertaram no ${stage}º verso` : `${idx + 1}º verso`}
      </p>
      {l.plain[idx].map((line, j) => (
        <p key={j} className="font-display">“{line}”</p>
      ))}
    </div>
  );
}

/** Celular do apresentador: os versos já revelados, compactos. */
export function LyricsPresenterView({ round }: PresenterRoundViewProps) {
  const l = lyricsOf(round);
  if (!l) return null;
  return (
    <div className="flex flex-col gap-1">
      <p className="text-center text-sm text-white/70">
        Verso {l.shown.length} de {l.total}
      </p>
      <LyricsStack round={round} size="phone" />
    </div>
  );
}
