import type { Metadata } from "next";
import { LibraryApp } from "@/components/library/LibraryApp";

// Biblioteca das músicas preparadas (modo Instrumentos). Protegida por senha (BIBLIOTECA_PASSWORD).
export const metadata: Metadata = {
  title: "Biblioteca · Musicalizando",
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
};

export default function Page() {
  return <LibraryApp />;
}
