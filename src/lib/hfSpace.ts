import "server-only";

/**
 * Separador da nuvem (Hugging Face Space, CPU grátis). O Space dorme sem
 * visitas; para acordar, o servidor consulta o estado e pede para religar
 * (HF_TOKEN fica só aqui no servidor). HF_SPACE = "dono/nome".
 */
const SPACE = () => process.env.HF_SPACE || "marcuslk/musicalizando-separador";
const API = "https://huggingface.co/api/spaces";

export const cloudConfigured = () => !!process.env.HF_TOKEN;

type Runtime = { stage?: string; domains?: { domain?: string }[] };

export async function wakeCloudSeparator(): Promise<{ stage: string | null; action: string }> {
  const token = process.env.HF_TOKEN;
  if (!token) return { stage: null, action: "not_configured" };
  const auth = { Authorization: `Bearer ${token}` };
  const rt = await fetch(`${API}/${SPACE()}/runtime`, { headers: auth, cache: "no-store", signal: AbortSignal.timeout(10000) })
    .then((r) => (r.ok ? (r.json() as Promise<Runtime>) : null))
    .catch(() => null);
  const stage = rt?.stage ?? null;
  let action = "ping";
  // dormindo/parado: pede para religar (o mesmo que abrir a página do Space)
  if (!stage || ["SLEEPING", "STOPPED", "PAUSED", "RUNTIME_ERROR"].includes(stage)) {
    const r = await fetch(`${API}/${SPACE()}/restart`, { method: "POST", headers: auth, cache: "no-store", signal: AbortSignal.timeout(10000) }).catch(
      () => null,
    );
    action = r?.ok ? "restart" : `restart_failed_${r?.status ?? "net"}`;
  }
  // uma visita também acorda
  const domain = rt?.domains?.[0]?.domain ?? `${SPACE().replace("/", "-").replace(/_/g, "-").toLowerCase()}.hf.space`;
  await fetch(`https://${domain}/`, { headers: auth, cache: "no-store", signal: AbortSignal.timeout(5000) }).catch(() => null);
  return { stage, action };
}
