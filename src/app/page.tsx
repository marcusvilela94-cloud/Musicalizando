import Link from "next/link";
import { Logo } from "@/components/ui";
import { JoinForm } from "@/components/phone/JoinForm";

export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-10 p-6 text-center">
      <div>
        <Logo className="text-5xl sm:text-7xl" />
        <p className="mt-3 text-lg text-white/70">Adivinhe a música antes dos seus amigos.</p>
      </div>
      <div className="grid w-full max-w-3xl gap-6 sm:grid-cols-2">
        <div className="rounded-3xl bg-white/10 border border-white/15 p-6 flex flex-col gap-4">
          <h2 className="font-display text-2xl font-semibold">📱 Vou jogar</h2>
          <p className="text-white/70 text-sm">Digite o código que aparece na TV.</p>
          <JoinForm />
        </div>
        <div className="rounded-3xl bg-white/10 border border-white/15 p-6 flex flex-col gap-4">
          <h2 className="font-display text-2xl font-semibold">📺 Tela principal</h2>
          <p className="text-white/70 text-sm">Abra na TV ou no notebook que vai tocar o som. Quem cria a sala é o dono.</p>
          <Link
            href="/tv"
            className="mt-auto font-display font-semibold rounded-2xl px-5 py-4 text-xl bg-pink-500 hover:bg-pink-400 shadow-[0_6px_0_#9d174d] active:shadow-none active:translate-y-[6px] transition"
          >
            Criar sala
          </Link>
        </div>
      </div>
    </main>
  );
}
