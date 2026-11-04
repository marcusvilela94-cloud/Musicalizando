"use client";
import { TeamsBoard } from "@/components/control/TeamsBoard";
import { Logo } from "@/components/ui";
import { api } from "@/lib/api";
import { isHostStyle } from "@/lib/game";
import type { RoomState } from "@/lib/types";
import { JoinPanel } from "./JoinPanel";
import type { TvCtx } from "./TvApp";

/** Times. No "Todos jogam" dá para mexer pela TV; com apresentador, só mostra. */
export function LobbyScreen({ state, ctx }: { state: RoomState; ctx: TvCtx }) {
  const control = isHostStyle(state)
    ? undefined
    : { code: ctx.code, token: ctx.host, onConfig: () => api.setPhase(ctx.code, ctx.host, "config").catch(() => {}) };
  return (
    <main className="grid flex-1 grid-cols-1 gap-6 p-6 lg:grid-cols-[340px_1fr] lg:p-10">
      <aside className="flex flex-col items-center gap-4">
        <Logo className="text-4xl" />
        <JoinPanel code={ctx.code} />
      </aside>
      <TeamsBoard state={state} online={ctx.online} control={control} />
    </main>
  );
}
