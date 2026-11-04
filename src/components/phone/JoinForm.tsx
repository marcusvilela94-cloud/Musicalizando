"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui";

export function JoinForm() {
  const router = useRouter();
  const [code, setCode] = useState("");
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (/^\d{4}$/.test(code)) router.push(`/j/${code}`);
      }}
    >
      <input
        inputMode="numeric"
        autoComplete="off"
        maxLength={4}
        placeholder="0000"
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 4))}
        className="w-full rounded-2xl bg-white text-violet-950 text-center font-display text-4xl tracking-[0.4em] py-3 outline-none focus:ring-4 ring-yellow-300"
      />
      <Button type="submit" disabled={code.length !== 4} className="text-xl py-4">
        Entrar
      </Button>
    </form>
  );
}
