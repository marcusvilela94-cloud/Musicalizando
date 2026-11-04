"use client";
import { useEffect, useState } from "react";

/** Relógio que atualiza a cada `ms` (para contagens regressivas). */
export function useNow(getNow: () => number, ms = 200, active = true) {
  const [now, setNow] = useState(() => getNow());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(getNow()), ms);
    return () => clearInterval(id);
  }, [getNow, ms, active]);
  return now;
}
