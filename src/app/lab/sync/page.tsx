import type { Metadata } from "next";
import { LabSync } from "@/components/lab/LabSync";

// Página de TESTE (sincronização prévia x letra). Fora do menu do jogo.
export const metadata: Metadata = {
  title: "Lab · sincronização",
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
};

export default function Page() {
  return <LabSync />;
}
