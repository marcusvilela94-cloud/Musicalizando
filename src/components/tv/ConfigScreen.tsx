"use client";
import { useState } from "react";
import { SettingsForm } from "@/components/control/SettingsForm";
import { settingsSummary } from "@/components/control/TeamsBoard";
import { Card, Logo } from "@/components/ui";
import { api } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { isHostStyle } from "@/lib/game";
import type { RoomState } from "@/lib/types";
import { JoinPanel } from "./JoinPanel";
import type { TvCtx } from "./TvApp";

export function ConfigScreen({ state, ctx }: { state: RoomState; ctx: TvCtx }) {
  const [error, setError] = useState<string | null>(null);
  const host = isHostStyle(state);
  return (
    <main className="grid flex-1 grid-cols-1 gap-6 p-6 lg:grid-cols-[1fr_320px] lg:p-10">
      <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <Logo className="text-4xl" />
          <h1 className="font-display text-3xl text-white/80">Configuração da partida</h1>
        </div>
        {host ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
            <p className="font-display text-5xl">🎛️ O apresentador está configurando a partida pelo celular…</p>
            <p className="text-2xl text-white/70">{settingsSummary(state)}</p>
          </div>
        ) : (
          <SettingsForm
            state={state}
            code={ctx.code}
            token={ctx.host}
            onDone={() => api.setPhase(ctx.code, ctx.host, "lobby").catch((e) => setError(friendlyError(e)))}
          />
        )}
        {error && <p className="text-rose-300 text-lg">{error}</p>}
      </div>
      <aside className="flex flex-col items-center gap-6">
        <JoinPanel code={ctx.code} size="sm" />
        <Card className="w-full">
          <p className="font-display text-lg mb-2">Já entraram ({state.players.length})</p>
          <ul className="flex flex-wrap gap-2">
            {state.players.map((p) => (
              <li key={p.id} className="rounded-full bg-white/15 px-3 py-1">{p.nickname}</li>
            ))}
          </ul>
        </Card>
      </aside>
    </main>
  );
}
