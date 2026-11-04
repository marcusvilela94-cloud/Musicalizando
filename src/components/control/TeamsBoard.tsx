"use client";
import { useState } from "react";
import { Button } from "@/components/ui";
import { api, deezer } from "@/lib/api";
import { textOn } from "@/lib/colors";
import { friendlyError } from "@/lib/errors";
import type { Player, RoomState, Team } from "@/lib/types";

/** Sorteia as músicas (rota do Next -> Deezer) e começa a partida. */
export async function startMatch(state: RoomState, code: string, token: string): Promise<string[]> {
  const { sources, rounds } = state.room.settings;
  const { tracks, warnings } = await deezer.build(sources, rounds);
  await api.startMatch(code, token, tracks);
  return warnings;
}

export function settingsSummary(state: RoomState) {
  const s = state.room.settings;
  return [
    `${s.rounds} músicas`,
    s.answerSeconds ? `${s.answerSeconds}s para responder` : "sem limite de tempo",
    s.scoring === "title" ? "só a música" : "artista e música",
    s.roomStyle === "host" ? (s.answerMode === "spoken" ? "resposta falada" : "resposta digitada") : "resposta digitada",
    `bloqueio de ${s.lockSeconds}s após erro`,
    s.penalty ? `erro −${s.penalty}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

export type Control = { code: string; token: string; onConfig: () => void };

/**
 * Times e jogadores. Com `control` (TV no "Todos jogam" ou celular do
 * apresentador) dá para mexer: sortear, mover, remover e começar.
 */
export function TeamsBoard({ state, online, control, compact }: { state: RoomState; online: Set<string>; control?: Control; compact?: boolean }) {
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
    if (!control) return;
    setBusy(true);
    setError(null);
    try {
      const warnings = await startMatch(state, control.code, control.token);
      if (warnings.length) setError(warnings.join(" "));
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };
  const move = (playerId: string, teamId: string | null) =>
    control && run(() => api.movePlayer(control.code, control.token, playerId, teamId)).then(() => setSelected(null));
  const select = (id: string) => control && setSelected(selected === id ? null : id);

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className={`font-display font-semibold mr-auto ${compact ? "text-2xl" : "text-4xl"}`}>
          {solo ? "Cada um por si" : "Times"} <span className="text-white/50 text-xl">· {state.players.length} jogadores</span>
        </h1>
        {control && !solo && (
          <>
            <Button variant="secondary" onClick={() => run(() => api.updateSettings(control.code, control.token, { teamCount: Math.max(2, s.teamCount - 1) }))}>− time</Button>
            <Button variant="secondary" onClick={() => run(() => api.updateSettings(control.code, control.token, { teamCount: Math.min(12, s.teamCount + 1) }))}>+ time</Button>
            <Button variant="secondary" onClick={() => run(() => api.shuffleTeams(control.code, control.token))}>🎲 Sortear</Button>
          </>
        )}
        {control && (
          <>
            <Button variant="secondary" onClick={() => run(() => api.updateSettings(control.code, control.token, { teamMode: solo ? "teams" : "solo" }))}>
              {solo ? "Jogar em times" : "Cada um por si"}
            </Button>
            <Button variant="ghost" onClick={control.onConfig}>⚙️ Configurações</Button>
          </>
        )}
      </div>

      <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${compact ? 150 : solo ? 200 : 240}px, 1fr))` }}>
        {state.teams.map((t) => (
          <TeamColumn
            key={t.id}
            team={t}
            players={state.players.filter((p) => p.team_id === t.id)}
            online={online}
            selected={selected}
            onSelect={select}
            control={control}
            onError={setError}
          />
        ))}
        {unassigned.length > 0 && (
          <div className="rounded-3xl border-2 border-dashed border-white/30 p-4">
            <h3 className="font-display text-xl text-white/70 mb-2">Sem time</h3>
            <ul className="flex flex-col gap-2">
              {unassigned.map((p) => (
                <PlayerItem key={p.id} p={p} online={online.has(p.id)} selected={selected === p.id} onClick={() => select(p.id)} />
              ))}
            </ul>
          </div>
        )}
      </div>

      {control && selected && (
        <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-black/30 p-3">
          <span className="text-white/80">
            Mover <b>{state.players.find((p) => p.id === selected)?.nickname}</b> para:
          </span>
          {state.teams.map((t) => (
            <button key={t.id} className="rounded-full px-3 py-1 font-display" style={{ background: t.color, color: textOn(t.color) }} onClick={() => move(selected, t.id)}>
              {t.name}
            </button>
          ))}
          <Button variant="danger" className="ml-auto py-1 text-sm" onClick={() => run(() => api.removePlayer(control.code, control.token, selected)).then(() => setSelected(null))}>
            Remover da sala
          </Button>
          <Button variant="ghost" className="py-1 text-sm" onClick={() => setSelected(null)}>Cancelar</Button>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-end gap-3">
        <p className="text-white/60 mr-auto">{settingsSummary(state)}</p>
        {error && <p className="w-full text-right text-rose-300 text-lg">{error}</p>}
        {control ? (
          <Button className={compact ? "w-full text-2xl py-4" : "text-3xl px-12 py-5"} disabled={!canStart || busy} onClick={start}>
            {busy ? "Sorteando músicas…" : "Começar! ▶"}
          </Button>
        ) : (
          <p className="font-display text-2xl text-yellow-300">Aguardando o apresentador começar…</p>
        )}
      </div>
    </section>
  );
}

function TeamColumn({
  team,
  players,
  online,
  selected,
  onSelect,
  control,
  onError,
}: {
  team: Team;
  players: Player[];
  online: Set<string>;
  selected: string | null;
  onSelect: (id: string) => void;
  control?: Control;
  onError: (m: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(team.name);
  return (
    <div className="rounded-3xl p-3 flex flex-col gap-2 border-4" style={{ borderColor: team.color, background: `${team.color}22` }}>
      {editing && control ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            api.renameTeam(control.code, control.token, team.id, name).catch((err) => onError(friendlyError(err)));
            setEditing(false);
          }}
        >
          <input autoFocus value={name} maxLength={24} onChange={(e) => setName(e.target.value)} onBlur={() => setEditing(false)} className="w-full rounded-xl px-3 py-2 text-violet-950 font-display text-xl" />
        </form>
      ) : (
        <button
          className="rounded-2xl px-4 py-2 font-display text-2xl font-semibold text-left"
          style={{ background: team.color, color: textOn(team.color) }}
          disabled={!control}
          onClick={() => {
            setName(team.name);
            setEditing(true);
          }}
          title={control ? "Clique para renomear" : undefined}
        >
          {team.name}
        </button>
      )}
      <ul className="flex flex-col gap-2 min-h-12">
        {players.map((p) => (
          <PlayerItem key={p.id} p={p} online={online.has(p.id)} selected={selected === p.id} onClick={() => onSelect(p.id)} />
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
        onClick={onClick}
        className={`flex w-full items-center gap-2 rounded-xl px-3 py-2 text-xl text-left transition ${selected ? "bg-yellow-300 text-violet-950" : "bg-white/10 hover:bg-white/20"}`}
      >
        <span className={`h-2.5 w-2.5 rounded-full ${online ? "bg-emerald-400" : "bg-white/30"}`} />
        {p.nickname}
      </button>
    </li>
  );
}
