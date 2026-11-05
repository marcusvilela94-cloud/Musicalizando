import "server-only";
import { timingSafeEqual } from "node:crypto";

/**
 * Biblioteca (/biblioteca): senha em BIBLIOTECA_PASSWORD e a chave
 * SUPABASE_SERVICE_ROLE_KEY, as duas só nas variáveis da Vercel (nunca no
 * navegador). As RPCs npl_lib_* não são liberadas para a chave pública.
 */
export function bibliotecaDenied(request: Request): Response | null {
  const expected = process.env.BIBLIOTECA_PASSWORD;
  if (!expected) return Response.json({ error: "Biblioteca desligada: defina BIBLIOTECA_PASSWORD na Vercel." }, { status: 503 });
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY)
    return Response.json({ error: "Falta a variável SUPABASE_SERVICE_ROLE_KEY na Vercel." }, { status: 503 });
  const got = request.headers.get("x-biblioteca-password") ?? "";
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return Response.json({ error: "Senha errada" }, { status: 401 });
  return null;
}

const BUCKET = "npl_stems";

function headers(extra: Record<string, string> = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const h: Record<string, string> = { apikey: key, "Content-Type": "application/json", ...extra };
  // chave antiga (JWT "eyJ…") vai também no Authorization; a nova (sb_secret_…) só no apikey
  if (key.startsWith("eyJ")) h.Authorization = `Bearer ${key}`;
  return h;
}

function base() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) throw new Error("Configure NEXT_PUBLIC_SUPABASE_URL");
  return url.replace(/\/$/, "");
}

/** RPC com a service_role (só nas rotas da biblioteca). */
export async function adminRpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`${base()}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(args),
    cache: "no-store",
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 300);
    try {
      msg = (JSON.parse(text) as { message?: string }).message ?? msg;
    } catch {}
    throw new Error(msg);
  }
  return (text ? JSON.parse(text) : null) as T;
}

/** Apaga arquivos do bucket das faixas (em lotes). Devolve quantos não deu para apagar. */
export async function removeStemFiles(paths: string[]): Promise<number> {
  const list = [...new Set(paths.filter((p) => typeof p === "string" && /^[\w-]+\/[\w-]+\.mp3$/.test(p)))];
  let failed = 0;
  for (let i = 0; i < list.length; i += 200) {
    const part = list.slice(i, i + 200);
    const res = await fetch(`${base()}/storage/v1/object/${BUCKET}`, {
      method: "DELETE",
      headers: headers(),
      body: JSON.stringify({ prefixes: part }),
      cache: "no-store",
      signal: AbortSignal.timeout(30000),
    }).catch(() => null);
    if (!res?.ok) failed += part.length;
  }
  return failed;
}

/** Envia uma faixa (MP3) para o bucket das faixas (com a service_role). */
export async function uploadStemFile(path: string, data: ArrayBuffer): Promise<void> {
  const res = await fetch(`${base()}/storage/v1/object/${BUCKET}/${path}`, {
    method: "POST",
    headers: headers({ "Content-Type": "audio/mpeg", "x-upsert": "true", "cache-control": "31536000" }),
    body: data,
    cache: "no-store",
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Storage (envio de ${path}): ${res.status} ${(await res.text()).slice(0, 200)}`);
}

/** Rotas dos separadores: Authorization: Bearer SEPARADOR_TOKEN. */
export function separadorDenied(request: Request): Response | null {
  const expected = process.env.SEPARADOR_TOKEN;
  if (!expected || !process.env.SUPABASE_SERVICE_ROLE_KEY)
    return Response.json({ error: "Separadores desligados: defina SEPARADOR_TOKEN e SUPABASE_SERVICE_ROLE_KEY na Vercel." }, { status: 503 });
  const got = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return Response.json({ error: "Token do separador inválido" }, { status: 401 });
  return null;
}
