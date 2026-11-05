// Cria/atualiza o separador na nuvem (Hugging Face Space privado, Docker, CPU basic).
// Uso: node scripts/hf-space.mjs
// Lê HF_TOKEN e SEPARADOR_TOKEN do .env.local. Envia separador/space/* + separador.py +
// requirements.txt e grava as variáveis secretas JOGO_URL e SEPARADOR_TOKEN no Space.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const env = Object.fromEntries(
  readFileSync(join(root, ".env.local"), "utf8")
    .split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")]),
);
const TOKEN = process.env.HF_TOKEN || env.HF_TOKEN;
const SEP = process.env.SEPARADOR_TOKEN || env.SEPARADOR_TOKEN;
const JOGO = process.env.JOGO_URL || env.JOGO_URL || "https://musicalizando-phi.vercel.app";
const NAME = process.env.HF_SPACE_NAME || "musicalizando-separador";
if (!TOKEN || !SEP) throw new Error("Falta HF_TOKEN ou SEPARADOR_TOKEN no .env.local");

const H = { Authorization: `Bearer ${TOKEN}` };
const hf = async (path, init = {}) => {
  const r = await fetch(`https://huggingface.co${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  const text = await r.text();
  return { ok: r.ok, status: r.status, body: text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null };
};

const me = await hf("/api/whoami-v2");
if (!me.ok) throw new Error(`Token do Hugging Face: ${me.status}`);
const repo = `${me.body.name}/${NAME}`;

// 1. cria (privado, Docker, CPU basic) se ainda não existe
const exists = await hf(`/api/spaces/${repo}`);
if (!exists.ok) {
  const c = await hf("/api/repos/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "space", name: NAME, private: true, sdk: "docker", hardware: "cpu-basic" }),
  });
  if (!c.ok) throw new Error(`Criar o Space: ${c.status} ${JSON.stringify(c.body)}`);
  console.log("criado", repo);
} else console.log("já existe", repo, exists.body?.private ? "(privado)" : "(PÚBLICO!)");

// 2. variáveis secretas (antes do envio, para o primeiro build já subir configurado)
for (const [key, value] of [["JOGO_URL", JOGO], ["SEPARADOR_TOKEN", SEP]]) {
  const s = await hf(`/api/spaces/${repo}/secrets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, value }),
  });
  if (!s.ok) throw new Error(`Secret ${key}: ${s.status} ${JSON.stringify(s.body)}`);
  console.log("secret", key, "ok");
}

// 3. arquivos (um commit)
const files = {
  "Dockerfile": join(root, "separador", "space", "Dockerfile"),
  "README.md": join(root, "separador", "space", "README.md"),
  "separador.py": join(root, "separador", "separador.py"),
  "requirements.txt": join(root, "separador", "requirements.txt"),
};
const lines = [
  { key: "header", value: { summary: "Separador do Musicalizando", description: "" } },
  ...Object.entries(files).map(([path, file]) => ({
    key: "file",
    value: { path, encoding: "base64", content: readFileSync(file).toString("base64") },
  })),
];
const commit = await hf(`/api/spaces/${repo}/commit/main`, {
  method: "POST",
  headers: { "Content-Type": "application/x-ndjson" },
  body: lines.map((l) => JSON.stringify(l)).join("\n"),
});
if (!commit.ok) throw new Error(`Enviar arquivos: ${commit.status} ${JSON.stringify(commit.body)}`);
console.log("arquivos enviados", commit.body?.commitOid ?? "");

const rt = await hf(`/api/spaces/${repo}/runtime`);
console.log("estado:", rt.body?.stage, "hardware:", rt.body?.hardware?.current ?? rt.body?.hardware?.requested);
console.log(`https://huggingface.co/spaces/${repo}`);
