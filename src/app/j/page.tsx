import { Logo } from "@/components/ui";
import { JoinForm } from "@/components/phone/JoinForm";

export default function JoinPage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-8 p-6">
      <Logo className="text-4xl" />
      <div className="w-full max-w-xs">
        <JoinForm />
      </div>
    </main>
  );
}
