"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Logo } from "@/components/ui";
import { api } from "@/lib/api";
import { sharedAudio } from "@/lib/audio";
import { friendlyError } from "@/lib/errors";
import { newOwnerToken, saveOwnerToken } from "@/lib/tokens";
import type { RoomStyle } from "@/lib/types";

const STYLES: { id: RoomStyle; title: string; text: string; emoji: string }[] = [
  {
    id: "all",
    emoji: "🎉",
    title: "Todos jogam",
    text: "Sem apresentador. Qualquer um comanda pela TV/notebook (ou pelo teclado). Respostas digitadas e conferidas automaticamente.",
  },
  {
    id: "host",
    emoji: "🎤",
    title: "Com apresentador",
    text: "Uma pessoa não joga e comanda tudo pelo celular: toca os trechos e julga as respostas (faladas ou digitadas).",
  },
];

export function CreateRoom() {
  const router = useRouter();
  const [busy, setBusy] = useState<RoomStyle | null>(null);
  const [error, setError] = useState<string | null>(null);

  const create = async (roomStyle: RoomStyle) => {
    setBusy(roomStyle);
    setError(null);
    try {
      // este clique também libera o som da TV (o navegador exige um clique no aparelho)
      await sharedAudio().unlock().catch(() => {});
      const token = newOwnerToken();
      const { code } = await api.createRoom(token, { roomStyle });
      saveOwnerToken(code, token);
      router.replace(`/tv/${code}`);
    } catch (e) {
      setError(friendlyError(e));
      setBusy(null);
    }
  };

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-8 p-8 text-center">
      <Logo className="text-6xl" />
      <h1 className="font-display text-4xl">Como vão jogar?</h1>
      <div className="grid w-full max-w-4xl gap-6 md:grid-cols-2">
        {STYLES.map((s) => (
          <button
            key={s.id}
            disabled={!!busy}
            onClick={() => create(s.id)}
            className="flex flex-col items-center gap-3 rounded-3xl border-4 border-white/20 bg-white/10 p-8 transition hover:border-yellow-300 hover:bg-white/15 disabled:opacity-50"
          >
            <span className="text-6xl">{s.emoji}</span>
            <span className="font-display text-4xl font-bold text-yellow-300">{busy === s.id ? "Criando…" : s.title}</span>
            <span className="text-lg text-white/75">{s.text}</span>
            {s.id === "all" && <span className="text-sm text-white/50">(padrão)</span>}
          </button>
        ))}
      </div>
      {error && <p className="text-rose-300 text-lg">{error}</p>}
    </main>
  );
}
