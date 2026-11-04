"use client";
import { useEffect } from "react";

/** Mantém a tela acesa enquanto `active` (Wake Lock API; ignora se não houver suporte). */
export function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active || typeof navigator === "undefined" || !("wakeLock" in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let cancelled = false;
    const request = async () => {
      try {
        if (!cancelled && document.visibilityState === "visible") lock = await navigator.wakeLock.request("screen");
      } catch {
        /* sem permissão / bateria fraca: segue sem */
      }
    };
    request();
    // o navegador solta o bloqueio quando a aba some; pede de novo ao voltar
    const onVisible = () => {
      if (document.visibilityState === "visible") request();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      lock?.release().catch(() => {});
    };
  }, [active]);
}
