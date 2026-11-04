"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Logo } from "@/components/ui";
import { api } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { newOwnerToken, saveOwnerToken } from "@/lib/tokens";

export function CreateRoom() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const token = newOwnerToken();
      const { code } = await api.createRoom(token, {});
      saveOwnerToken(code, token);
      router.replace(`/tv/${code}`);
    } catch (e) {
      setError(friendlyError(e));
      setBusy(false);
    }
  };

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-8 p-8 text-center">
      <Logo className="text-6xl" />
      <p className="max-w-xl text-xl text-white/75">
        Esta tela vai tocar as músicas e mostrar o placar. Os jogadores usam o celular como controle.
      </p>
      <Button onClick={create} disabled={busy} className="text-3xl px-10 py-5">
        {busy ? "Criando…" : "Criar sala"}
      </Button>
      {error && <p className="text-rose-300 text-lg">{error}</p>}
    </main>
  );
}
