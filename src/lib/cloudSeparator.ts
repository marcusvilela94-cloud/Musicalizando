import "server-only";

/**
 * Separador da nuvem. Duas opções (a primeira configurada vale):
 *  - GitHub Actions: GH_DISPATCH_TOKEN (token fine-grained, só "Actions: read/write"
 *    neste repositório). Dispara .github/workflows/separador.yml, que roda o
 *    separador até a fila ficar vazia.
 *  - Hugging Face Space: HF_TOKEN + HF_SPACE ("dono/nome"); acorda o Space.
 * Os tokens ficam só aqui no servidor.
 */
const GH_REPO = () => process.env.GH_REPO || "marcusvilela94-cloud/Musicalizando";
const GH_WORKFLOW = () => process.env.GH_WORKFLOW || "separador.yml";
const GH_REF = () => process.env.GH_REF || "master";
const HF_SPACE = () => process.env.HF_SPACE ?? "";

const github = () => !!process.env.GH_DISPATCH_TOKEN;
const huggingFace = () => !!process.env.HF_TOKEN && /^[\w-]+\/[\w.-]+$/.test(HF_SPACE());

export const cloudConfigured = () => github() || huggingFace();

export async function wakeCloudSeparator(): Promise<{ provider: string | null; action: string }> {
  if (github()) return { provider: "github", action: await wakeGithub() };
  if (huggingFace()) return { provider: "huggingface", action: await wakeHuggingFace() };
  return { provider: null, action: "not_configured" };
}

async function wakeGithub(): Promise<string> {
  const h = {
    Authorization: `Bearer ${process.env.GH_DISPATCH_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const base = `https://api.github.com/repos/${GH_REPO()}/actions/workflows/${GH_WORKFLOW()}`;
  // já tem um começando ou rodando? (a máquina leva 1–3 min para mandar o 1º sinal de vida)
  for (const status of ["queued", "in_progress"]) {
    const r = await fetch(`${base}/runs?status=${status}&per_page=1`, { headers: h, cache: "no-store", signal: AbortSignal.timeout(10000) })
      .then((x) => (x.ok ? (x.json() as Promise<{ total_count?: number }>) : null))
      .catch(() => null);
    if (r?.total_count) return `already_${status}`;
  }
  const r = await fetch(`${base}/dispatches`, {
    method: "POST",
    headers: { ...h, "Content-Type": "application/json" },
    body: JSON.stringify({ ref: GH_REF() }),
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
  }).catch(() => null);
  return r?.ok ? "dispatched" : `dispatch_failed_${r?.status ?? "net"}`;
}

async function wakeHuggingFace(): Promise<string> {
  const auth = { Authorization: `Bearer ${process.env.HF_TOKEN}` };
  const api = `https://huggingface.co/api/spaces/${HF_SPACE()}`;
  const rt = await fetch(`${api}/runtime`, { headers: auth, cache: "no-store", signal: AbortSignal.timeout(10000) })
    .then((r) => (r.ok ? (r.json() as Promise<{ stage?: string; domains?: { domain?: string }[] }>) : null))
    .catch(() => null);
  let action = "ping";
  if (!rt?.stage || ["SLEEPING", "STOPPED", "PAUSED", "RUNTIME_ERROR"].includes(rt.stage)) {
    const r = await fetch(`${api}/restart`, { method: "POST", headers: auth, cache: "no-store", signal: AbortSignal.timeout(10000) }).catch(() => null);
    action = r?.ok ? "restart" : `restart_failed_${r?.status ?? "net"}`;
  }
  const domain = rt?.domains?.[0]?.domain;
  if (domain) await fetch(`https://${domain}/`, { headers: auth, cache: "no-store", signal: AbortSignal.timeout(5000) }).catch(() => null);
  return action;
}
