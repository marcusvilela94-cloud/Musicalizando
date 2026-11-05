"use client";
// Biblioteca das músicas preparadas (cache do modo Instrumentos).
// Tudo passa por /api/biblioteca (senha + service_role no servidor).
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Button, Card, Logo, Spinner } from "@/components/ui";
import { deezer } from "@/lib/api";
import type { LibraryData, LibrarySong, SourceRef, StemName } from "@/lib/types";
import { STEM_EMOJI, STEM_LABEL, STEM_ORDER, stemUrl } from "@/modes/stems/logic";

const PWD_KEY = "npl_biblioteca_pwd";
const MB = 1048576;
const KIND: Record<SourceRef["type"], string> = {
  artist: "Artista",
  preset: "Pronta",
  playlist: "Playlist",
  cache: "Preparadas",
  collection: "Coleção",
};

class AuthError extends Error {}

async function libFetch<T>(pwd: string, init?: { action: string } & Record<string, unknown>): Promise<T> {
  const res = await fetch("/api/biblioteca", {
    method: init ? "POST" : "GET",
    headers: { "Content-Type": "application/json", "x-biblioteca-password": pwd },
    body: init ? JSON.stringify(init) : undefined,
    cache: "no-store",
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401) throw new AuthError(json.error ?? "Senha errada");
  if (!res.ok) throw new Error(json.error ?? `Erro ${res.status}`);
  return json as T;
}

const fmtMb = (b: number) => (b / MB < 10 ? (b / MB).toFixed(1) : (b / MB).toFixed(0));
const fmtDate = (s: string) => new Date(s).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit" });
function ago(s: string) {
  const d = (Date.now() - new Date(s).getTime()) / 1000;
  if (d < 3600) return "agora há pouco";
  if (d < 86400) return `há ${Math.floor(d / 3600)} h`;
  const days = Math.floor(d / 86400);
  return days === 1 ? "ontem" : days < 60 ? `há ${days} dias` : `em ${fmtDate(s)}`;
}
const sourceKey = (s: SourceRef | null) => (s ? `${s.type}:${s.id}` : "none");
const titleOf = (s: { deezer_id: number; meta: LibrarySong["meta"] }) => s.meta?.title ?? `Música ${s.deezer_id}`;
const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

export function LibraryApp() {
  const [pwd, setPwd] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- senha guardada neste navegador
    setPwd(localStorage.getItem(PWD_KEY));
    setChecked(true);
  }, []);
  if (!checked) return <Center><Spinner /></Center>;
  if (!pwd)
    return (
      <PasswordGate
        onOk={(p) => {
          localStorage.setItem(PWD_KEY, p);
          setPwd(p);
        }}
      />
    );
  return (
    <Library
      pwd={pwd}
      onLogout={() => {
        localStorage.removeItem(PWD_KEY);
        setPwd(null);
      }}
    />
  );
}

function Center({ children }: { children: ReactNode }) {
  return <main className="flex flex-1 flex-col items-center justify-center gap-6 p-6 text-center">{children}</main>;
}

function PasswordGate({ onOk }: { onOk: (pwd: string) => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await libFetch(value);
      onOk(value);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Center>
      <Logo className="text-5xl" />
      <h1 className="font-display text-3xl">📚 Biblioteca</h1>
      <form
        className="flex w-full max-w-sm flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <input
          type="password"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Senha da biblioteca"
          className="rounded-2xl bg-white/90 px-4 py-3 text-lg text-violet-950 outline-none"
        />
        <Button type="submit" disabled={busy || !value}>{busy ? "Entrando…" : "Entrar"}</Button>
        {error && <p className="text-rose-300">{error}</p>}
        <p className="text-sm text-white/50">A senha fica guardada neste navegador.</p>
      </form>
      <Link href="/tv" className="text-white/60 underline">← Voltar ao jogo</Link>
    </Center>
  );
}

type Filter = { q: string; source: string; collection: string; pinned: boolean };

function Library({ pwd, onLogout }: { pwd: string; onLogout: () => void }) {
  const [data, setData] = useState<LibraryData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [open, setOpen] = useState<number | null>(null);
  const [filter, setFilter] = useState<Filter>({ q: "", source: "", collection: "", pinned: false });
  const [showBlocked, setShowBlocked] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await libFetch<LibraryData>(pwd);
      setData(d);
      setError(null);
      // tira da seleção as que não existem mais
      setSel((s) => new Set([...s].filter((id) => d.songs.some((x) => x.deezer_id === id))));
    } catch (e) {
      if (e instanceof AuthError) onLogout();
      else setError((e as Error).message);
    }
  }, [pwd, onLogout]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- primeira carga
    void load();
    const t = setInterval(() => void load(), 60000);
    return () => clearInterval(t);
  }, [load]);

  const act = async (body: { action: string } & Record<string, unknown>, done?: (r: Record<string, unknown>) => string) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await libFetch<Record<string, unknown>>(pwd, body);
      const failed = Number(r.filesFailed ?? 0);
      setMsg(
        (done ? done(r) : "Pronto.") + (failed ? ` (${failed} arquivo${failed === 1 ? "" : "s"} não saíram do Storage; tente de novo mais tarde)` : ""),
      );
      await load();
      return true;
    } catch (e) {
      if (e instanceof AuthError) onLogout();
      setMsg(`❌ ${(e as Error).message}`);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const songs = useMemo(() => {
    if (!data) return [];
    const q = fold(filter.q.trim());
    return data.songs.filter(
      (s) =>
        (!q || fold(`${s.meta?.title ?? ""} ${s.meta?.artist ?? ""} ${s.meta?.album ?? ""}`).includes(q)) &&
        (!filter.source || sourceKey(s.source) === filter.source) &&
        (!filter.collection ||
          (filter.collection === "none" ? s.collections.length === 0 : s.collections.includes(filter.collection))) &&
        (!filter.pinned || s.pinned),
    );
  }, [data, filter]);

  const sources = useMemo(() => {
    const m = new Map<string, { label: string; n: number }>();
    for (const s of data?.songs ?? []) {
      const k = sourceKey(s.source);
      const label = s.source ? `${KIND[s.source.type] ?? s.source.type}: ${s.source.label}` : "Sem origem registrada";
      m.set(k, { label, n: (m.get(k)?.n ?? 0) + 1 });
    }
    return [...m.entries()].sort((a, b) => a[1].label.localeCompare(b[1].label));
  }, [data]);

  if (!data)
    return (
      <Center>
        {error ? (
          <>
            <p className="text-xl text-rose-300">{error}</p>
            <Button onClick={() => void load()}>Tentar de novo</Button>
          </>
        ) : (
          <Spinner label="Abrindo a biblioteca…" />
        )}
      </Center>
    );

  const ids = [...sel];
  const plural = (n: number, a: string, b: string) => `${n} ${n === 1 ? a : b}`;
  const colName = (id: string) => data.collections.find((c) => c.id === id)?.name ?? "?";
  const allShown = songs.length > 0 && songs.every((s) => sel.has(s.deezer_id));

  return (
    <main
      className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4 md:p-6"
      // uma faixa tocando por vez
      onPlayCapture={(e) => {
        document.querySelectorAll("audio").forEach((a) => a !== e.target && a.pause());
      }}
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link href="/tv"><Logo className="text-3xl" /></Link>
          <h1 className="font-display text-3xl">📚 Biblioteca</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={() => void load()} disabled={busy}>↻ Atualizar</Button>
          <Button variant="ghost" onClick={onLogout}>Sair</Button>
        </div>
      </header>

      <UsageCard data={data} busy={busy} onLimit={(mb) => act({ action: "limit", mb }, (r) =>
        `Limite: ${r.limit_mb} MB.${Number(r.evicted) ? ` ${plural(Number(r.evicted), "música usada há mais tempo saiu", "músicas usadas há mais tempo saíram")} para caber.` : ""}`)} />

      <CollectionsCard
        data={data}
        busy={busy}
        active={filter.collection}
        onPick={(id) => setFilter((f) => ({ ...f, collection: f.collection === id ? "" : id }))}
        onCreate={(name) => act({ action: "collection_create", name }, () => `Coleção “${name.trim()}” criada.`)}
        onRename={(id, name) => act({ action: "collection_rename", collection: id, name }, () => "Coleção renomeada.")}
        onDelete={(id) => act({ action: "collection_delete", collection: id }, () => "Coleção apagada (as músicas continuam na biblioteca).").then((ok) => {
          if (ok) setFilter((f) => (f.collection === id ? { ...f, collection: "" } : f));
        })}
      />

      <Card className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={filter.q}
            onChange={(e) => setFilter((f) => ({ ...f, q: e.target.value }))}
            placeholder="🔎 Buscar música, artista ou álbum"
            className="min-w-56 flex-1 rounded-2xl bg-white/90 px-4 py-2 text-violet-950 outline-none"
          />
          <select
            value={filter.source}
            onChange={(e) => setFilter((f) => ({ ...f, source: e.target.value }))}
            className="rounded-2xl bg-white/90 px-3 py-2 text-violet-950 outline-none"
          >
            <option value="">Todas as fontes</option>
            {sources.map(([k, v]) => (
              <option key={k} value={k}>{v.label} ({v.n})</option>
            ))}
          </select>
          <select
            value={filter.collection}
            onChange={(e) => setFilter((f) => ({ ...f, collection: e.target.value }))}
            className="rounded-2xl bg-white/90 px-3 py-2 text-violet-950 outline-none"
          >
            <option value="">Todas as coleções</option>
            <option value="none">Sem coleção</option>
            {data.collections.map((c) => (
              <option key={c.id} value={c.id}>{c.name} ({c.songs})</option>
            ))}
          </select>
          <button
            onClick={() => setFilter((f) => ({ ...f, pinned: !f.pinned }))}
            className={`rounded-2xl px-3 py-2 ${filter.pinned ? "bg-yellow-300 text-violet-950" : "bg-white/10 hover:bg-white/20"}`}
          >
            📌 Só fixadas
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <label className="flex cursor-pointer items-center gap-2 rounded-xl bg-white/10 px-3 py-1.5">
            <input
              type="checkbox"
              checked={allShown}
              onChange={() =>
                setSel((s) => {
                  const n = new Set(s);
                  songs.forEach((x) => (allShown ? n.delete(x.deezer_id) : n.add(x.deezer_id)));
                  return n;
                })
              }
            />
            Selecionar as {songs.length} mostradas
          </label>
          <span className="text-white/60">
            {plural(songs.length, "música", "músicas")}
            {songs.length !== data.songs.length && ` de ${data.songs.length}`}
          </span>
        </div>
        {sel.size > 0 && (
          <BulkBar
            n={sel.size}
            busy={busy}
            collections={data.collections}
            currentCollection={filter.collection && filter.collection !== "none" ? filter.collection : null}
            onClear={() => setSel(new Set())}
            onAction={(action, extra) =>
              act({ action, ids, ...extra }, () => {
                const n = plural(ids.length, "música", "músicas");
                if (action === "remove") return `${n} removida${ids.length === 1 ? "" : "s"}.`;
                if (action === "block") return `${n} bloqueada${ids.length === 1 ? "" : "s"}.`;
                if (action === "pin") return `${n} fixada${ids.length === 1 ? "" : "s"}.`;
                if (action === "unpin") return `${n} desafixada${ids.length === 1 ? "" : "s"}.`;
                if (action === "collection_add") return `${n} em “${colName(String(extra?.collection))}”.`;
                return `${n} fora de “${colName(String(extra?.collection))}”.`;
              }).then((ok) => {
                if (ok && (action === "remove" || action === "block")) setSel(new Set());
              })
            }
          />
        )}
        {msg && <p className="text-sm text-white/85">{msg}</p>}
        {error && <p className="text-sm text-rose-300">{error}</p>}
      </Card>

      {data.songs.length === 0 ? (
        <Card className="text-center text-white/70">
          Nenhuma música preparada ainda. No modo Instrumentos, use “Preparar instrumentos destas fontes”.
        </Card>
      ) : songs.length === 0 ? (
        <Card className="text-center text-white/70">Nenhuma música com esses filtros.</Card>
      ) : (
        <ul className="flex flex-col gap-2">
          {songs.map((s) => (
            <SongRow
              key={s.deezer_id}
              s={s}
              busy={busy}
              selected={sel.has(s.deezer_id)}
              open={open === s.deezer_id}
              colName={colName}
              onToggle={() =>
                setSel((x) => {
                  const n = new Set(x);
                  if (n.has(s.deezer_id)) n.delete(s.deezer_id);
                  else n.add(s.deezer_id);
                  return n;
                })
              }
              onOpen={() => setOpen((o) => (o === s.deezer_id ? null : s.deezer_id))}
              onAction={(action) =>
                act({ action, ids: [s.deezer_id] }, () => {
                  const t = `“${titleOf(s)}”`;
                  return action === "remove" ? `${t} removida.` : action === "block" ? `${t} bloqueada.` : action === "pin" ? `${t} fixada.` : `${t} desafixada.`;
                })
              }
            />
          ))}
        </ul>
      )}

      <Card className="flex flex-col gap-3">
        <button className="flex items-center justify-between font-display text-xl" onClick={() => setShowBlocked((v) => !v)}>
          <span>🚫 Bloqueadas ({data.blocked.length})</span>
          <span className="text-white/60">{showBlocked ? "▲" : "▼"}</span>
        </button>
        {showBlocked &&
          (data.blocked.length === 0 ? (
            <p className="text-white/60">Nenhuma música bloqueada.</p>
          ) : (
            <>
              <p className="text-sm text-white/60">Não são mais preparadas nem tocam no modo Instrumentos. Desbloquear não traz as faixas de volta: é preciso preparar de novo.</p>
              <ul className="flex flex-col gap-2">
                {data.blocked.map((b) => (
                  <li key={b.deezer_id} className="flex flex-wrap items-center gap-3 rounded-2xl bg-black/20 p-2">
                    <Cover src={b.meta?.cover} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-display text-lg">{titleOf(b)}</p>
                      <p className="truncate text-sm text-white/60">
                        {b.meta?.artist ?? "?"} · bloqueada em {fmtDate(b.blocked_at)}
                        {b.source && ` · ${KIND[b.source.type] ?? ""}: ${b.source.label}`}
                      </p>
                    </div>
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={() => act({ action: "unblock", ids: [b.deezer_id] }, () => `“${titleOf(b)}” desbloqueada.`)}
                    >
                      Desbloquear
                    </Button>
                  </li>
                ))}
              </ul>
            </>
          ))}
      </Card>
      <p className="pb-6 text-center text-sm text-white/40">
        <Link href="/tv" className="underline">← Voltar ao jogo</Link>
      </p>
    </main>
  );
}

function UsageCard({ data, busy, onLimit }: { data: LibraryData; busy: boolean; onLimit: (mb: number) => void }) {
  const u = data.usage;
  const limitMb = Math.round(u.limit_bytes / MB);
  const [edit, setEdit] = useState(false);
  const [value, setValue] = useState(String(limitMb));
  const pct = u.limit_bytes ? Math.min(100, (u.bytes / u.limit_bytes) * 100) : 0;
  const pinPct = u.limit_bytes ? Math.min(100, (u.pinned_bytes / u.limit_bytes) * 100) : 0;
  const v = Number(value);
  const valid = Number.isFinite(v) && v >= 20 && v <= 500;
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="font-display text-2xl">
          💾 {fmtMb(u.bytes)} de {limitMb} MB
          <span className="ml-2 font-sans text-base text-white/60">
            · {u.songs} música{u.songs === 1 ? "" : "s"}
            {u.pinned > 0 && ` · 📌 ${u.pinned} fixada${u.pinned === 1 ? "" : "s"} (${fmtMb(u.pinned_bytes)} MB)`}
          </span>
        </p>
        {edit ? (
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!valid) return;
              onLimit(Math.round(v));
              setEdit(false);
            }}
          >
            <input
              type="number"
              min={20}
              max={500}
              step={10}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="w-24 rounded-xl bg-white/90 px-3 py-2 text-violet-950 outline-none"
            />
            <span>MB</span>
            <Button type="submit" disabled={busy || !valid}>Salvar</Button>
            <Button type="button" variant="ghost" onClick={() => setEdit(false)}>Cancelar</Button>
          </form>
        ) : (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => {
              setValue(String(limitMb));
              setEdit(true);
            }}
          >
            Alterar limite
          </Button>
        )}
      </div>
      <div className="relative h-4 w-full overflow-hidden rounded-full bg-white/15">
        <div className="absolute inset-y-0 left-0 rounded-full bg-yellow-300" style={{ width: `${pct}%` }} />
        <div className="absolute inset-y-0 left-0 rounded-full bg-pink-400" style={{ width: `${pinPct}%` }} title="Fixadas" />
      </div>
      {edit && <p className="text-sm text-white/60">De 20 a 500 MB. Se o novo limite for menor que o usado, as músicas não fixadas usadas há mais tempo saem na hora.</p>}
      {u.full ? (
        <p className="rounded-xl bg-rose-500/25 px-3 py-2 text-rose-100">
          ⚠️ As músicas fixadas ocupam o limite inteiro: o separador não prepara músicas novas até você liberar espaço (desafixe ou remova algumas, ou aumente o limite).
        </p>
      ) : (
        <p className="text-sm text-white/50">Quando passa do limite, as músicas usadas há mais tempo saem sozinhas — menos as 📌 fixadas.</p>
      )}
    </Card>
  );
}

function CollectionsCard({
  data,
  busy,
  active,
  onPick,
  onCreate,
  onRename,
  onDelete,
}: {
  data: LibraryData;
  busy: boolean;
  active: string;
  onPick: (id: string) => void;
  onCreate: (name: string) => Promise<boolean>;
  onRename: (id: string, name: string) => Promise<boolean>;
  onDelete: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-display text-xl">🗂️ Coleções</h2>
        <p className="text-sm text-white/50">Cada coleção aparece como fonte na configuração da sala (em qualquer modo).</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {data.collections.map((c) =>
          editing?.id === c.id ? (
            <form
              key={c.id}
              className="flex items-center gap-1 rounded-2xl bg-white/10 p-1"
              onSubmit={(e) => {
                e.preventDefault();
                void onRename(c.id, editing.name).then((ok) => ok && setEditing(null));
              }}
            >
              <input
                autoFocus
                value={editing.name}
                maxLength={60}
                onChange={(e) => setEditing({ id: c.id, name: e.target.value })}
                className="w-40 rounded-xl bg-white/90 px-2 py-1 text-violet-950 outline-none"
              />
              <Button type="submit" className="px-3 py-1" disabled={busy || !editing.name.trim()}>OK</Button>
              <Button type="button" variant="ghost" className="px-3 py-1" onClick={() => setEditing(null)}>✕</Button>
            </form>
          ) : (
            <span key={c.id} className={`inline-flex items-center gap-1 rounded-2xl py-1 pl-3 pr-1 ${active === c.id ? "bg-yellow-300 text-violet-950" : "bg-white/10"}`}>
              <button onClick={() => onPick(c.id)} className="font-display text-lg" title="Mostrar só esta coleção">
                {c.name} <span className="opacity-60">({c.songs})</span>
              </button>
              <button className="rounded-full px-2 py-1 hover:bg-black/20" title="Renomear" onClick={() => setEditing({ id: c.id, name: c.name })}>✏️</button>
              {confirm === c.id ? (
                <button
                  className="rounded-full bg-rose-500 px-2 py-1 text-sm text-white"
                  onClick={() => {
                    setConfirm(null);
                    onDelete(c.id);
                  }}
                >
                  Apagar?
                </button>
              ) : (
                <button className="rounded-full px-2 py-1 hover:bg-rose-500/60" title="Apagar a coleção" onClick={() => setConfirm(c.id)}>🗑️</button>
              )}
            </span>
          ),
        )}
        <form
          className="flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            void onCreate(name).then((ok) => ok && setName(""));
          }}
        >
          <input
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
            placeholder="Nova coleção (ex.: Rock)"
            className="w-52 rounded-xl bg-white/90 px-3 py-1.5 text-violet-950 outline-none"
          />
          <Button type="submit" variant="secondary" className="px-3 py-1.5" disabled={busy || !name.trim()}>+ Criar</Button>
        </form>
      </div>
    </Card>
  );
}

function BulkBar({
  n,
  busy,
  collections,
  currentCollection,
  onClear,
  onAction,
}: {
  n: number;
  busy: boolean;
  collections: LibraryData["collections"];
  currentCollection: string | null;
  onClear: () => void;
  onAction: (action: string, extra?: Record<string, unknown>) => void;
}) {
  const [confirm, setConfirm] = useState<"remove" | "block" | null>(null);
  const [target, setTarget] = useState("");
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-2xl border-2 border-yellow-300/60 bg-black/30 p-3">
      <span className="font-display text-lg">{n} selecionada{n === 1 ? "" : "s"}</span>
      <Button variant="secondary" className="px-3 py-1.5" disabled={busy} onClick={() => onAction("pin")}>📌 Fixar</Button>
      <Button variant="secondary" className="px-3 py-1.5" disabled={busy} onClick={() => onAction("unpin")}>Desafixar</Button>
      {collections.length > 0 && (
        <span className="flex items-center gap-1">
          <select value={target} onChange={(e) => setTarget(e.target.value)} className="rounded-xl bg-white/90 px-2 py-1.5 text-violet-950 outline-none">
            <option value="">Pôr na coleção…</option>
            {collections.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <Button
            variant="secondary"
            className="px-3 py-1.5"
            disabled={busy || !target}
            onClick={() => onAction("collection_add", { collection: target })}
          >
            Pôr
          </Button>
        </span>
      )}
      {currentCollection && (
        <Button variant="secondary" className="px-3 py-1.5" disabled={busy} onClick={() => onAction("collection_remove", { collection: currentCollection })}>
          Tirar desta coleção
        </Button>
      )}
      {confirm ? (
        <span className="flex items-center gap-1">
          <span className="text-sm">{confirm === "block" ? "Bloquear e apagar" : "Apagar"} {n}?</span>
          <Button variant="danger" className="px-3 py-1.5" disabled={busy} onClick={() => { setConfirm(null); onAction(confirm); }}>Sim</Button>
          <Button variant="ghost" className="px-3 py-1.5" onClick={() => setConfirm(null)}>Não</Button>
        </span>
      ) : (
        <>
          <Button variant="secondary" className="px-3 py-1.5" disabled={busy} onClick={() => setConfirm("remove")}>🗑️ Remover</Button>
          <Button variant="secondary" className="px-3 py-1.5" disabled={busy} onClick={() => setConfirm("block")}>🚫 Bloquear</Button>
        </>
      )}
      <Button variant="ghost" className="ml-auto px-3 py-1.5" onClick={onClear}>Limpar seleção</Button>
    </div>
  );
}

function Cover({ src }: { src?: string | null }) {
  return src ? (
    // eslint-disable-next-line @next/next/no-img-element -- capa do Deezer
    <img src={src} alt="" className="h-14 w-14 shrink-0 rounded-xl object-cover" />
  ) : (
    <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-black/30 text-2xl">🎵</span>
  );
}

function SongRow({
  s,
  busy,
  selected,
  open,
  colName,
  onToggle,
  onOpen,
  onAction,
}: {
  s: LibrarySong;
  busy: boolean;
  selected: boolean;
  open: boolean;
  colName: (id: string) => string;
  onToggle: () => void;
  onOpen: () => void;
  onAction: (action: "remove" | "block" | "pin" | "unpin") => void;
}) {
  const [confirm, setConfirm] = useState<"remove" | "block" | null>(null);
  return (
    <li className={`flex flex-col gap-2 rounded-2xl p-2 transition ${selected ? "bg-yellow-300/15 ring-2 ring-yellow-300/60" : "bg-white/10"}`}>
      <div className="flex flex-wrap items-center gap-3">
        <input type="checkbox" checked={selected} onChange={onToggle} className="h-5 w-5 accent-yellow-300" aria-label="Selecionar" />
        <Cover src={s.meta?.cover} />
        <button onClick={onOpen} className="min-w-0 flex-1 text-left">
          <p className="truncate font-display text-lg">
            {s.pinned && <span title="Fixada">📌 </span>}
            {titleOf(s)}
          </p>
          <p className="truncate text-sm text-white/70">{s.meta?.artist ?? "Sem dados (aparecem quando a música for usada como fonte)"}</p>
          <p className="flex flex-wrap items-center gap-x-2 text-xs text-white/50">
            <span>{fmtMb(s.bytes)} MB</span>
            <span>· preparada {fmtDate(s.created_at)}</span>
            <span>· usada {ago(s.last_used_at)}</span>
            <span>· {s.source ? `${KIND[s.source.type] ?? ""}: ${s.source.label}` : "origem desconhecida"}</span>
            <span className="flex gap-0.5" title="Faixas audíveis">
              ·
              {STEM_ORDER.map((n) => (
                <span key={n} className={s.audible[n] ? "" : "opacity-25 grayscale"} title={`${STEM_LABEL[n]}: ${s.audible[n] ? "audível" : "vazia"}`}>
                  {STEM_EMOJI[n]}
                </span>
              ))}
            </span>
          </p>
          {s.collections.length > 0 && (
            <p className="mt-1 flex flex-wrap gap-1">
              {s.collections.map((c) => (
                <span key={c} className="rounded-full bg-white/15 px-2 py-0.5 text-xs">{colName(c)}</span>
              ))}
            </p>
          )}
        </button>
        <div className="flex flex-wrap items-center gap-1">
          <Button variant="secondary" className="px-3 py-1.5" onClick={onOpen}>{open ? "▲ Fechar" : "▶ Ouvir"}</Button>
          <Button variant="secondary" className="px-3 py-1.5" disabled={busy} onClick={() => onAction(s.pinned ? "unpin" : "pin")}>
            {s.pinned ? "Desafixar" : "📌 Fixar"}
          </Button>
          {confirm ? (
            <>
              <Button variant="danger" className="px-3 py-1.5" disabled={busy} onClick={() => { setConfirm(null); onAction(confirm); }}>
                {confirm === "block" ? "Bloquear?" : "Remover?"}
              </Button>
              <Button variant="ghost" className="px-2 py-1.5" onClick={() => setConfirm(null)}>✕</Button>
            </>
          ) : (
            <>
              <Button variant="secondary" className="px-3 py-1.5" disabled={busy} onClick={() => setConfirm("remove")} title="Apaga as faixas (libera espaço)">Remover</Button>
              <Button variant="secondary" className="px-3 py-1.5" disabled={busy} onClick={() => setConfirm("block")} title="Remove e nunca mais prepara nem toca no modo Instrumentos">Bloquear</Button>
            </>
          )}
        </div>
      </div>
      {open && <Players s={s} />}
    </li>
  );
}

function Players({ s }: { s: LibrarySong }) {
  const [preview, setPreview] = useState<string | null | "loading" | "error">(null);
  useEffect(() => {
    let alive = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- busca a prévia atual (o link do Deezer expira)
    setPreview("loading");
    deezer
      .track(s.deezer_id)
      .then((t) => alive && setPreview(t.preview || "error"))
      .catch(() => alive && setPreview("error"));
    return () => {
      alive = false;
    };
  }, [s.deezer_id]);
  const names = STEM_ORDER.filter((n): n is StemName => !!s.paths[n]);
  return (
    <div className="grid gap-2 rounded-2xl bg-black/25 p-3 md:grid-cols-2">
      <div className="flex flex-col gap-1">
        <p className="text-sm text-white/70">🎧 Prévia original</p>
        {preview === "loading" ? (
          <p className="text-sm text-white/50">Buscando…</p>
        ) : preview === "error" || !preview ? (
          <p className="text-sm text-rose-300">Prévia indisponível no Deezer.</p>
        ) : (
          <audio controls preload="none" src={preview} className="w-full" />
        )}
      </div>
      {names.map((n) => (
        <div key={n} className="flex flex-col gap-1">
          <p className={`text-sm ${s.audible[n] ? "text-white/70" : "text-white/40"}`}>
            {STEM_EMOJI[n]} {STEM_LABEL[n]}
            {!s.audible[n] && " (vazia: não entra no jogo)"}
          </p>
          <audio controls preload="none" src={stemUrl(s.key, n)} className="w-full" />
        </div>
      ))}
    </div>
  );
}
