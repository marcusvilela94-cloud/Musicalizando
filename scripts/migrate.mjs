// Aplica as migrações de supabase/migrations no banco do Supabase (o real).
// Guarda o que já rodou na tabela public.npl_schema_migrations.
//
// Precisa de SUPABASE_DB_URL no .env.local (Supabase > Connect > "Session pooler"),
// ex.: postgresql://postgres.<ref>:<senha>@aws-0-<região>.pooler.supabase.com:5432/postgres
//
// Uso: npm run db:migrate                 -> aplica as pendentes
//      npm run db:migrate -- --status      -> só lista
//      npm run db:migrate -- --baseline    -> marca todas como já aplicadas (sem rodar)
//      npm run db:migrate -- --baseline-until 20261107000006   -> marca até essa (inclusive)
import pg from "pg";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const args = process.argv.slice(2);

function envFromFile() {
  const f = join(root, ".env.local");
  if (!existsSync(f)) return {};
  const out = {};
  for (const line of readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

const url = process.env.SUPABASE_DB_URL ?? envFromFile().SUPABASE_DB_URL;
if (!url) {
  console.error("Falta SUPABASE_DB_URL no .env.local (Supabase > Connect > Session pooler).");
  process.exit(1);
}

const dir = join(root, "supabase", "migrations");
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  await client.query(`create table if not exists public.npl_schema_migrations (
    name text primary key, applied_at timestamptz not null default now())`);
  await client.query("alter table public.npl_schema_migrations enable row level security");
  await client.query("revoke all on public.npl_schema_migrations from anon, authenticated");
  const done = new Set((await client.query("select name from public.npl_schema_migrations")).rows.map((r) => r.name));

  const bi = args.indexOf("--baseline-until");
  if (args.includes("--baseline") || bi >= 0) {
    const until = bi >= 0 ? args[bi + 1] : null;
    for (const f of files) {
      if (until && f.slice(0, until.length) > until) continue;
      if (!done.has(f)) {
        await client.query("insert into public.npl_schema_migrations (name) values ($1) on conflict do nothing", [f]);
        console.log("marcada como aplicada:", f);
      }
    }
  } else {
    const pending = files.filter((f) => !done.has(f));
    for (const f of files) console.log(done.has(f) ? "  ok      " : "  PENDENTE", f);
    if (!args.includes("--status")) {
      for (const f of pending) {
        process.stdout.write(`aplicando ${f}… `);
        await client.query("begin");
        try {
          await client.query(readFileSync(join(dir, f), "utf8"));
          await client.query("insert into public.npl_schema_migrations (name) values ($1)", [f]);
          await client.query("commit");
          console.log("ok");
        } catch (e) {
          await client.query("rollback");
          console.log("ERRO");
          throw e;
        }
      }
      if (!pending.length) console.log("nada pendente");
    }
  }
} finally {
  await client.end();
}
