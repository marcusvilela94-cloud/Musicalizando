import { randomUUID } from "node:crypto";
import { adminRpc, removeStemFiles, separadorDenied, uploadStemFile } from "@/lib/bibliotecaServer";
import { cloudConfigured, wakeCloudSeparator } from "@/lib/cloudSeparator";
import { supabaseServer } from "@/lib/supabaseServer";

// Rotas dos separadores (PC e Hugging Face). Só elas usam a service_role.
// Autorização: Authorization: Bearer SEPARADOR_TOKEN.
//   POST /api/separador/claim      { worker }                 -> { job } (null = nada para fazer)
//   POST /api/separador/heartbeat  { worker, info }           -> { paused, full }
//   POST /api/separador/done       multipart: worker, deezer_id, audible, levels, limit_mb,
//                                  drums / bass / guitar / vocals (MP3)
//   POST /api/separador/fail       { worker, deezer_id, error }
// Sem token (quem pede é o dono da sala):
//   POST /api/separador/wake       { code, owner } -> acorda o separador da nuvem se nenhum estiver ligado

export const maxDuration = 60;
const STEMS = ["drums", "bass", "guitar", "vocals"] as const;
const MAX_FILE = 2 * 1024 * 1024;
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
const workerOf = (v: unknown) => (typeof v === "string" ? v.slice(0, 40) : null);

export async function POST(request: Request, ctx: RouteContext<"/api/separador/[action]">) {
  const { action } = await ctx.params;
  if (action === "wake") return wake(request);
  const denied = separadorDenied(request);
  if (denied) return denied;
  try {
    if (action === "done") return await done(request);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const p_worker = workerOf(body.worker);
    switch (action) {
      case "claim":
        return json({ job: await adminRpc("npl_stems_claim", { p_worker }) });
      case "heartbeat":
        return json(
          await adminRpc("npl_stems_heartbeat", {
            p_worker,
            p_info: body.info && typeof body.info === "object" ? body.info : {},
          }),
        );
      case "fail": {
        const id = Number(body.deezer_id);
        if (!Number.isSafeInteger(id) || id <= 0) return json({ error: "deezer_id inválido" }, 400);
        const ok = await adminRpc<boolean>("npl_stems_fail", { p_deezer_id: id, p_error: String(body.error ?? "erro").slice(0, 500), p_worker });
        return json({ ok });
      }
      default:
        return json({ error: "Ação desconhecida" }, 404);
    }
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }
}

async function done(request: Request) {
  const form = await request.formData();
  const id = Number(form.get("deezer_id"));
  if (!Number.isSafeInteger(id) || id <= 0) return json({ error: "deezer_id inválido" }, 400);
  const p_worker = workerOf(form.get("worker"));
  const parse = (k: string): Record<string, unknown> => {
    try {
      const v = JSON.parse(String(form.get(k) ?? "{}"));
      return v && typeof v === "object" ? v : {};
    } catch {
      return {};
    }
  };
  const files: { name: string; data: ArrayBuffer }[] = [];
  for (const name of STEMS) {
    const f = form.get(name);
    if (!(f instanceof Blob) || f.size === 0 || f.size > MAX_FILE) return json({ error: `Faixa ${name} ausente ou grande demais` }, 400);
    files.push({ name, data: await f.arrayBuffer() });
  }
  // a pasta é sorteada aqui (opaca: não revela a música)
  const key = randomUUID();
  const paths: Record<string, string> = {};
  let bytes = 0;
  try {
    for (const f of files) {
      const path = `${key}/${f.name}.mp3`;
      await uploadStemFile(path, f.data);
      paths[f.name] = path;
      bytes += f.data.byteLength;
    }
  } catch (e) {
    await removeStemFiles(Object.values(paths));
    throw e;
  }
  const audibleIn = parse("audible");
  const levelsIn = parse("levels");
  const audible = Object.fromEntries(STEMS.map((n) => [n, audibleIn[n] === true]));
  const levels = Object.fromEntries(
    Object.entries(levelsIn).filter(([k, v]) => /^[a-z]{1,10}$/.test(k) && typeof v === "number" && Number.isFinite(v)),
  );
  const r = await adminRpc<{ ok: boolean; reason?: string }>("npl_stems_done", {
    p_deezer_id: id,
    p_key: key,
    p_paths: paths,
    p_bytes: bytes,
    p_audible: audible,
    p_levels: levels,
    p_worker,
  });
  // bloqueada ou outro separador terminou antes: estes arquivos não servem
  if (!r.ok) await removeStemFiles(Object.values(paths));
  // limite do cache: apaga as usadas há mais tempo (menos as fixadas)
  const limitMb = Number(form.get("limit_mb"));
  const gone = await adminRpc<{ paths?: Record<string, string> }[]>("npl_stems_evict", {
    p_limit_bytes: Number.isFinite(limitMb) && limitMb > 0 ? Math.round(limitMb * 1048576) : null,
  }).catch(() => []);
  if (gone.length) await removeStemFiles(gone.flatMap((g) => Object.values(g.paths ?? {})));
  return json({ ok: r.ok, reason: r.reason ?? null, bytes, evicted: gone.length });
}

/** Acordar o separador da nuvem (o banco confere o dono da sala e limita a 1 vez a cada 90 s). */
async function wake(request: Request) {
  if (!cloudConfigured()) return json({ configured: false, woke: false });
  const body = (await request.json().catch(() => ({}))) as { code?: unknown; owner?: unknown };
  if (typeof body.code !== "string" || typeof body.owner !== "string") return json({ error: "Sala inválida" }, 400);
  const { data, error } = await supabaseServer().rpc("npl_stems_wake_mark", { p_code: body.code, p_owner_token: body.owner });
  if (error) return json({ error: error.message }, 403);
  if (!data) return json({ configured: true, woke: false });
  return json({ configured: true, woke: true, ...(await wakeCloudSeparator()) });
}
