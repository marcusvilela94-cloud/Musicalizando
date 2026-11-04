"use client";
import { useEffect, useState } from "react";
import { Button, Card, Logo } from "@/components/ui";
import { api, deezer } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import type { MusicSource, RoomSettings, RoomState } from "@/lib/types";
import { JoinPanel } from "./JoinPanel";
import type { TvCtx } from "./TvApp";

const PRESET_SOURCES: MusicSource[] = [{ type: "preset", id: "top_brasil", label: "Top Brasil" }];

const sameSource = (a: MusicSource, b: MusicSource) => a.type === b.type && a.id === b.id;

export function ConfigScreen({ state, ctx }: { state: RoomState; ctx: TvCtx }) {
  const [settings, setSettings] = useState<RoomSettings>(state.room.settings);
  const [error, setError] = useState<string | null>(null);

  // acompanha mudanças vindas do servidor (ex.: dono mexeu pelo celular)
  const serverSettings = JSON.stringify(state.room.settings);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sincroniza rascunho com o servidor
    setSettings(JSON.parse(serverSettings));
  }, [serverSettings]);

  const update = async (patch: Partial<RoomSettings>) => {
    setSettings((s) => ({ ...s, ...patch }));
    try {
      setError(null);
      await api.updateSettings(ctx.code, ctx.owner, patch);
    } catch (e) {
      setError(friendlyError(e));
    }
  };

  const addSource = (src: MusicSource) => {
    if (settings.sources.some((s) => sameSource(s, src))) return;
    update({ sources: [...settings.sources, src] });
  };
  const removeSource = (src: MusicSource) => update({ sources: settings.sources.filter((s) => !sameSource(s, src)) });

  return (
    <main className="grid flex-1 grid-cols-1 gap-6 p-6 lg:grid-cols-[1fr_320px] lg:p-10">
      <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <Logo className="text-4xl" />
          <h1 className="font-display text-3xl text-white/80">Configuração da partida</h1>
        </div>

        <Card className="flex flex-col gap-4">
          <h2 className="font-display text-2xl font-semibold">🎵 Músicas</h2>
          <div className="flex flex-wrap gap-2">
            {settings.sources.map((s) => (
              <span key={`${s.type}:${s.id}`} className="inline-flex items-center gap-2 rounded-full bg-white/15 py-1 pl-4 pr-1 text-lg">
                <span className="text-white/60 text-sm">
                  {s.type === "artist" ? "Artista" : s.type === "preset" ? "Pronta" : "Playlist"}
                </span>
                {s.label}
                <button
                  className="h-8 w-8 rounded-full bg-white/10 hover:bg-rose-500"
                  onClick={() => removeSource(s)}
                  disabled={settings.sources.length <= 1}
                  title="Remover"
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            <div className="flex flex-col gap-2">
              <p className="text-white/70">Playlists prontas</p>
              {PRESET_SOURCES.map((p) => (
                <Button key={p.id} variant="secondary" onClick={() => addSource(p)} disabled={settings.sources.some((s) => sameSource(s, p))}>
                  + {p.label}
                </Button>
              ))}
            </div>
            <PlaylistLinkInput onAdd={addSource} />
            <ArtistSearch onAdd={addSource} />
          </div>
        </Card>

        <div className="grid gap-6 md:grid-cols-2">
          <Card className="flex flex-col gap-3">
            <h2 className="font-display text-xl font-semibold">Número de músicas: {settings.rounds}</h2>
            <input
              type="range"
              min={5}
              max={30}
              value={settings.rounds}
              onChange={(e) => setSettings((s) => ({ ...s, rounds: Number(e.target.value) }))}
              onPointerUp={(e) => update({ rounds: Number((e.target as HTMLInputElement).value) })}
              onKeyUp={(e) => update({ rounds: Number((e.target as HTMLInputElement).value) })}
              className="accent-yellow-300"
            />
          </Card>
          <Card className="flex flex-col gap-3">
            <h2 className="font-display text-xl font-semibold">Tempo de resposta do time</h2>
            <Segmented
              value={settings.answerSeconds}
              options={[[10, "10s"], [20, "20s"], [30, "30s"], [0, "Sem limite"]]}
              onChange={(v) => update({ answerSeconds: v as RoomSettings["answerSeconds"] })}
            />
          </Card>
          <Card className="flex flex-col gap-3">
            <h2 className="font-display text-xl font-semibold">Penalidade por erro</h2>
            <Segmented
              value={settings.penalty}
              options={[[0, "Desligada"], [20, "−20"], [50, "−50"]]}
              onChange={(v) => update({ penalty: v as RoomSettings["penalty"] })}
            />
          </Card>
          <Card className="flex flex-col gap-3">
            <h2 className="font-display text-xl font-semibold">O que vale</h2>
            <Segmented
              value={settings.scoring}
              options={[["artist_title", "Artista + bônus pelo título"], ["title", "Só o título"]]}
              onChange={(v) => update({ scoring: v as RoomSettings["scoring"] })}
            />
          </Card>
          <Card className="flex flex-col gap-3 md:col-span-2">
            <h2 className="font-display text-xl font-semibold">Times</h2>
            <div className="flex flex-wrap items-center gap-4">
              <Segmented
                value={settings.teamMode}
                options={[["teams", "Em times"], ["solo", "Cada um por si"]]}
                onChange={(v) => update({ teamMode: v as RoomSettings["teamMode"] })}
              />
              {settings.teamMode === "teams" && (
                <div className="flex items-center gap-3">
                  <Button variant="secondary" onClick={() => update({ teamCount: Math.max(2, settings.teamCount - 1) })}>−</Button>
                  <span className="font-display text-2xl w-24 text-center">{settings.teamCount} times</span>
                  <Button variant="secondary" onClick={() => update({ teamCount: Math.min(12, settings.teamCount + 1) })}>+</Button>
                </div>
              )}
            </div>
            <p className="text-white/60 text-sm">Times vazios ficam de fora quando a partida começa.</p>
          </Card>
        </div>

        {error && <p className="text-rose-300 text-lg">{error}</p>}
        <div className="flex justify-end">
          <Button className="text-2xl px-10 py-4" onClick={() => api.setPhase(ctx.code, ctx.owner, "lobby").catch((e) => setError(friendlyError(e)))}>
            Pronto! Montar times →
          </Button>
        </div>
      </div>

      <aside className="flex flex-col items-center gap-6">
        <JoinPanel code={ctx.code} size="sm" />
        <Card className="w-full">
          <p className="font-display text-lg mb-2">Já entraram ({state.players.length})</p>
          <ul className="flex flex-wrap gap-2">
            {state.players.map((p) => (
              <li key={p.id} className="rounded-full bg-white/15 px-3 py-1">{p.nickname}</li>
            ))}
          </ul>
        </Card>
      </aside>
    </main>
  );
}

function Segmented<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map(([v, label]) => (
        <button
          key={String(v)}
          onClick={() => onChange(v)}
          className={`rounded-xl px-4 py-2 font-display text-lg transition ${
            v === value ? "bg-yellow-300 text-violet-950" : "bg-white/10 hover:bg-white/20"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function PlaylistLinkInput({ onAdd }: { onAdd: (s: MusicSource) => void }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const add = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const p = await deezer.playlist(url);
      onAdd({ type: "playlist", id: p.id, label: p.title, picture: p.picture, nbTracks: p.nbTracks });
      setUrl("");
      setMsg(`✓ ${p.title} (${p.nbTracks} músicas)`);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="flex flex-col gap-2" onSubmit={(e) => (e.preventDefault(), add())}>
      <p className="text-white/70">Colar link de playlist do Deezer</p>
      <input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="deezer.com/.../playlist/123 ou link.deezer.com/…"
        className="rounded-xl bg-white/90 px-3 py-2 text-violet-950 outline-none"
      />
      <Button type="submit" variant="secondary" disabled={busy || !url.trim()}>
        {busy ? "Procurando…" : "Adicionar playlist"}
      </Button>
      {msg && <p className="text-sm text-white/80">{msg}</p>}
    </form>
  );
}

function ArtistSearch({ onAdd }: { onAdd: (s: MusicSource) => void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<{ id: string; name: string; picture: string | null }[]>([]);
  useEffect(() => {
    if (q.trim().length < 2) return;
    const t = setTimeout(() => {
      deezer.artists(q).then(setResults).catch(() => setResults([]));
    }, 350);
    return () => clearTimeout(t);
  }, [q]);
  const visible = q.trim().length >= 2 ? results : [];
  return (
    <div className="flex flex-col gap-2">
      <p className="text-white/70">Buscar artista</p>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Ex.: Marília Mendonça"
        className="rounded-xl bg-white/90 px-3 py-2 text-violet-950 outline-none"
      />
      <ul className="flex max-h-48 flex-col gap-1 overflow-auto">
        {visible.map((a) => (
          <li key={a.id}>
            <button
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left hover:bg-white/15"
              onClick={() => {
                onAdd({ type: "artist", id: a.id, label: a.name, picture: a.picture });
                setQ("");
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- miniatura do Deezer */}
              {a.picture && <img src={a.picture} alt="" className="h-8 w-8 rounded-full" />}
              {a.name}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
