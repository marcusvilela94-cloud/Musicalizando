"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Button, Logo, Spinner } from "@/components/ui";
import { useRoom } from "@/hooks/useRoom";
import { useWakeLock } from "@/hooks/useWakeLock";
import { api } from "@/lib/api";
import { type AudioManager, sharedAudio } from "@/lib/audio";
import { getOwnerToken } from "@/lib/tokens";
import { ConfigScreen } from "./ConfigScreen";
import { FinalScreen } from "./FinalScreen";
import { GameScreen } from "./GameScreen";
import { OwnerAwayPanel, OwnerClaimScreen } from "./JoinPanel";
import { LobbyScreen } from "./LobbyScreen";

/** "Todos jogam": a TV exibe e comanda. "Com apresentador": a TV só exibe. */
export type TvCtx = {
  code: string;
  /** token da tela (quem criou a sala): busca a música e abre as rodadas */
  host: string;
  audio: AudioManager;
  serverNow: () => number;
  online: Set<string>;
};

export function TvApp() {
  const { code } = useParams<{ code: string }>();
  const [host, setHost] = useState<string | null | undefined>(undefined);
  const [audio] = useState(sharedAudio);
  const [audioOn, setAudioOn] = useState(() => audio.unlocked);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- token só existe no navegador
    setHost(getOwnerToken(code));
  }, [code]);

  // alguém apertou EU SEI!: para o som na hora, antes mesmo de reler o estado
  const onEvent = useCallback(
    (e: { kind?: string; ok?: unknown }) => {
      if (e.kind === "buzz" || (e.kind === "npl_buzz" && e.ok === true)) audio.stopAll();
    },
    [audio],
  );
  const { state, notFound, online, connected, serverNow, ownerAway } = useRoom(
    code,
    { kind: "tv", audio: audioOn },
    onEvent,
  );
  useWakeLock(true);

  // (com apresentador) celular dele caiu no meio da partida: pausa até ele voltar (e retoma sozinho)
  const phase = state?.room.phase;
  const hostStyle = state?.room.settings.roomStyle === "host";
  const claimed = !!state?.owner.claimed;
  const away = hostStyle && claimed && ownerAway;
  const autoPaused = state?.room.paused && state.room.pause_reason === "owner_away";
  useEffect(() => {
    if (!host || !phase) return;
    if (away && phase === "playing" && !state?.room.paused) api.ownerAway(code, host, true).catch(() => {});
    if (!away && autoPaused) api.ownerAway(code, host, false).catch(() => {});
  }, [away, autoPaused, phase, host, code, state?.room.paused]);

  const unlockAudio = async () => {
    await audio.unlock();
    setAudioOn(audio.unlocked);
  };

  if (host === undefined) return <Center><Spinner /></Center>;
  if (!host) {
    return (
      <Center>
        <Logo className="text-5xl" />
        <p className="text-2xl">Esta tela não é a tela principal da sala {code}.</p>
        <p className="text-white/70">Para jogar, abra o link no celular. Para criar uma sala nova, use outra tela.</p>
        <div className="flex gap-4">
          <Link href={`/j/${code}`} className="underline text-yellow-300 text-xl">Entrar como jogador</Link>
          <Link href="/tv" className="underline text-pink-300 text-xl">Criar outra sala</Link>
        </div>
      </Center>
    );
  }
  if (notFound) {
    return (
      <Center>
        <p className="text-3xl font-display">Sala {code} não existe mais (salas expiram após 6 h sem uso).</p>
        <Link href="/tv"><Button className="text-2xl">Criar nova sala</Button></Link>
      </Center>
    );
  }
  if (!state) return <Center><Spinner label="Conectando…" /></Center>;

  // único clique na TV: o navegador exige um toque no próprio aparelho para liberar o som
  if (!audioOn) {
    return (
      <Center>
        <Logo className="text-5xl" />
        <p className="text-2xl text-white/80">Clique para liberar o som nesta tela.</p>
        <Button className="text-4xl px-12 py-6" onClick={unlockAudio}>▶ Começar</Button>
        <p className="text-white/50">Só é preciso clicar aqui uma vez.</p>
      </Center>
    );
  }

  if (hostStyle && !claimed) return <OwnerClaimScreen code={code} host={host} />;

  const ctx: TvCtx = { code, host, audio, serverNow, online };
  const fullOverlay = away && (phase === "playing" || phase === "finished");

  return (
    <div className="relative flex flex-1 flex-col">
      {!connected && (
        <div className="absolute right-4 top-3 z-50 rounded-full bg-amber-500/90 px-3 py-1 text-sm text-black">
          reconectando…
        </div>
      )}
      {phase === "config" && <ConfigScreen state={state} ctx={ctx} />}
      {phase === "lobby" && <LobbyScreen state={state} ctx={ctx} />}
      {phase === "playing" && <GameScreen state={state} ctx={ctx} />}
      {phase === "finished" && <FinalScreen state={state} ctx={ctx} />}
      {away && (
        <div
          className={
            fullOverlay
              ? "absolute inset-0 z-50 flex items-center justify-center bg-black/80"
              : "absolute bottom-4 right-4 z-50"
          }
        >
          <OwnerAwayPanel code={code} host={host} big={fullOverlay} />
        </div>
      )}
    </div>
  );
}

export function Center({ children }: { children: React.ReactNode }) {
  return <main className="flex flex-1 flex-col items-center justify-center gap-6 p-8 text-center">{children}</main>;
}
