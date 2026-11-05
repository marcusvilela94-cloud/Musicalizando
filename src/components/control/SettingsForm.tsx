"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, Card } from "@/components/ui";
import { api, deezer } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import type { ArtistLevel, ModeId, MusicSource, RoomSettings, RoomState, SfxVolume } from "@/lib/types";
import { getMode } from "@/modes";
import { MODE_LIST, TURN_MODES, enabledModes, playingTeamCount, turnRounds, type ModeOrder } from "@/modes/schedule";

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
  quiz_open:
    "Pergunta sem alternativas (ano, álbum, quem canta, capa, complete o título, curiosidade…) com a prévia tocando ao fundo. Quem souber aperta EU SEI! e responde. Vale 100 (no ano digitado, errar por 1 vale 50).",
  quiz_choice:
    "Estilo Kahoot: pergunta e alternativas na TV; todos os times respondem ao mesmo tempo pelo celular, no Tempo de resposta. Acerto vale de 100 (na hora) a 50 (no fim do prazo).",
};

const ORDER_HINTS: Record<ModeOrder, string> = {
  alternate: "Os modos se revezam em ordem fixa, com o mesmo número de músicas para cada um.",
  random: "Cada rodada sorteia um dos modos ligados.",
  blocks: "Primeiro todas as rodadas do 1º modo da lista, depois as do 2º… dividindo as músicas igualmente.",
};

/** Em quais modos cada opção vale (para esconder ou etiquetar). Opções fora daqui valem para todos. */
const APPLIES = {
  clips: ["classic"] as ModeId[], // Trechos
  scoring: ["classic", "lyrics"] as ModeId[], // O que vale
  turns: TURN_MODES, // Formato da vez: classic, lyrics, continue, quiz_open
  buzzRules: ["classic", "lyrics", "continue", "quiz_open"] as ModeId[], // Bloqueio e Penalidade (só "Quem sabe primeiro")
  curiosities: ["quiz_open", "quiz_choice"] as ModeId[], // Perguntas de curiosidade
};

/** Predefinições: só mexem nas regras (não em modos, fontes, músicas, times, tema nem som). */
type PresetId = "casual" | "competitive" | "turns";
type Preset = { id: PresetId; emoji: string; title: string; text: string; values: Partial<RoomSettings> };
const PRESETS: Preset[] = [
  {
    id: "casual",
    emoji: "🍿",
    title: "Casual",
    text: "Quem sabe primeiro · 30s · bloqueio 10s · sem penalidade · aceita empate",
    values: { turnFormat: "buzz", answerSeconds: 30, lockSeconds: 10, penalty: 0, tiebreak: "accept" },
  },
  {
    id: "competitive",
    emoji: "🏆",
    title: "Competitivo",
    text: "Quem sabe primeiro · 20s · bloqueio 15s · penalidade −20 · morte súbita",
    values: { turnFormat: "buzz", answerSeconds: 20, lockSeconds: 15, penalty: 20, tiebreak: "sudden" },
  },
  {
    id: "turns",
    emoji: "🔄",
    title: "Um time por vez",
    text: "Rodízio, passa a vez se errar · 30s · sem penalidade · morte súbita",
    values: { turnFormat: "turns", passOnWrong: true, answerSeconds: 30, penalty: 0, tiebreak: "sudden" },
  },
];
/** A configuração ainda bate com a predefinição? (com os padrões dos campos opcionais) */
const matchesPreset = (s: RoomSettings, p: Preset) => {
  const e: Record<string, unknown> = {
    ...s,
    turnFormat: s.turnFormat ?? "buzz",
    passOnWrong: s.passOnWrong !== false,
    tiebreak: s.tiebreak ?? "sudden",
  };
  return Object.entries(p.values).every(([k, v]) => e[k] === v);
};

/** "Efeitos sonoros" + "Volume dos efeitos" numa opção só. */
type SoundLevel = "off" | SfxVolume;

/**
 * Configuração da partida. Aparece na TV (estilo "Todos jogam") ou no
 * celular do apresentador (estilo "Com apresentador").
 */
export function SettingsForm({ state, code, token, onDone }: { state: RoomState; code: string; token: string; onDone: () => void }) {
  const [settings, setSettings] = useState<RoomSettings>(state.room.settings);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [picked, setPicked] = useState<PresetId | null>(() => PRESETS.find((p) => matchesPreset(state.room.settings, p))?.id ?? null);
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
  const applyPreset = (p: Preset) => {
    setPicked(p.id);
    update(p.values);
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
  // opção aparece se vale para algum modo ligado (senão fica escondida, sem perder o valor);
  // etiqueta "só no …" quando vale só para alguns dos ligados
  const applies = (modes: ModeId[]) => on.some((m) => modes.includes(m));
  const tagFor = (modes: ModeId[]) => {
    const yes = on.filter((m) => modes.includes(m)).map((m) => getMode(m).label);
    if (!yes.length || yes.length === on.length) return undefined;
    return `só no ${yes.length > 1 ? `${yes.slice(0, -1).join(", no ")} e no ${yes[yes.length - 1]}` : yes[0]}`;
  };
  const turnFormat = settings.turnFormat ?? "buzz";
  const turns = turnFormat === "turns" && applies(APPLIES.turns);
  const show = {
    clips: applies(APPLIES.clips),
    scoring: applies(APPLIES.scoring),
    turns: applies(APPLIES.turns),
    // bloqueio e penalidade: só em "Quem sabe primeiro"
    buzzRules: applies(APPLIES.buzzRules) && turnFormat === "buzz",
    curiosities: applies(APPLIES.curiosities),
  };
  const tag = {
    clips: tagFor(APPLIES.clips),
    scoring: tagFor(APPLIES.scoring),
    turns: tagFor(APPLIES.turns),
    buzzRules: tagFor(APPLIES.buzzRules),
    curiosities: tagFor(APPLIES.curiosities),
  };
  // um time por vez: músicas arredondadas para o próximo múltiplo do número de times
  const teamsNow = settings.teamMode === "solo" ? playingTeamCount(state.teams, state.players) : settings.teamCount;
  const roundsAdj = turns ? turnRounds(settings.rounds, teamsNow) : settings.rounds;
  const sound: SoundLevel = settings.sounds ? (settings.sfxVolume ?? "high") : "off";
  const pickedPreset = PRESETS.find((p) => p.id === picked);
  const custom = !!pickedPreset && !matchesPreset(settings, pickedPreset);

  return (
    <div className="flex w-full flex-col gap-4 text-left">
      <div className="grid gap-3 md:grid-cols-3">
        {PRESETS.map((p) => {
          const active = picked === p.id;
          return (
            <button
              key={p.id}
              onClick={() => applyPreset(p)}
              className={`flex flex-col gap-1 rounded-3xl border-4 p-4 text-left transition ${
                active ? "border-yellow-300 bg-yellow-300 text-violet-950" : "border-white/15 bg-white/10 hover:border-yellow-300/60"
              }`}
            >
              <span className="flex flex-wrap items-center gap-2 font-display text-2xl font-bold">
                {p.emoji} {p.title}
                {active && custom && (
                  <span className="rounded-full bg-violet-950/15 px-2 py-0.5 font-sans text-xs font-normal">personalizado</span>
                )}
              </span>
              <span className={`text-sm ${active ? "text-violet-950/70" : "text-white/60"}`}>{p.text}</span>
            </button>
          );
        })}
      </div>

      <Card className="flex flex-col gap-3">
        <h2 className="font-display text-xl font-semibold">Modos de jogo</h2>
        <div className="grid gap-2 md:grid-cols-2">
          {MODE_LIST.map((m) => {
            const def = getMode(m);
            const active = on.includes(m);
            const last = active && on.length === 1;
            return (
              <div
                key={m}
                className={`flex items-center gap-2 rounded-2xl pr-3 transition ${active ? "bg-yellow-300 text-violet-950" : "bg-white/10 hover:bg-white/20"}`}
              >
                <button
                  onClick={() => toggleMode(m)}
                  disabled={last}
                  title={last ? "Pelo menos um modo precisa ficar ligado" : undefined}
                  className={`flex flex-1 items-center gap-3 px-4 py-3 text-left ${last ? "cursor-default" : ""}`}
                >
                  <span className="font-display text-2xl">{active ? "☑" : "☐"}</span>
                  <span className="font-display text-xl">{def.icon} {def.label}</span>
                </button>
                <Help text={MODE_HINTS[m]} dark={active} />
              </div>
            );
          })}
        </div>
        {on.length > 1 && (
          <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-black/20 p-3">
            <p className="font-display text-lg">Ordem dos modos</p>
            <Help text={ORDER_HINTS[order]} />
            <Segmented value={order} onChange={(v) => update({ modeOrder: v })}
              options={[["alternate", "Alternando"], ["random", "Sorteado"], ["blocks", "Em blocos"]]} />
          </div>
        )}
      </Card>

      <Card className="flex flex-col gap-4">
        <h2 className="font-display text-xl font-semibold">🎵 Fontes de músicas</h2>
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
          {roundsAdj !== settings.rounds && (
            <p className="rounded-xl bg-yellow-300/15 px-3 py-2 text-sm text-yellow-100">
              Um time por vez: {settings.rounds} → {roundsAdj} músicas para {teamsNow} {settings.teamMode === "solo" ? "jogadores" : "times"} (todos jogam o mesmo número de rodadas).
            </p>
          )}
        </Card>
        <Card className="flex flex-col gap-3">
          <h2 className="flex items-center gap-2 font-display text-xl font-semibold">
            Times <Help text="Times vazios ficam de fora quando a partida começa." />
          </h2>
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
        </Card>
      </div>

      <button
        onClick={() => setMore((v) => !v)}
        aria-expanded={more}
        className="flex items-center justify-between rounded-2xl bg-white/10 px-5 py-4 font-display text-xl transition hover:bg-white/20"
      >
        <span>⚙️ Mais opções</span>
        <span className="text-white/60">{more ? "▲" : "▼"}</span>
      </button>

      {more && (
        <>
          <Group title="Regras">
            {show.turns && (
              <Option title="Formato da vez" tag={tag.turns} value={turnFormat} onChange={(v) => update({ turnFormat: v })}
                options={[["buzz", "Quem sabe primeiro"], ["turns", "Um time por vez"]]}
                hint={turnFormat === "buzz"
                  ? "Quem apertar EU SEI! primeiro responde."
                  : "Cada rodada é de um time, em rodízio. Só ele responde (sem EU SEI!); o tempo de resposta começa quando o trecho/pista aparece."}>
                {turnFormat === "turns" && (
                  <div className="flex flex-col gap-2 rounded-2xl bg-black/20 p-3">
                    <p className="flex items-center gap-2 font-display text-lg">
                      Passa a vez se errar
                      <Help text={settings.passOnWrong !== false
                        ? "Errou ou o tempo acabou: a vez passa para o próximo time, valendo metade, até todos tentarem. A música continua de onde parou."
                        : "Errou ou o tempo acabou: a rodada termina e revela."} />
                    </p>
                    <Segmented value={settings.passOnWrong !== false} onChange={(v) => update({ passOnWrong: v })}
                      options={[[true, "Ligada"], [false, "Desligada"]]} />
                  </div>
                )}
              </Option>
            )}
            {host && (
              <Option title="Modo de resposta" value={settings.answerMode} onChange={(v) => update({ answerMode: v })}
                options={[["spoken", "Falada"], ["typed", "Digitada"]]}
                hint={settings.answerMode === "spoken" ? "O time fala em voz alta e o apresentador julga." : "O time digita no celular e o sistema confere."} />
            )}
            <Option title="Tempo de resposta" value={settings.answerSeconds} onChange={(v) => update({ answerSeconds: v })}
              options={[[10, "10s"], [20, "20s"], [30, "30s"], [0, "Sem limite"]]}
              hint={on.includes("quiz_choice")
                ? "Tempo do time para responder. No Quiz de alternativas é o prazo da pergunta; em “Sem limite”, ela fecha quando todos os times responderem."
                : "Tempo do time para responder."} />
            {show.buzzRules && (
              <Option title="Bloqueio após erro" tag={tag.buzzRules} value={settings.lockSeconds} onChange={(v) => update({ lockSeconds: v })}
                options={[[5, "5s"], [10, "10s"], [15, "15s"], [20, "20s"], [30, "30s"]]}
                hint="Quem erra fica bloqueado; a contagem só começa quando a música volta a tocar. Se outro time errar, quem estava bloqueado é liberado." />
            )}
            {show.buzzRules && (
              <Option title="Penalidade por erro" tag={tag.buzzRules} value={settings.penalty} onChange={(v) => update({ penalty: v })}
                options={[[0, "Desligada"], [20, "−20"], [50, "−50"]]}
                hint="Pontos perdidos por resposta errada." />
            )}
            <Option title="Desempate" value={settings.tiebreak ?? "sudden"} onChange={(v) => update({ tiebreak: v })}
              options={[["sudden", "Morte súbita"], ["accept", "Aceitar empate"]]}
              hint={(settings.tiebreak ?? "sudden") === "sudden"
                ? "Empate no 1º lugar: uma música extra no modo clássico só para os empatados. Quem acertar a música primeiro vence; quem errar está fora."
                : "Empate no 1º lugar: os times empatados dividem o 1º lugar."} />
          </Group>

          <Group title="Músicas">
            {show.clips && (
              <Option title="Trechos" tag={tag.clips} value={settings.clipMode ?? "sequence"} onChange={(v) => update({ clipMode: v })}
                options={[["sequence", "Em sequência"], ["alternate", "Alternando"]]}
                hint={(settings.clipMode ?? "sequence") === "sequence"
                  ? "Todos os trechos começam do início da prévia e vão crescendo: 1s, 2s, 4s, 8s, 15s, 30s."
                  : "Cada trecho começa num ponto sorteado diferente da prévia; o último toca a prévia inteira."} />
            )}
            {show.scoring && (
              <Option title="O que vale" tag={tag.scoring} value={settings.scoring} onChange={(v) => update({ scoring: v })}
                options={[["artist_title", "Artista e música"], ["title", "Só a música"]]}
                hint={settings.scoring === "artist_title"
                  ? "Artista vale 50% dos pontos, música 100%, as duas juntas 150%."
                  : "Só o nome da música vale pontos."} />
            )}
            <Option title="Filtro de versões" value={settings.versionFilter !== false} onChange={(v) => update({ versionFilter: v })}
              options={[[true, "Ligado"], [false, "Desligado"]]}
              hint={settings.versionFilter !== false
                ? "Descarta ao vivo, acústico, remix, karaokê, instrumental, cover, regravações e coletâneas."
                : "Vale qualquer versão que estiver nas fontes."} />
            {show.curiosities && (
              <Option title="Perguntas de curiosidade" tag={tag.curiosities} value={settings.curiosities !== false} onChange={(v) => update({ curiosities: v })}
                options={[[true, "Ligadas"], [false, "Desligadas"]]}
                hint={settings.curiosities !== false
                  ? "Cerca de 1 a cada 4 perguntas é uma curiosidade sobre artistas e bandas (de preferência os das suas fontes)."
                  : "Só perguntas sobre as músicas sorteadas."} />
            )}
          </Group>

          <Group title="Aparência e som">
            <Option title="Tema visual" value={settings.theme ?? "party"} onChange={(v) => update({ theme: v })}
              options={[["party", "🎉 Festa"], ["neon", "💜 Neon"], ["retro", "🕹️ Retrô 80"], ["beach", "🏖️ Praia"], ["xmas", "🎄 Natal"]]}
              hint="Fundo da TV e dos celulares." />
            <Option<SoundLevel> title="Efeitos sonoros" value={sound}
              onChange={(v) => update(v === "off" ? { sounds: false } : { sounds: true, sfxVolume: v })}
              options={[["off", "Desligados"], ["low", "Baixo"], ["medium", "Médio"], ["high", "Alto"]]}
              hint="Sons de acerto, erro e contagem na TV. Separado do volume da música." />
          </Group>
        </>
      )}

      {error && <p className="text-rose-300 text-lg">{error}</p>}
      <div className="flex justify-end">
        <Button className="text-2xl px-10 py-4" onClick={onDone}>Pronto! Montar times →</Button>
      </div>
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-display text-2xl font-semibold text-yellow-300">{title}</h2>
      <div className="grid gap-4 md:grid-cols-2">{children}</div>
    </section>
  );
}

/** Ícone "?" que mostra a explicação ao tocar (no lugar dos parágrafos). */
function Help({ text, dark = false }: { text: string; dark?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  return (
    <span ref={ref} className="relative inline-flex">
      <button
        type="button"
        aria-label="Explicação"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full font-sans text-sm font-bold transition ${
          dark ? "bg-violet-950/15 text-violet-950 hover:bg-violet-950/25" : "bg-white/15 text-white/80 hover:bg-white/25"
        }`}
      >
        ?
      </button>
      {open && (
        <span
          role="tooltip"
          className="absolute right-0 top-9 z-20 w-72 max-w-[80vw] rounded-2xl bg-violet-950 p-3 text-left font-sans text-sm font-normal leading-snug text-white shadow-xl ring-1 ring-white/20"
        >
          {text}
        </span>
      )}
    </span>
  );
}

function Option<T extends string | number | boolean>({
  title,
  tag,
  value,
  options,
  onChange,
  hint,
  children,
}: {
  title: string;
  tag?: string;
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
  hint?: string;
  children?: ReactNode;
}) {
  return (
    <Card className="flex flex-col gap-3">
      <h2 className="flex flex-wrap items-center gap-2 font-display text-xl font-semibold">
        {title}
        {hint && <Help text={hint} />}
        {tag && <span className="rounded-full bg-white/10 px-2 py-0.5 font-sans text-xs font-normal text-white/60">{tag}</span>}
      </h2>
      <Segmented value={value} options={options} onChange={onChange} />
      {children}
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
