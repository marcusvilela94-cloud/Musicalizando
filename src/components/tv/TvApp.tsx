"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Button, Logo, Spinner } from "@/components/ui";
import { useRoom } from "@/hooks/useRoom";
import { useWakeLock } from "@/hooks/useWakeLock";
import { AudioManager } from "@/lib/audio";
import { getOwnerToken } from "@/lib/tokens";
import { ConfigScreen } from "./ConfigScreen";
import { FinalScreen } from "./FinalScreen";
import { GameScreen } from "./GameScreen";
import { LobbyScreen } from "./LobbyScreen";

export type TvCtx = {
  code: string;
  owner: string;
  audio: AudioManager;
  unlockAudio: () => Promise<void>;
  serverNow: () => number;
  online: Set<string>;
};

export function TvApp() {
  const { code } = useParams<{ code: string }>();
  const [owner, setOwner] = useState<string | null | undefined>(undefined);
  const [audio] = useState(() => new AudioManager());
  const [audioOn, setAudioOn] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- token só existe no navegador
    setOwner(getOwnerToken(code));
  }, [code]);

  // alguém apertou EU SEI!: para o som na hora, antes mesmo de reler o estado
  const onEvent = useCallback(
    (e: { kind?: string; ok?: unknown }) => {
      if (e.kind === "buzz" || (e.kind === "npl_buzz" && e.ok === true)) audio.stopAll();
    },
    [audio],
  );
  const { state, notFound, online, connected, serverNow } = useRoom(code, { kind: "tv" }, onEvent);
  useWakeLock(true);

  const unlockAudio = useCallback(async () => {
    await audio.unlock();
    setAudioOn(true);
  }, [audio]);

  if (owner === undefined) return <Center><Spinner /></Center>;
  if (!owner) {
    return (
      <Center>
        <Logo className="text-5xl" />
        <p className="text-2xl">Esta tela não é a dona da sala {code}.</p>
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

  const ctx: TvCtx = { code, owner, audio, unlockAudio, serverNow, online };
  const phase = state.room.phase;

  return (
    <div className="relative flex flex-1 flex-col">
      {!connected && (
        <div className="absolute right-4 top-3 z-50 rounded-full bg-amber-500/90 px-3 py-1 text-sm text-black">
          reconectando…
        </div>
      )}
      {phase === "config" && <ConfigScreen state={state} ctx={ctx} />}
      {phase === "lobby" && <LobbyScreen state={state} ctx={ctx} />}
      {phase === "playing" &&
        (audioOn && audio.unlocked ? (
          <GameScreen state={state} ctx={ctx} />
        ) : (
          <Center>
            <Logo className="text-5xl" />
            <p className="text-2xl text-white/80">A partida está rolando. Clique para liberar o som nesta tela.</p>
            <Button className="text-4xl px-12 py-6" onClick={unlockAudio}>
              ▶ Começar
            </Button>
          </Center>
        ))}
      {phase === "finished" && <FinalScreen state={state} ctx={ctx} />}
    </div>
  );
}

export function Center({ children }: { children: React.ReactNode }) {
  return <main className="flex flex-1 flex-col items-center justify-center gap-6 p-8 text-center">{children}</main>;
}
