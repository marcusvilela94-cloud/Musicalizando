"use client";
import { useEffect, useState } from "react";
import { QrCode } from "@/components/QrCode";
import { Button, Logo } from "@/components/ui";
import { api } from "@/lib/api";
import { randomToken } from "@/lib/tokens";

const origin = () => (typeof window !== "undefined" ? window.location.origin : "");

/** Código grande + QR para os celulares entrarem. */
export function JoinPanel({ code, size = "lg" }: { code: string; size?: "lg" | "sm" }) {
  const url = `${origin()}/j/${code}`;
  const big = size === "lg";
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <p className={`font-display text-white/70 ${big ? "text-2xl" : "text-lg"}`}>Entre pelo celular</p>
      <QrCode value={url} size={big ? 240 : 140} />
      <p className={`text-white/70 ${big ? "text-xl" : "text-sm"}`}>{origin().replace(/^https?:\/\//, "")}/j</p>
      <div
        className={`font-display font-bold tracking-[0.15em] text-yellow-300 drop-shadow ${big ? "text-8xl" : "text-5xl"}`}
      >
        {code}
      </div>
    </div>
  );
}

/** Registra um segredo de uso único e devolve a URL do QR "Sou o apresentador". */
function useClaimUrl(code: string, host: string) {
  const [claim] = useState(randomToken);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let alive = true;
    api
      .openClaim(code, host, claim)
      .then(() => alive && setReady(true))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [code, host, claim]);
  return ready ? `${origin()}/j/${code}#dono=${claim}` : null;
}

/** Primeira tela (estilo "Com apresentador"): quem escanear vira o apresentador. */
export function OwnerClaimScreen({ code, host }: { code: string; host: string }) {
  const url = useClaimUrl(code, host);
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-8 text-center">
      <Logo className="text-5xl" />
      <h1 className="font-display text-6xl font-bold text-yellow-300">🎤 Sou o apresentador</h1>
      <p className="max-w-2xl text-2xl text-white/80">
        Quem vai apresentar (e não vai jogar) escaneia este QR com o celular. Os controles (tocar, julgar, placar) ficam todos
        nele; esta tela só mostra o jogo.
      </p>
      {url ? <QrCode value={url} size={300} /> : <div className="h-[316px] w-[316px] animate-pulse rounded-2xl bg-white/20" />}
      <p className="text-white/60">Sala {code} · os jogadores entram depois, pelo QR que aparece em seguida.</p>
    </main>
  );
}

/** Celular do apresentador caiu: QR de reconexão (o mesmo celular volta com o mesmo token). */
export function OwnerAwayPanel({ code, host, big }: { code: string; host: string; big: boolean }) {
  const [swap, setSwap] = useState(false);
  return (
    <div
      className={`flex flex-col items-center gap-3 rounded-3xl border-4 border-yellow-300 bg-violet-950/95 text-center shadow-2xl ${
        big ? "max-w-2xl p-10" : "max-w-xs p-4"
      }`}
    >
      <p className={`font-display font-bold text-yellow-300 ${big ? "text-5xl" : "text-xl"}`}>🎤 Reconectar apresentador</p>
      <p className={big ? "text-2xl text-white/85" : "text-sm text-white/80"}>
        {big ? "O celular do apresentador desconectou. O jogo está pausado até ele voltar." : "O celular do apresentador desconectou."}
      </p>
      {swap ? <SwapOwnerQr code={code} host={host} big={big} /> : <QrCode value={`${origin()}/j/${code}`} size={big ? 260 : 140} />}
      <p className={big ? "text-lg text-white/70" : "text-xs text-white/60"}>
        {swap
          ? "Escaneie com o celular que vai virar o novo apresentador."
          : "Apresentador: escaneie com o MESMO celular (ou só volte para a aba do jogo)."}
      </p>
      {big && (
        <Button variant="ghost" className="text-sm" onClick={() => setSwap((v) => !v)}>
          {swap ? "Voltar ao QR de reconexão" : "Perdeu o celular? Usar outro celular como apresentador"}
        </Button>
      )}
    </div>
  );
}

function SwapOwnerQr({ code, host, big }: { code: string; host: string; big: boolean }) {
  const url = useClaimUrl(code, host);
  const size = big ? 260 : 140;
  return url ? <QrCode value={url} size={size} /> : <div style={{ width: size + 16, height: size + 16 }} className="animate-pulse rounded-2xl bg-white/20" />;
}
