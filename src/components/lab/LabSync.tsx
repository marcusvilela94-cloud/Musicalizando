"use client";
// TESTE DE VIABILIDADE: sincronização entre a prévia do Deezer e a letra.
// Não é parte do jogo. Analisa uma música por vez (Groq: 20 pedidos/minuto).
import { useEffect, useRef, useState } from "react";

type SyncLine = { idx: number; text: string; start: number; confidence: number; cut: boolean; lrcStart: number | null; source: "audio" | "lrc" };
type Result = {
  id: string;
  title: string;
  artist: string;
  cover: string | null;
  preview: string;
  language: string | null;
  transcript: string;
  words: number;
  hasSynced: boolean;
  offset: number | null;
  lines: SyncLine[];
};
type Item = { id: number; title: string; artist: string; status: "waiting" | "running" | "done" | "error"; result?: Result; error?: string };

/** Intervalo mínimo entre os pedidos ao Groq (20 por minuto). */
const GAP_MS = 3200;
const GOOD = 70;

const usable = (l: SyncLine) => l.source === "audio" && !l.cut && l.confidence > GOOD;
const avgConf = (r: Result) => {
  const a = r.lines.filter((l) => l.source === "audio");
  return a.length ? Math.round(a.reduce((s, l) => s + l.confidence, 0) / a.length) : 0;
};

export function LabSync() {
  const [url, setUrl] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const stop = useRef(false);

  const analyze = async (useTop: boolean) => {
    setBusy(true);
    setMsg("Montando a lista de músicas (com letra)…");
    stop.current = false;
    try {
      let source: { type: string; id: string; label: string };
      if (useTop) source = { type: "preset", id: "top_brasil", label: "Top Brasil" };
      else {
        const r = await fetch(`/api/deezer/playlist?url=${encodeURIComponent(url)}`);
        const p = await r.json();
        if (!r.ok) throw new Error(p.error ?? "Playlist inválida");
        source = { type: "playlist", id: p.id, label: p.title };
      }
      const b = await fetch("/api/deezer/build", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sources: [source], count: 20, versionFilter: true, lyrics: 20 }),
      });
      const list = await b.json();
      if (!b.ok) throw new Error(list.error ?? "Erro ao montar a lista");
      const queue: Item[] = list.tracks.map((t: { deezer_id: number; title: string; artist: string }) => ({
        id: t.deezer_id,
        title: t.title,
        artist: t.artist,
        status: "waiting",
      }));
      setItems(queue);
      setMsg(null);
      // uma por vez, com intervalo entre os pedidos
      let last = 0;
      for (let i = 0; i < queue.length && !stop.current; i++) {
        const wait = last + GAP_MS - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        last = Date.now();
        setItems((xs) => xs.map((x, k) => (k === i ? { ...x, status: "running" } : x)));
        try {
          const r = await fetch(`/api/lab/sync/${queue[i].id}`);
          const j = await r.json();
          if (!r.ok) throw new Error(j.error ?? `Erro ${r.status}`);
          setItems((xs) => xs.map((x, k) => (k === i ? { ...x, status: "done", result: j } : x)));
        } catch (e) {
          setItems((xs) => xs.map((x, k) => (k === i ? { ...x, status: "error", error: (e as Error).message } : x)));
        }
      }
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const done = items.filter((x) => x.status === "done");
  const ok = done.filter((x) => x.result!.lines.filter(usable).length >= 2);

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 text-left">
      <h1 className="font-display text-3xl font-bold">🧪 Lab: sincronização prévia × letra</h1>
      <p className="text-sm text-white/60">
        Teste de viabilidade do modo “Continuar a letra”. Transcreve a prévia (Groq whisper-large-v3), alinha com a letra (LRCLIB) e
        mostra em que segundo cada linha começa. Uma música a cada ~3 s (limite gratuito do Groq).
      </p>
      <div className="flex flex-wrap gap-2">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Link de playlist do Deezer"
          className="min-w-64 flex-1 rounded-xl bg-white/90 px-3 py-2 text-violet-950 outline-none"
        />
        <button disabled={busy || !url.trim()} onClick={() => analyze(false)} className="rounded-xl bg-yellow-300 px-4 py-2 font-display text-violet-950 disabled:opacity-40">
          Analisar 20 músicas
        </button>
        <button disabled={busy} onClick={() => analyze(true)} className="rounded-xl bg-white/15 px-4 py-2 font-display disabled:opacity-40">
          Usar o Top Brasil
        </button>
        {busy && (
          <button onClick={() => (stop.current = true)} className="rounded-xl bg-rose-500 px-4 py-2 font-display">
            Parar
          </button>
        )}
      </div>
      {msg && <p className="text-yellow-200">{msg}</p>}

      {items.length > 0 && (
        <div className="rounded-2xl bg-black/30 p-4 font-display text-xl">
          <b className="text-yellow-300">{ok.length}</b> de {done.length} analisadas tiveram pelo menos 2 linhas com confiança acima de {GOOD}%
          <span className="text-base text-white/60">
            {" "}
            · {items.filter((x) => x.status === "waiting" || x.status === "running").length} na fila ·{" "}
            {items.filter((x) => x.status === "error").length} com erro
          </span>
        </div>
      )}

      <div className="flex flex-col gap-3">
        {items.map((it) => (
          <Card key={it.id} item={it} />
        ))}
      </div>
    </main>
  );
}

function Card({ item }: { item: Item }) {
  const r = item.result;
  return (
    <section className="rounded-2xl border border-white/15 bg-white/5 p-4">
      <div className="flex items-center gap-3">
        {r?.cover && (
          // eslint-disable-next-line @next/next/no-img-element -- capa do Deezer
          <img src={r.cover} alt="" className="h-14 w-14 rounded-lg" />
        )}
        <div className="flex-1">
          <p className="font-display text-xl font-semibold">{item.title}</p>
          <p className="text-white/70">{item.artist}</p>
        </div>
        <span className="text-right text-sm text-white/70">
          {item.status === "waiting" && "na fila"}
          {item.status === "running" && "⏳ analisando…"}
          {item.status === "error" && <span className="text-rose-300">erro: {item.error}</span>}
          {r && (
            <>
              confiança média <b className="text-lg text-white">{avgConf(r)}%</b>
              <br />
              {r.lines.filter(usable).length} linhas boas · idioma {r.language ?? "?"} · {r.words} palavras ouvidas
              <br />
              {r.hasSynced ? `LRC sincronizado${r.offset !== null ? `: prévia começa em ${fmt(r.offset)} da música` : ""}` : "sem LRC sincronizado"}
            </>
          )}
        </span>
      </div>
      {r && <Player r={r} />}
    </section>
  );
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;

/** Play com efeito karaokê + "parar antes da linha". */
function Player({ r }: { r: Result }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const raf = useRef<number | null>(null);
  const [t, setT] = useState<number | null>(null);
  const [stopAt, setStopAt] = useState<number | null>(null);
  const [showText, setShowText] = useState(false);

  useEffect(
    () => () => {
      if (raf.current) cancelAnimationFrame(raf.current);
      audio.current?.pause();
    },
    [],
  );

  const tick = (limit: number | null) => {
    const a = audio.current;
    if (!a) return;
    if (limit !== null && a.currentTime >= limit) {
      a.pause();
      setT(a.currentTime);
      setStopAt(null);
      return;
    }
    setT(a.currentTime);
    if (!a.paused && !a.ended) raf.current = requestAnimationFrame(() => tick(limit));
    else setT(null);
  };
  const play = (limit: number | null) => {
    if (!audio.current) audio.current = new Audio(r.preview);
    const a = audio.current;
    if (raf.current) cancelAnimationFrame(raf.current);
    a.pause();
    a.currentTime = 0;
    setStopAt(limit);
    a.play().then(() => tick(limit)).catch(() => {});
  };
  const pause = () => {
    audio.current?.pause();
    setT(null);
    setStopAt(null);
  };

  // linha "cantando agora" = a última que já começou
  const audioLines = r.lines;
  const current = t === null ? -1 : audioLines.reduce((acc, l, k) => (l.start <= t ? k : acc), -1);

  return (
    <div className="mt-3 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => play(null)} className="rounded-lg bg-yellow-300 px-3 py-1 font-display text-violet-950">▶ Play (karaokê)</button>
        <button onClick={pause} className="rounded-lg bg-white/15 px-3 py-1 font-display">⏹ Parar</button>
        <span className="font-mono text-sm text-white/70">{t !== null ? `${t.toFixed(1)}s` : ""}{stopAt !== null ? ` → para em ${stopAt.toFixed(1)}s` : ""}</span>
        <button onClick={() => setShowText((v) => !v)} className="ml-auto text-sm text-white/60 underline">
          {showText ? "esconder" : "ver"} transcrição
        </button>
      </div>
      {showText && <p className="rounded-lg bg-black/30 p-2 text-sm text-white/70">“{r.transcript}”</p>}
      {audioLines.length === 0 ? (
        <p className="text-white/60">Nenhuma linha da letra encontrada na prévia.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {audioLines.map((l, k) => {
            const can = !l.cut && l.start - 0.3 > 0.3;
            return (
              <li
                key={`${l.idx}-${k}`}
                className={`flex flex-wrap items-center gap-2 rounded-lg px-2 py-1 transition ${
                  k === current ? "scale-[1.01] bg-yellow-300 text-violet-950" : l.source === "lrc" ? "bg-white/5 text-white/50" : "bg-white/10"
                }`}
              >
                <span className="w-14 font-mono text-sm">{l.start.toFixed(2)}s</span>
                <span className={`w-12 text-right font-mono text-sm ${l.confidence > GOOD ? "text-emerald-400" : l.confidence >= 40 ? "text-yellow-400" : "text-rose-400"} ${k === current ? "!text-violet-950" : ""}`}>
                  {l.source === "lrc" ? "LRC" : `${l.confidence}%`}
                </span>
                <span className="flex-1">{l.text}</span>
                {l.cut && <span className="text-xs opacity-70">começou antes da prévia</span>}
                {l.lrcStart !== null && l.source === "audio" && (
                  <span className="font-mono text-xs opacity-60">LRC {l.lrcStart.toFixed(2)}s</span>
                )}
                <button
                  disabled={!can}
                  onClick={() => play(l.start - 0.3)}
                  className="rounded-md bg-black/30 px-2 py-0.5 text-sm disabled:opacity-30"
                  title="Toca do começo e para 0,3 s antes desta linha"
                >
                  ⏸ Parar antes da linha
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
