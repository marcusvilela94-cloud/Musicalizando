import { adminRpc, bibliotecaDenied, removeStemFiles } from "@/lib/bibliotecaServer";
import { completeCacheMeta } from "@/lib/deezer";
import type { LibraryData } from "@/lib/types";

// Biblioteca das músicas preparadas (/biblioteca). Tudo protegido pela senha
// (cabeçalho x-biblioteca-password = BIBLIOTECA_PASSWORD) e feito com a
// service_role, que fica só aqui no servidor.
//   GET  -> músicas, coleções, bloqueadas e espaço usado
//   POST { action, ... } -> remove | block | unblock | pin | unpin |
//        collection_add | collection_remove | collection_create |
//        collection_rename | collection_delete | limit |
//        queue_pause | queue_resume | queue_clear

const NO_STORE = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const fail = (e: unknown, status = 502) => {
  const msg = (e as Error).message ?? "Erro";
  const friendly: Record<string, string> = {
    "npl:collection_exists": "Já existe uma coleção com esse nome.",
    "npl:collection_name": "Dê um nome para a coleção.",
    "npl:collection_not_found": "Essa coleção não existe mais.",
  };
  const key = Object.keys(friendly).find((k) => msg.includes(k));
  return Response.json({ error: key ? friendly[key] : msg }, { status: key ? 400 : status, headers: NO_STORE });
};

// completar os dados pelo Deezer pode levar alguns segundos
export const maxDuration = 60;

export async function GET(request: Request) {
  const denied = await bibliotecaDenied(request).catch((e) => fail(e));
  if (denied) return denied;
  try {
    // arquivos de músicas bloqueadas que terminaram de separar depois
    const trash = await adminRpc<string[]>("npl_lib_trash_take").catch(() => []);
    if (trash.length) await removeStemFiles(trash);
    const data = await adminRpc<LibraryData>("npl_lib_list");
    // músicas antigas sem título/capa: completa pelo Deezer (e grava, para não buscar de novo)
    const rows = data.songs.map((s) => ({ deezer_id: Number(s.deezer_id), meta: s.meta as never }));
    await completeCacheMeta(rows).catch(() => {});
    rows.forEach((r, i) => (data.songs[i].meta = r.meta));
    return Response.json(data, { headers: NO_STORE });
  } catch (e) {
    return fail(e);
  }
}

type Body = { action?: string; ids?: unknown; collection?: unknown; name?: unknown; mb?: unknown };

export async function POST(request: Request) {
  const denied = await bibliotecaDenied(request).catch((e) => fail(e));
  if (denied) return denied;
  let body: Body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "JSON inválido" }, { status: 400 });
  }
  const ids = (Array.isArray(body.ids) ? body.ids : [])
    .map(Number)
    .filter((n) => Number.isSafeInteger(n) && n > 0)
    .slice(0, 500);
  const collection = typeof body.collection === "string" && UUID.test(body.collection) ? body.collection : null;
  const name = typeof body.name === "string" ? body.name.slice(0, 80) : "";
  const needIds = () => {
    if (!ids.length) throw new Error("Escolha pelo menos uma música");
  };
  const needCollection = () => {
    if (!collection) throw new Error("Coleção inválida");
  };
  try {
    switch (body.action) {
      case "remove":
      case "block": {
        needIds();
        // primeiro o registro (o jogo para de usar), depois os arquivos
        const r = await adminRpc<{ removed: number; paths: string[] }>("npl_lib_remove", { p_ids: ids, p_block: body.action === "block" });
        const failed = await removeStemFiles(r.paths ?? []);
        return Response.json({ ok: true, removed: r.removed, filesFailed: failed }, { headers: NO_STORE });
      }
      case "unblock":
        needIds();
        return Response.json({ ok: true, n: await adminRpc<number>("npl_lib_unblock", { p_ids: ids }) }, { headers: NO_STORE });
      case "pin":
      case "unpin":
        needIds();
        return Response.json(
          { ok: true, n: await adminRpc<number>("npl_lib_pin", { p_ids: ids, p_pinned: body.action === "pin" }) },
          { headers: NO_STORE },
        );
      case "collection_add":
      case "collection_remove":
        needIds();
        needCollection();
        return Response.json(
          {
            ok: true,
            n: await adminRpc<number>("npl_lib_collection_set", { p_collection: collection, p_ids: ids, p_add: body.action === "collection_add" }),
          },
          { headers: NO_STORE },
        );
      case "collection_create":
        return Response.json({ ok: true, collection: await adminRpc("npl_lib_collection_save", { p_id: null, p_name: name }) }, { headers: NO_STORE });
      case "collection_rename":
        needCollection();
        return Response.json(
          { ok: true, collection: await adminRpc("npl_lib_collection_save", { p_id: collection, p_name: name }) },
          { headers: NO_STORE },
        );
      case "collection_delete":
        needCollection();
        return Response.json({ ok: true, deleted: await adminRpc<boolean>("npl_lib_collection_delete", { p_id: collection }) }, { headers: NO_STORE });
      // fila do separador (vale para todas as salas)
      case "queue_pause":
      case "queue_resume":
        return Response.json(
          { ok: true, paused: await adminRpc<boolean>("npl_lib_queue_pause", { p_paused: body.action === "queue_pause" }) },
          { headers: NO_STORE },
        );
      case "queue_clear":
        return Response.json({ ok: true, n: await adminRpc<number>("npl_lib_queue_clear") }, { headers: NO_STORE });
      case "limit": {
        const mb = Math.round(Number(body.mb));
        if (!Number.isFinite(mb) || mb < 20 || mb > 500) throw new Error("O limite vai de 20 a 500 MB");
        const r = await adminRpc<{ limit_mb: number; evicted: { paths?: Record<string, string> }[] }>("npl_lib_set_limit", { p_mb: mb });
        const files = (r.evicted ?? []).flatMap((g) => Object.values(g.paths ?? {}));
        const failed = await removeStemFiles(files);
        return Response.json({ ok: true, limit_mb: r.limit_mb, evicted: r.evicted?.length ?? 0, filesFailed: failed }, { headers: NO_STORE });
      }
      default:
        return Response.json({ error: "Ação desconhecida" }, { status: 400 });
    }
  } catch (e) {
    const msg = (e as Error).message ?? "";
    return fail(e, /^(Escolha|Coleção inválida|O limite)/.test(msg) ? 400 : 502);
  }
}
