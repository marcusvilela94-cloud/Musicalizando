"use client";
// Peças visuais do Leilão usadas na TV, no celular e no apresentador.
import { TeamChip } from "@/components/ui";
import { textOn } from "@/lib/colors";
import { artistCredits, teamById } from "@/lib/game";
import type { AuctionState, RoomState } from "@/lib/types";
import { auctionGoal } from "./logic";
import { teamLabel } from "@/lib/icons";

const SIZES = {
  tv: { box: "gap-3 rounded-[2rem] px-10 py-6", tag: "text-2xl", main: "text-6xl", goal: "text-3xl" },
  phone: { box: "gap-1 rounded-2xl px-4 py-3", tag: "text-sm", main: "text-2xl", goal: "text-xl" },
} as const;

/** A dica da rodada + o que vale ("Acerte a MÚSICA" / "Acerte o ARTISTA"). */
export function HintCard({ a, size = "tv" }: { a: AuctionState; size?: keyof typeof SIZES }) {
  const z = SIZES[size];
  const artist = a.hint === "artist";
  return (
    <div className={`npl-pop flex w-full max-w-5xl flex-col items-center border-2 border-yellow-300/70 bg-black/30 text-center ${z.box}`}>
      <p className={`font-display uppercase tracking-widest text-yellow-300 ${z.tag}`}>
        🔨 Leilão · dica: {artist ? "artista" : "gênero e ano"}
      </p>
      <p className={`font-display font-bold leading-tight ${z.main}`}>
        {artist ? artistCredits({ artist: a.artist ?? "", artists: a.artists }) : `${a.genre} · ${a.year}`}
      </p>
      <p className={`font-display ${z.goal}`}>
        Acerte <b className="rounded-lg bg-yellow-300 px-2 text-violet-950">{auctionGoal(a)}</b>
      </p>
    </div>
  );
}

/** Lance de cada time (ordem do rodízio): menor lance, quem é a vez, quem disse "Pode tocar!". */
export function BidBoard({ state, a, size = "tv" }: { state: RoomState; a: AuctionState; size?: "tv" | "phone" }) {
  const tv = size === "tv";
  return (
    <div className={`grid w-full gap-3 ${tv ? "max-w-5xl" : ""}`} style={{ gridTemplateColumns: `repeat(${Math.min(a.order.length, tv ? 6 : 3)}, minmax(0, 1fr))` }}>
      {a.order.map((id) => {
        const t = teamById(state, id);
        if (!t) return null;
        const bid = a.bids[id];
        const turn = a.phase === "bidding" && a.turn === id;
        const low = a.low_team === id;
        const passed = a.passes.includes(id);
        return (
          <div
            key={id}
            className={`flex flex-col items-center rounded-2xl transition ${tv ? "gap-1 px-3 py-4" : "px-2 py-2"} ${
              turn ? "scale-105 ring-4 ring-yellow-300 shadow-xl" : ""
            } ${passed && !low ? "opacity-60" : ""}`}
            style={{ background: t.color, color: textOn(t.color) }}
          >
            <span className={`font-display font-semibold truncate max-w-full ${tv ? "text-2xl" : "text-sm"}`}>{teamLabel(t)}</span>
            <span className={`font-display font-bold tabular-nums ${tv ? "text-6xl" : "text-3xl"}`}>{bid !== undefined ? `${bid}s` : "—"}</span>
            <span className={`font-display ${tv ? "text-xl" : "text-xs"}`}>
              {low ? "👑 menor lance" : turn ? "⏳ na vez" : passed ? "pode tocar!" : " "}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Fila de prova: quem já tentou, quem está na vez e quem vem depois. */
export function QueueRow({ state, a, size = "tv" }: { state: RoomState; a: AuctionState; size?: "tv" | "phone" }) {
  const tv = size === "tv";
  return (
    <div className="flex flex-wrap items-center justify-center gap-2">
      {a.queue.map((e, i) => {
        const t = teamById(state, e.team);
        if (!t) return null;
        const done = i < a.qidx;
        const now = i === a.qidx;
        return (
          <TeamChip
            key={e.team}
            team={t}
            className={`${tv ? "text-2xl px-4 py-1" : "text-sm"} ${done ? "opacity-40 line-through" : now ? "ring-4 ring-yellow-300" : "opacity-80"}`}
          >
            {i + 1}º {t.name} · {e.secs}s{done ? " ✗" : ""}
          </TeamChip>
        );
      })}
    </div>
  );
}
