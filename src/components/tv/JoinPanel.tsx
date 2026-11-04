"use client";
import { useState } from "react";
import { QrCode } from "@/components/QrCode";
import { Button } from "@/components/ui";

/** Código grande + QR para os celulares entrarem. */
export function JoinPanel({ code, size = "lg" }: { code: string; size?: "lg" | "sm" }) {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const url = `${origin}/j/${code}`;
  const big = size === "lg";
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <p className={`font-display text-white/70 ${big ? "text-2xl" : "text-lg"}`}>Entre pelo celular</p>
      <QrCode value={url} size={big ? 240 : 140} />
      <p className={`text-white/70 ${big ? "text-xl" : "text-sm"}`}>{origin.replace(/^https?:\/\//, "")}/j</p>
      <div
        className={`font-display font-bold tracking-[0.15em] text-yellow-300 drop-shadow ${big ? "text-8xl" : "text-5xl"}`}
      >
        {code}
      </div>
    </div>
  );
}

/** QR com a chave do dono, para quem também vai jogar pelo celular. */
export function OwnerPhoneLink({ code, owner }: { code: string; owner: string }) {
  const [open, setOpen] = useState(false);
  const url = `${typeof window !== "undefined" ? window.location.origin : ""}/j/${code}#dono=${owner}`;
  return (
    <div className="flex flex-col items-center gap-2">
      <Button variant="ghost" className="text-sm" onClick={() => setOpen((v) => !v)}>
        {open ? "Fechar" : "👑 Sou o dono e vou jogar pelo celular"}
      </Button>
      {open && (
        <div className="flex flex-col items-center gap-2 rounded-2xl bg-black/40 p-3">
          <QrCode value={url} size={150} />
          <p className="max-w-[220px] text-xs text-white/70">
            Só o dono deve escanear: este QR dá os controles da sala no celular.
          </p>
        </div>
      )}
    </div>
  );
}
