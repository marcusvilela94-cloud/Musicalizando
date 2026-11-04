// Supabase "de mentira" para testar localmente SEM tocar no projeto real:
// emula só o endpoint de RPC do PostgREST (POST /rest/v1/rpc/<fn>) em cima
// de um Postgres em memória (PGlite) com as mesmas migrações.
// Não há Realtime: os clientes caem no polling (mais lento, mas funciona).
//
// Uso: npm run dev:fake-db   (porta 54329)
//      e no .env.local: NEXT_PUBLIC_SUPABASE_URL=http://localhost:54329
//                       NEXT_PUBLIC_SUPABASE_ANON_KEY=fake
import { PGlite } from "@electric-sql/pglite";
import { createServer } from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const PORT = Number(process.env.PORT ?? 54329);
const db = new PGlite();
await db.exec(`
  create role anon; create role authenticated;
  create schema realtime;
  create function realtime.send(payload jsonb, event text, topic text, private boolean) returns void
    language sql as $$ select null::void $$;
`);
const dir = join(import.meta.dirname, "..", "supabase", "migrations");
for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
  await db.exec(readFileSync(join(dir, f), "utf8"));
}

// fila: PGlite é single-thread; a fila imita as transações serializadas
let chain = Promise.resolve();
const run = (fn) => (chain = chain.then(fn, fn));

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors).end();
    return;
  }
  const m = req.url?.match(/^\/rest\/v1\/rpc\/(npl_\w+)/);
  if (!m || req.method !== "POST") {
    res.writeHead(404, cors).end();
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () =>
    run(async () => {
      try {
        const args = body ? JSON.parse(body) : {};
        const keys = Object.keys(args).filter((k) => /^p_\w+$/.test(k));
        const params = keys.map((k) => (args[k] !== null && typeof args[k] === "object" ? JSON.stringify(args[k]) : args[k]));
        const call = `select public.${m[1]}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as v`;
        const r = await db.query(call, params);
        res.writeHead(200, { ...cors, "Content-Type": "application/json" }).end(JSON.stringify(r.rows[0]?.v ?? null));
      } catch (e) {
        res
          .writeHead(400, { ...cors, "Content-Type": "application/json" })
          .end(JSON.stringify({ message: e.message, code: "P0001", details: null, hint: null }));
      }
    }),
  );
}).listen(PORT, () => console.log(`fake supabase em http://localhost:${PORT}`));
