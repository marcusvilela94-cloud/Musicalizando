"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Button, Logo, Spinner, TeamChip } from "@/components/ui";
import { useRoom } from "@/hooks/useRoom";
import { useWakeLock } from "@/hooks/useWakeLock";
import { api } from "@/lib/api";
import { textOn } from "@/lib/colors";
import { friendlyError } from "@/lib/errors";
import { currentRound, ranking, roundDelta, teamById } from "@/lib/game";
import { getOwnerToken, getPlayerToken, getSavedNickname, saveNickname, saveOwnerToken } from "@/lib/tokens";
import type { Player, RoomState, Team } from "@/lib/types";
import { OwnerBar } from "./OwnerBar";
import { RoundPhone } from "./RoundPhone";

export type PhoneCtx = { code: string; token: string; me: Player; team?: Team; owner: string | null; serverNow: () => number };

export function PhoneApp() {
  const { code } = useParams<{ code: string }>();
  const [token, setToken] = useState<string | null>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const [meId, setMeId] = useState<string | null>(null);
  const [needsName, setNeedsName] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);

  // token do aparelho + (opcional) chave de dono vinda do QR "#dono=..."
  useEffect(() => {
    const t = getPlayerToken();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage só existe no navegador
    setToken(t);
    const m = window.location.hash.match(/dono=([a-f0-9]+)/);
    if (m) {
      history.replaceState(null, "", window.location.pathname);
      api.isOwner(code, m[1]).then((ok) => {
        if (ok) {
          saveOwnerToken(code, m[1]);
          setOwner(m[1]);
        }
      });
    } else {
      setOwner(getOwnerToken(code));
    }
    // reconexão: se este aparelho já está na sala, volta para o mesmo time e pontos
    api
      .join(code, t, "")
      .then((p) => setMeId(p.id))
      .catch((e) => {
        if (/nickname_required/.test(String(e))) setNeedsName(true);
        else setJoinError(friendlyError(e));
      });
  }, [code]);

  const { state, notFound, connected, serverNow } = useRoom(code, meId ? { kind: "player", playerId: meId } : undefined);
  useWakeLock(state?.room.phase === "playing");

  if (notFound || joinError === friendlyError("npl:room_not_found")) {
    return (
      <Screen>
        <p className="font-display text-3xl">Sala {code} não encontrada 😕</p>
        <Link href="/j" className="text-yellow-300 underline text-xl">Tentar outro código</Link>
      </Screen>
    );
  }
  if (!token) return <Screen><Spinner /></Screen>;
  if (needsName && !meId) {
    return <NameForm code={code} token={token} onJoined={(id) => { setMeId(id); setNeedsName(false); }} />;
  }
  if (joinError) return <Screen><p className="text-rose-300 text-xl">{joinError}</p></Screen>;
  if (!state || !meId) return <Screen><Spinner label="Conectando…" /></Screen>;

  const me = state.players.find((p) => p.id === meId);
  if (!me) {
    // o dono removeu este jogador
    return <NameForm code={code} token={token} onJoined={setMeId} removed />;
  }
  const team = teamById(state, me.team_id);
  const ctx: PhoneCtx = { code, token, me, team, owner, serverNow };

  return (
    <div className="flex h-dvh flex-col overflow-hidden no-select">
      <header className="flex items-center gap-2 px-4 py-2 bg-black/20">
        <span className="font-display text-lg text-white/70">Sala {code}</span>
        <span className="font-display text-lg font-semibold truncate">· {me.nickname}</span>
        <span className="ml-auto">{team && <TeamChip team={team} className="text-sm" />}</span>
        {!connected && <span className="h-2 w-2 rounded-full bg-amber-400" title="reconectando" />}
      </header>
      <main className="relative flex flex-1 flex-col items-center justify-center gap-5 p-5 text-center">
        <PhoneBody state={state} ctx={ctx} />
        {state.room.paused && state.room.phase === "playing" && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/70">
            <p className="font-display text-5xl font-bold text-yellow-300">PAUSADO</p>
          </div>
        )}
      </main>
      {owner && <OwnerBar state={state} code={code} owner={owner} />}
    </div>
  );
}

function PhoneBody({ state, ctx }: { state: RoomState; ctx: PhoneCtx }) {
  const phase = state.room.phase;
  if (phase === "config") {
    return (
      <>
        <Logo className="text-3xl" />
        <p className="font-display text-3xl">Aguardando o dono da sala ⏳</p>
        <p className="text-white/70">Ele está escolhendo as músicas.</p>
      </>
    );
  }
  if (phase === "lobby") return <TeamPicker state={state} ctx={ctx} />;
  if (phase === "finished") return <FinalPhone state={state} ctx={ctx} />;
  // jogando
  if (!ctx.team) return <TeamPicker state={state} ctx={ctx} midGame />;
  return <RoundPhone state={state} ctx={ctx} round={currentRound(state)} />;
}

function NameForm({ code, token, onJoined, removed }: { code: string; token: string; onJoined: (id: string) => void; removed?: boolean }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- apelido salvo no aparelho
    setName(getSavedNickname());
  }, []);
  return (
    <Screen>
      <Logo className="text-3xl" />
      <p className="font-display text-2xl">Sala <b className="text-yellow-300">{code}</b></p>
      {removed && <p className="text-white/70">Você saiu da sala. Quer entrar de novo?</p>}
      <form
        className="flex w-full max-w-xs flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const p = await api.join(code, token, name);
            saveNickname(name.trim());
            onJoined(p.id);
          } catch (err) {
            setError(friendlyError(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <input
          autoFocus
          maxLength={20}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Seu apelido"
          className="rounded-2xl bg-white px-4 py-4 text-center font-display text-2xl text-violet-950 outline-none focus:ring-4 ring-yellow-300"
        />
        <Button type="submit" disabled={busy || !name.trim()} className="text-2xl py-4">
          Entrar
        </Button>
        {error && <p className="text-rose-300">{error}</p>}
      </form>
    </Screen>
  );
}

function TeamPicker({ state, ctx, midGame }: { state: RoomState; ctx: PhoneCtx; midGame?: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const solo = state.room.settings.teamMode === "solo";

  if (ctx.team && editing) {
    return (
      <form
        className="flex w-full max-w-sm flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          api.renameTeam(ctx.code, ctx.token, ctx.team!.id, name).catch((err) => setError(friendlyError(err)));
          setEditing(false);
        }}
      >
        <p className="font-display text-2xl">Nome do time</p>
        <input autoFocus maxLength={24} value={name} onChange={(e) => setName(e.target.value)} className="rounded-2xl bg-white px-4 py-3 text-center font-display text-2xl text-violet-950" />
        <Button type="submit" disabled={!name.trim()}>Salvar</Button>
        <Button type="button" variant="ghost" onClick={() => setEditing(false)}>Cancelar</Button>
      </form>
    );
  }

  return (
    <div className="flex w-full max-w-sm flex-col gap-4">
      {midGame ? (
        <p className="font-display text-2xl">A partida já começou! Escolha um time — você joga a partir da próxima música.</p>
      ) : solo ? (
        <p className="font-display text-2xl">Cada um por si! Você é o seu próprio time.</p>
      ) : (
        <p className="font-display text-2xl">Escolha seu time</p>
      )}
      {!solo && (
        <div className="grid grid-cols-2 gap-3">
          {state.teams.map((t) => {
            const mine = t.id === ctx.me.team_id;
            const count = state.players.filter((p) => p.team_id === t.id).length;
            return (
              <button
                key={t.id}
                onClick={() => api.setTeam(ctx.code, ctx.token, t.id).catch((e) => setError(friendlyError(e)))}
                className={`rounded-2xl px-3 py-5 font-display text-xl font-semibold transition ${mine ? "ring-4 ring-white scale-105" : "opacity-85"}`}
                style={{ background: t.color, color: textOn(t.color) }}
              >
                {t.name}
                <span className="block text-sm font-normal opacity-80">{count} {count === 1 ? "jogador" : "jogadores"}</span>
              </button>
            );
          })}
        </div>
      )}
      {ctx.team && !midGame && (
        <>
          <div className="rounded-2xl p-4 font-display text-2xl" style={{ background: ctx.team.color, color: textOn(ctx.team.color) }}>
            {ctx.team.name}
            <p className="text-base opacity-80">
              {state.players.filter((p) => p.team_id === ctx.team!.id).map((p) => p.nickname).join(", ")}
            </p>
          </div>
          <Button variant="secondary" onClick={() => { setName(ctx.team!.name); setEditing(true); }}>✏️ Editar nome do time</Button>
          <p className="text-white/60">Esperando o dono começar…</p>
        </>
      )}
      {error && <p className="text-rose-300">{error}</p>}
    </div>
  );
}

function FinalPhone({ state, ctx }: { state: RoomState; ctx: PhoneCtx }) {
  const rank = ranking(state.teams);
  const mine = rank.find((r) => r.team.id === ctx.team?.id);
  const last = state.rounds[state.rounds.length - 1];
  const delta = roundDelta(state, last ?? null);
  return (
    <>
      <p className="font-display text-4xl font-bold text-yellow-300">Fim de jogo!</p>
      {mine && (
        <div className="npl-pop w-full max-w-sm rounded-3xl p-6" style={{ background: mine.team.color, color: textOn(mine.team.color) }}>
          <p className="font-display text-7xl font-bold">{mine.pos}º</p>
          <p className="font-display text-2xl">{mine.team.name}</p>
          <p className="font-display text-3xl font-bold">{mine.team.score} pts</p>
          {(delta.get(mine.team.id) ?? 0) !== 0 && <p className="opacity-80">última rodada: {delta.get(mine.team.id)}</p>}
        </div>
      )}
      <Button
        className="text-2xl py-4 w-full max-w-sm"
        variant={ctx.me.wants_rematch ? "success" : "primary"}
        onClick={() => api.rematchVote(ctx.code, ctx.token, !ctx.me.wants_rematch)}
      >
        {ctx.me.wants_rematch ? "✓ Quero jogar de novo!" : "🔁 Jogar de novo"}
      </Button>
      <p className="text-white/60">O dono começa a revanche na tela principal.</p>
    </>
  );
}

function Screen({ children }: { children: React.ReactNode }) {
  return <main className="flex flex-1 flex-col items-center justify-center gap-5 p-6 text-center">{children}</main>;
}
