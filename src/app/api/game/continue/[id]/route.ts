import { getTrack } from "@/lib/deezer";
import { supabaseServer } from "@/lib/supabaseServer";
import { prepareContinue, type SyncEntry } from "@/lib/sync";

// GET /api/game/continue/{deezerId}?code=SALA&owner=TOKEN
// -> serve para "Continuar a letra"? + plano (linhas e tempos).
// Consulta o cache (npl_sync_cache) antes do Groq; grava a análise nova
// (só com o token de quem comanda a sala). groq=true quando chamou o Groq
// (o cliente espera ~3 s antes da próxima: 20 pedidos/minuto).
export const maxDuration = 60;

export async function GET(request: Request, ctx: RouteContext<"/api/game/continue/[id]">) {
  const { id } = await ctx.params;
  if (!/^\d+$/.test(id)) return Response.json({ error: "ID inválido" }, { status: 400 });
  const q = new URL(request.url).searchParams;
  const code = q.get("code") ?? "";
  const owner = q.get("owner") ?? "";
  const sb = supabaseServer();
  try {
    const t = await getTrack(id);
    if (!t.preview) return Response.json({ ok: false, reason: "sem prévia", groq: false });
    const { data } = await sb.rpc("npl_sync_get", { p_ids: [Number(id)] });
    const cached = (Array.isArray(data) && data[0] ? (data[0] as SyncEntry) : null) ?? null;
    const r = await prepareContinue({ preview: t.preview, titleShort: t.titleShort, artist: t.artist, duration: t.duration }, cached);
    if (r.entry && code && owner) {
      // falha ao gravar o cache não atrapalha a partida
      await sb.rpc("npl_sync_put", { p_code: code, p_owner_token: owner, p_entry: { ...r.entry, deezer_id: Number(id) } });
    }
    return Response.json({ ...r.verdict, groq: !r.fromCache && !!r.entry && r.entry.line_count > 0 }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json({ ok: false, reason: (e as Error).message, groq: true }, { status: 200 });
  }
}
