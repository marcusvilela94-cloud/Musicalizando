"use client";
import { useState } from "react";
import { Button, Logo } from "@/components/ui";
import { api } from "@/lib/api";
import { textOn } from "@/lib/colors";
import { friendlyError } from "@/lib/errors";
import type { Player, RoomState, Team } from "@/lib/types";
import { JoinPanel, OwnerPhoneLink } from "./JoinPanel";
import { startMatch } from "./startMatch";
import type { TvCtx } from "./TvApp";

export function LobbyScreen({ state, ctx }: { state: RoomState; ctx: TvCtx }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const s = state.room.settings;
  const solo = s.teamMode === "solo";
  const unassigned = state.players.filter((p) => !p.team_id || !state.teams.some((t) => t.id === p.team_id));
  const filledTeams = state.teams.filter((t) => state.players.some((p) => p.team_id === t.id)).length;
  const canStart = state.players.length >= 2 && (filledTeams >= 2 || (unassigned.length > 0 && filledTeams + unassigned.length >= 2));

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(friendlyError(e));
    }
  };

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const warnings = await startMatch(state, ctx);
      if (warnings.length) setError(warnings.join(" "));
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  const move = (player: Player, teamId: string | null) =>
    run(() => api.movePlayer(ctx.code, ctx.owner, player.id, teamId)).then(() => setSelected(null));

  return (
    <main className="grid flex-1 grid-cols-1 gap-6 p-6 lg:grid-cols-[340px_1fr] lg:p-10">
      <aside className="flex flex-col items-center gap-4">
        <Logo className="text-4xl" />
        <JoinPanel code={ctx.code} />
        <OwnerPhoneLink code={ctx.code} owner={ctx.owner} />
      </aside>

      <section className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-display text-4xl font-semibold mr-auto">
            {solo ? "Cada um por si" : "Times"} <span className="text-white/50 text-2xl">· {state.players.length} jogadores</span>
          </h1>
          {!solo && (
            <>
              <Button variant="secondary" onClick={() => run(() => api.updateSettings(ctx.code, ctx.owner, { teamCount: Math.max(2, s.teamCount - 1) }))}>− time</Button>
              <Button variant="secondary" onClick={() => run(() => api.updateSettings(ctx.code, ctx.owner, { teamCount: Math.min(12, s.teamCount + 1) }))}>+ time</Button>
              <Button variant="secondary" onClick={() => run(() => api.shuffleTeams(ctx.code, ctx.owner))}>🎲 Sortear</Button>
            </>
          )}
          <Button
            variant="secondary"
            onClick={() => run(() => api.updateSettings(ctx.code, ctx.owner, { teamMode: solo ? "teams" : "solo" }))}
          >
            {solo ? "Jogar em times" : "Cada um por si"}
          </Button>
          <Button variant="ghost" onClick={() => run(() => api.setPhase(ctx.code, ctx.owner, "config"))}>⚙️ Configurações</Button>
        </div>

        <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${solo ? 200 : 240}px, 1fr))` }}>
          {state.teams.map((t) => (
            <TeamColumn
              key={t.id}
              team={t}
              players={state.players.filter((p) => p.team_id === t.id)}
              ctx={ctx}
              online={ctx.online}
              selected={selected}
              onSelect={setSelected}
              onDrop={(p) => move(p, t.id)}
              onError={setError}
            />
          ))}
          {unassigned.length > 0 && (
            <div className="rounded-3xl border-2 border-dashed border-white/30 p-4">
              <h3 className="font-display text-xl text-white/70 mb-2">Sem time</h3>
              <ul className="flex flex-col gap-2">
                {unassigned.map((p) => (
                  <PlayerItem key={p.id} p={p} online={ctx.online.has(p.id)} selected={selected === p.id} onClick={() => setSelected(selected === p.id ? null : p.id)} />
                ))}
              </ul>
            </div>
          )}
        </div>

        {selected && (
          <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-black/30 p-3">
            <span className="text-white/80">
              Mover <b>{state.players.find((p) => p.id === selected)?.nickname}</b> para:
            </span>
            {state.teams.map((t) => (
              <button
                key={t.id}
                className="rounded-full px-3 py-1 font-display"
                style={{ background: t.color, color: textOn(t.color) }}
                onClick={() => move(state.players.find((p) => p.id === selected)!, t.id)}
              >
                {t.name}
              </button>
            ))}
            <Button
              variant="danger"
              className="ml-auto py-1 text-sm"
              onClick={() => run(() => api.removePlayer(ctx.code, ctx.owner, selected)).then(() => setSelected(null))}
            >
              Remover da sala
            </Button>
            <Button variant="ghost" className="py-1 text-sm" onClick={() => setSelected(null)}>Cancelar</Button>
          </div>
        )}

        <div className="mt-auto flex flex-wrap items-center justify-end gap-4">
          <p className="text-white/60 mr-auto">
            {s.rounds} músicas · {s.answerSeconds ? `${s.answerSeconds}s para responder` : "sem limite de tempo"} ·{" "}
            {s.scoring === "title" ? "só o título" : "artista + bônus pelo título"}
            {s.penalty ? ` · erro −${s.penalty}` : ""}
          </p>
          {error && <p className="w-full text-right text-rose-300 text-lg">{error}</p>}
          <Button className="text-3xl px-12 py-5" disabled={!canStart || busy} onClick={start}>
            {busy ? "Sorteando músicas…" : "Começar! ▶"}
          </Button>
        </div>
      </section>
    </main>
  );
}

function TeamColumn({
  team,
  players,
  ctx,
  online,
  selected,
  onSelect,
  onDrop,
  onError,
}: {
  team: Team;
  players: Player[];
  ctx: TvCtx;
  online: Set<string>;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onDrop: (p: Player) => void;
  onError: (m: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(team.name);
  const fg = textOn(team.color);
  return (
    <div
      className="rounded-3xl p-4 flex flex-col gap-3 border-4"
      style={{ borderColor: team.color, background: `${team.color}22` }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        const id = e.dataTransfer.getData("text/player");
        if (id) onDrop({ id } as Player);
      }}
    >
      {editing ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            api.renameTeam(ctx.code, ctx.owner, team.id, name).catch((err) => onError(friendlyError(err)));
            setEditing(false);
          }}
        >
          <input autoFocus value={name} maxLength={24} onChange={(e) => setName(e.target.value)} onBlur={() => setEditing(false)} className="w-full rounded-xl px-3 py-2 text-violet-950 font-display text-xl" />
        </form>
      ) : (
        <button
          className="rounded-2xl px-4 py-2 font-display text-2xl font-semibold text-left"
          style={{ background: team.color, color: fg }}
          onClick={() => {
            setName(team.name);
            setEditing(true);
          }}
          title="Clique para renomear"
        >
          {team.name}
        </button>
      )}
      <ul className="flex flex-col gap-2 min-h-12">
        {players.map((p) => (
          <PlayerItem key={p.id} p={p} online={online.has(p.id)} selected={selected === p.id} onClick={() => onSelect(selected === p.id ? null : p.id)} />
        ))}
        {players.length === 0 && <li className="text-white/50 italic">vazio</li>}
      </ul>
    </div>
  );
}

function PlayerItem({ p, online, selected, onClick }: { p: Player; online: boolean; selected: boolean; onClick: () => void }) {
  return (
    <li>
      <button
        draggable
        onDragStart={(e) => e.dataTransfer.setData("text/player", p.id)}
        onClick={onClick}
        className={`flex w-full items-center gap-2 rounded-xl px-3 py-2 text-xl text-left transition ${selected ? "bg-yellow-300 text-violet-950" : "bg-white/10 hover:bg-white/20"}`}
      >
        <span className={`h-2.5 w-2.5 rounded-full ${online ? "bg-emerald-400" : "bg-white/30"}`} />
        {p.nickname}
      </button>
    </li>
  );
}
