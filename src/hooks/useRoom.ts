"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { api, onAfterMutation } from "@/lib/api";
import { supabase } from "@/lib/supabase";
import type { RoomState } from "@/lib/types";

type Presence = { kind: "tv" | "player"; playerId?: string };
type SyncEvent = { kind?: string; team_id?: string; attempt_id?: string; v?: number };

/**
 * Mantém o estado da sala sincronizado. O banco é a única fonte da verdade:
 * - o banco avisa por Realtime Broadcast (canal npl_room_<id>) a cada mudança;
 * - quem faz uma escrita também avisa os outros pelo mesmo canal;
 * - polling de segurança (mais rápido se o Realtime cair).
 * Ao receber um aviso, o cliente relê o estado completo via npl_get_state.
 */
export function useRoom(code: string, presence?: Presence, onEvent?: (e: SyncEvent) => void) {
  const [state, setState] = useState<RoomState | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState<Set<string>>(new Set());
  const [connected, setConnected] = useState(false);

  const versionRef = useRef(-1);
  const offsetRef = useRef(0);
  const bestRttRef = useRef(Infinity);
  const inflight = useRef(false);
  const again = useRef(false);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const onEventRef = useRef(onEvent);
  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  const refresh = useCallback(async () => {
    if (inflight.current) {
      again.current = true;
      return;
    }
    inflight.current = true;
    try {
      do {
        again.current = false;
        const t0 = Date.now();
        const s = await api.getState(code);
        const t1 = Date.now();
        if (!s) {
          setNotFound(true);
          return;
        }
        // relógio do servidor: guarda a amostra com menor ida-e-volta
        const rtt = t1 - t0;
        if (rtt <= bestRttRef.current * 1.5 || rtt < 400) {
          bestRttRef.current = Math.min(bestRttRef.current, rtt);
          offsetRef.current = s.server_now - (t0 + t1) / 2;
        }
        // ignora respostas fora de ordem
        if (s.room.version >= versionRef.current) {
          versionRef.current = s.room.version;
          setState(s);
        }
        setError(null);
      } while (again.current);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      inflight.current = false;
    }
  }, [code]);

  // carga inicial
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- busca inicial do estado da sala
    refresh();
  }, [refresh]);

  const roomId = state?.room.id;
  const presenceKey = presence ? `${presence.kind}:${presence.playerId ?? ""}` : "";

  // canal Realtime
  useEffect(() => {
    if (!roomId) return;
    const ch = supabase().channel(`npl_room_${roomId}`, {
      config: { broadcast: { self: false }, presence: { key: presenceKey || `anon-${Math.random()}` } },
    });
    ch.on("broadcast", { event: "sync" }, ({ payload }) => {
      onEventRef.current?.(payload as SyncEvent);
      refresh();
    });
    ch.on("presence", { event: "sync" }, () => {
      const ids = new Set<string>();
      for (const metas of Object.values(ch.presenceState<Presence>())) {
        for (const m of metas) if (m.playerId) ids.add(m.playerId);
      }
      setOnline(ids);
    });
    ch.subscribe(async (status) => {
      setConnected(status === "SUBSCRIBED");
      if (status === "SUBSCRIBED") {
        if (presenceKey) {
          const [kind, playerId] = presenceKey.split(":");
          await ch.track({ kind, playerId: playerId || undefined });
        }
        refresh();
      }
    });
    channelRef.current = ch;
    return () => {
      channelRef.current = null;
      supabase().removeChannel(ch);
    };
  }, [roomId, presenceKey, refresh]);

  // depois de cada escrita: recarrega e avisa os outros aparelhos
  useEffect(() => {
    onAfterMutation((kind, extra) => {
      refresh();
      channelRef.current?.send({ type: "broadcast", event: "sync", payload: { kind, ...extra } }).catch(() => {});
    });
    return () => onAfterMutation(null);
  }, [refresh]);

  // polling de segurança + ao voltar para a aba / reconectar
  useEffect(() => {
    const ms = connected ? 5000 : 1500;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, ms);
    const wake = () => document.visibilityState === "visible" && refresh();
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    window.addEventListener("focus", wake);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
      window.removeEventListener("focus", wake);
    };
  }, [connected, refresh]);

  const serverNow = useCallback(() => Date.now() + offsetRef.current, []);

  return { state, notFound, error, online, connected, refresh, serverNow };
}
