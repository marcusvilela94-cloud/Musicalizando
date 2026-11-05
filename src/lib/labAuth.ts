import "server-only";
import { timingSafeEqual } from "node:crypto";

/**
 * Senha da página de teste /lab/sync (variável LAB_PASSWORD na Vercel e no
 * .env.local). Sem a variável, o lab fica desligado.
 */
export function labDenied(request: Request): Response | null {
  const expected = process.env.LAB_PASSWORD;
  if (!expected) return Response.json({ error: "Lab desligado: defina LAB_PASSWORD na Vercel." }, { status: 503 });
  const got = request.headers.get("x-lab-password") ?? "";
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return Response.json({ error: "Senha errada" }, { status: 401 });
  return null;
}
