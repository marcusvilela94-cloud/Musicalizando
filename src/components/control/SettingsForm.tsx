"use client";
import { useEffect, useState } from "react";
import { Button, Card } from "@/components/ui";
import { api, deezer } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import type { ArtistLevel, ModeId, MusicSource, RoomSettings, RoomState } from "@/lib/types";
import { getMode } from "@/modes";
import { MODE_LIST, enabledModes, type ModeOrder } from "@/modes/schedule";

const PRESET_SOURCES: MusicSource[] = [{ type: "preset", id: "top_brasil", label: "Top Brasil" }];
const sameSource = (a: MusicSource, b: MusicSource) => a.type === b.type && a.id === b.id;

/** Popularidade das músicas de cada artista. */
const LEVELS: [ArtistLevel, string, string][] = [
  ["hits", "⭐ Sucessos", "entre as 15 mais tocadas"],
  ["known", "🎧 Conhecidas", "entre as 50 mais tocadas"],
  ["fan", "🤓 Fã de carteirinha", "todo o catálogo (álbuns e singles)"],
];

/** "1,2 mi fãs" / "35 mil fãs". */
const fansLabel = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mi fãs`
    : n >= 1000
      ? `${Math.round(n / 1000)} mil fãs`
      : `${n} fãs`;

const MODE_HINTS: Record<ModeId, string> = {
  classic: "Trechos crescentes (1s, 2s, 4s…): quem apertar EU SEI! primeiro responde. Quanto antes, mais pontos.",
  auction:
    "A TV dá uma dica (artista, ou gênero e ano). Os times dão lances de quantos segundos precisam (começa em 20s); o menor lance ouve primeiro. Acerto vale 100. Sem penalidade.",
  lyrics:
    "Sem som: a TV mostra trechos da letra (título e artista viram ___), um verso por vez. Quanto menos versos, mais pontos: 100, 75, 50, 30 e 15 no refrão. A prévia toca na revelação.",
  continue:
    "A TV mostra música e artista e toca um trecho que para logo antes de uma linha: cante/digite a próxima linha (vale 100). Na revelação, a música segue até o fim para todo mundo cantar junto.",
};

const ORDER_HINTS: Record<ModeOrder, string> = {
  alternate: "Os modos se revezam em ordem fixa, com o mesmo número de músicas para cada um.",
  random: "Cada rodada sorteia um dos modos ligados.",
  blocks: "Primeiro todas as rodadas do 1º modo da lista, depois as do 2º… dividindo as músicas igualmente.",
};

/** Em quais modos cada opção vale (para esconder ou etiquetar). */
const APPLIES = {
  scoring: ["classic", "lyrics"] as ModeId[], // O que vale
  penalty: ["classic", "lyrics"] as ModeId[], // Penalidade
  lock: ["classic", "lyrics", "continue"] as ModeId[], // Bloqueio após erro
  clips: ["classic"] as ModeId[], // Trechos
};

/**
 * Configuração da partida. Aparece na TV (estilo "Todos jogam") ou no
 * celular do apresentador (estilo "Com apresentador").
 */
export function SettingsForm({ state, code, token, onDone }: { state: RoomState; code: string; token: string; onDone: () => void }) {
  const [settings, setSettings] = useState<RoomSettings>(state.room.settings);
  const [error, setError] = useState<string | null>(null);
  const host = settings.roomStyle === "host";

  // acompanha mudanças vindas do servidor
  const serverSettings = JSON.stringify(state.room.settings);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sincroniza rascunho com o servidor
    setSettings(JSON.parse(serverSettings));
  }, [serverSettings]);

  const update = async (patch: Partial<RoomSettings>) => {
    setSettings((s) => ({ ...s, ...patch }));
    try {
      setError(null);
      await api.updateSettings(code, token, patch);
    } catch (e) {
      setError(friendlyError(e));
    }
  };
  const addSource = (src: MusicSource) => {
    if (settings.sources.some((s) => sameSource(s, src))) return;
    update({ sources: [...settings.sources, src] });
  };
  const removeSource = (src: MusicSource) => update({ sources: settings.sources.filter((s) => !sameSource(s, src)) });
  const setLevel = (src: MusicSource, level: ArtistLevel) =>
    update({ sources: settings.sources.map((s) => (sameSource(s, src) && s.type === "artist" ? { ...s, level } : s)) });

  // modos ligados (pelo menos um); 2 ou mais = a partida mistura
  const on = enabledModes(settings);
  const toggleMode = (m: ModeId) => {
    const next = on.includes(m) ? on.filter((x) => x !== m) : MODE_LIST.filter((x) => x === m || on.includes(x));
    if (!next.length) return; // não deixa desligar o último
    update({ modePool: next, mode: next[0], modeSelection: next.length > 1 ? "random" : "fixed" });
  };
  const order: ModeOrder = settings.modeOrder ?? "alternate";
  // opção aparece se vale para algum modo ligado; etiqueta quando vale só para alguns
  const applies = (modes: ModeId[]) => on.some((m) => modes.includes(m));
  const tagFor = (modes: ModeId[]) => {
    const yes = on.filter((m) => modes.includes(m));
    return yes.length && yes.length < on.length ? `só no ${yes.map((m) => getMode(m).label).join(" e no ")}` : undefined;
  };
  const show = { scoring: applies(APPLIES.scoring), penalty: applies(APPLIES.penalty), lock: applies(APPLIES.lock) };
  const tag = { scoring: tagFor(APPLIES.scoring), penalty: tagFor(APPLIES.penalty), lock: tagFor(APPLIES.lock) };
  const showClips = applies(APPLIES.clips);
  const clipsTag = tagFor(APPLIES.clips);

  return (
    <div className="flex w-full flex-col gap-4 text-left">
      <Card className="flex flex-col gap-4">
        <h2 className="font-display text-2xl font-semibold">🎵 Músicas</h2>
        <div className="flex flex-wrap gap-2">
          {settings.sources.map((s) => (
            <span key={`${s.type}:${s.id}`} className="inline-flex items-center gap-2 rounded-full bg-white/15 py-1 pl-4 pr-1 text-lg">
              <span className="text-white/60 text-sm">{s.type === "artist" ? "Artista" : s.type === "preset" ? "Pronta" : "Playlist"}</span>
              {s.type === "artist" && s.picture && (
                // eslint-disable-next-line @next/next/no-img-element -- foto do Deezer
                <img src={s.picture} alt="" className="h-7 w-7 rounded-full" />
              )}
              {s.label}
              {s.type === "artist" && (
                <select
                  value={s.level ?? "known"}
                  onChange={(e) => setLevel(s, e.target.value as ArtistLevel)}
                  title={LEVELS.find(([v]) => v === (s.level ?? "known"))?.[2]}
                  className="rounded-full bg-white/90 px-2 py-0.5 text-sm text-violet-950 outline-none"
                >
                  {LEVELS.map(([v, label, hint]) => (
                    <option key={v} value={v} title={hint}>{label}</option>
                  ))}
                </select>
              )}
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

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="flex flex-col gap-3 md:col-span-2">
          <h2 className="font-display text-xl font-semibold">Modos de jogo</h2>
          <div className="flex flex-col gap-2">
            {MODE_LIST.map((m) => {
              const def = getMode(m);
              const active = on.includes(m);
              const last = active && on.length === 1;
              return (
                <button
                  key={m}
                  onClick={() => toggleMode(m)}
                  disabled={last}
                  title={last ? "Pelo menos um modo precisa ficar ligado" : undefined}
                  className={`flex items-start gap-3 rounded-2xl px-4 py-3 text-left transition ${
                    active ? "bg-yellow-300 text-violet-950" : "bg-white/10 hover:bg-white/20"
                  } ${last ? "cursor-default" : ""}`}
                >
                  <span className="mt-0.5 font-display text-2xl">{active ? "☑" : "☐"}</span>
                  <span className="flex flex-col">
                    <span className="font-display text-xl">{def.icon} {def.label}</span>
                    <span className={`text-sm ${active ? "text-violet-950/70" : "text-white/60"}`}>{MODE_HINTS[m]}</span>
                  </span>
                </button>
              );
            })}
          </div>
          {on.length > 1 && (
            <div className="flex flex-col gap-2 rounded-2xl bg-black/20 p-3">
              <p className="font-display text-lg">Ordem dos modos</p>
              <Segmented value={order} onChange={(v) => update({ modeOrder: v })}
                options={[["alternate", "Alternando"], ["random", "Sorteado"], ["blocks", "Em blocos"]]} />
              <p className="text-sm text-white/60">{ORDER_HINTS[order]}</p>
            </div>
          )}
        </Card>
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
        {show.scoring && (
          <Option title="O que vale" tag={tag.scoring} value={settings.scoring} onChange={(v) => update({ scoring: v })}
            options={[["artist_title", "Artista e música"], ["title", "Só a música"]]}
            hint={settings.scoring === "artist_title" ? "Artista vale 50% dos pontos, música 100%, as duas juntas 150%." : undefined} />
        )}
        {host && (
          <Option title="Modo de resposta" value={settings.answerMode} onChange={(v) => update({ answerMode: v })}
            options={[["spoken", "Falada"], ["typed", "Digitada"]]}
            hint={settings.answerMode === "spoken" ? "O time fala em voz alta e o apresentador julga." : "O time digita no celular e o sistema confere."} />
        )}
        {showClips && (
        <Option title="Trechos" tag={clipsTag} value={settings.clipMode ?? "sequence"} onChange={(v) => update({ clipMode: v })}
          options={[["sequence", "Em sequência"], ["alternate", "Alternando"]]}
          hint={(settings.clipMode ?? "sequence") === "sequence"
            ? "Todos os trechos começam do início da prévia e vão crescendo: 1s, 2s, 4s, 8s, 15s, 30s."
            : "Cada trecho começa num ponto sorteado diferente da prévia; o último toca a prévia inteira."} />
        )}
        <Option title="Tempo de resposta do time" value={settings.answerSeconds} onChange={(v) => update({ answerSeconds: v })}
          options={[[10, "10s"], [20, "20s"], [30, "30s"], [0, "Sem limite"]]} />
        {show.lock && (
          <Option title="Bloqueio após erro" tag={tag.lock} value={settings.lockSeconds} onChange={(v) => update({ lockSeconds: v })}
            options={[[5, "5s"], [10, "10s"], [15, "15s"], [20, "20s"], [30, "30s"]]}
            hint="Quem erra fica bloqueado; a contagem só começa quando a música volta a tocar. Se outro time errar, quem estava bloqueado é liberado." />
        )}
        {show.penalty && (
          <Option title="Penalidade por erro" tag={tag.penalty} value={settings.penalty} onChange={(v) => update({ penalty: v })}
            options={[[0, "Desligada"], [20, "−20"], [50, "−50"]]} />
        )}
        <Option title="Desempate" value={settings.tiebreak ?? "sudden"} onChange={(v) => update({ tiebreak: v })}
          options={[["sudden", "Morte súbita"], ["accept", "Aceitar empate"]]}
          hint={(settings.tiebreak ?? "sudden") === "sudden"
            ? "Empate no 1º lugar: uma música extra no modo clássico só para os empatados. Quem acertar a música primeiro vence; quem errar está fora."
            : "Empate no 1º lugar: os times empatados dividem o 1º lugar."} />
        <Option title="Filtro de versões" value={settings.versionFilter !== false} onChange={(v) => update({ versionFilter: v })}
          options={[[true, "Ligado"], [false, "Desligado"]]}
          hint={settings.versionFilter !== false
            ? "Descarta ao vivo, acústico, remix, karaokê, instrumental, cover, regravações e coletâneas."
            : "Vale qualquer versão que estiver nas fontes."} />
        <Option title="Tema visual" value={settings.theme ?? "party"} onChange={(v) => update({ theme: v })}
          options={[["party", "🎉 Festa"], ["neon", "💜 Neon"], ["retro", "🕹️ Retrô 80"], ["beach", "🏖️ Praia"], ["xmas", "🎄 Natal"]]}
          hint="Fundo da TV e dos celulares." />
        <Option title="Efeitos sonoros" value={settings.sounds} onChange={(v) => update({ sounds: v })}
          options={[[true, "Ligados"], [false, "Desligados"]]} />
        {settings.sounds && (
          <Option title="Volume dos efeitos" value={settings.sfxVolume ?? "high"} onChange={(v) => update({ sfxVolume: v })}
            options={[["low", "Baixo"], ["medium", "Médio"], ["high", "Alto"]]}
            hint="Separado do volume da música." />
        )}
        <Card className="flex flex-col gap-3 md:col-span-2">
          <h2 className="font-display text-xl font-semibold">Times</h2>
          <div className="flex flex-wrap items-center gap-4">
            <Segmented
              value={settings.teamMode}
              options={[["teams", "Em times"], ["solo", "Cada um por si"]]}
              onChange={(v) => update({ teamMode: v })}
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
        <Button className="text-2xl px-10 py-4" onClick={onDone}>Pronto! Montar times →</Button>
      </div>
    </div>
  );
}

function Option<T extends string | number | boolean>({
  title,
  tag,
  value,
  options,
  onChange,
  hint,
}: {
  title: string;
  tag?: string;
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
  hint?: string;
}) {
  return (
    <Card className="flex flex-col gap-3">
      <h2 className="flex flex-wrap items-center gap-2 font-display text-xl font-semibold">
        {title}
        {tag && <span className="rounded-full bg-white/10 px-2 py-0.5 font-sans text-xs font-normal text-white/60">{tag}</span>}
      </h2>
      <Segmented value={value} options={options} onChange={onChange} />
      {hint && <p className="text-sm text-white/60">{hint}</p>}
    </Card>
  );
}

export function Segmented<T extends string | number | boolean>({
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
  const [results, setResults] = useState<{ id: string; name: string; picture: string | null; fans: number }[]>([]);
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
                onAdd({ type: "artist", id: a.id, label: a.name, picture: a.picture, level: "known" });
                setQ("");
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- miniatura do Deezer */}
              {a.picture && <img src={a.picture} alt="" className="h-8 w-8 rounded-full" />}
              <span className="flex-1">{a.name}</span>
              {/* homônimos: a foto e o nº de fãs ajudam a achar o artista certo */}
              <span className="text-xs text-white/50">{fansLabel(a.fans)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
