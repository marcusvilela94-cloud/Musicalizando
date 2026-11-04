// Confere, via supabase-js, que os nomes de argumentos usados em src/lib/api.ts
// batem com as assinaturas SQL. Requer: npm run dev:fake-db rodando.
import { createClient } from "@supabase/supabase-js";
import { readFileSync, readdirSync } from "node:fs";
import assert from "node:assert/strict";

const sb = createClient("http://localhost:54329", "fake", { auth: { persistSession: false } });
const rpc = async (fn, args) => {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data;
};

// 1) toda chamada em api.ts usa só argumentos que existem na função SQL
const apiSrc = readFileSync("src/lib/api.ts", "utf8");
const sqlSrc = readdirSync("supabase/migrations")
  .filter((f) => f.endsWith(".sql"))
  .map((f) => readFileSync(`supabase/migrations/${f}`, "utf8"))
  .join("\n");
let checked = 0;
for (const m of apiSrc.matchAll(/"(npl_\w+)",\s*\{([^}]*)\}/g)) {
  const [, fn, body] = m;
  const sig = sqlSrc.match(new RegExp(`function public\\.${fn}\\(([^)]*)\\)`));
  assert.ok(sig, `função ${fn} não existe no SQL`);
  for (const a of body.matchAll(/(p_\w+):/g)) assert.ok(sig[1].includes(a[1] + " "), `${fn}: argumento ${a[1]} não existe`);
  checked++;
}
console.log(`ok contratos api.ts <-> SQL (${checked} funções)`);

// 2) fluxo curto pelo supabase-js (jsonb, void, booleanos)
const OWNER = "o".repeat(32);
const A = "a".repeat(32);
const { code } = await rpc("npl_create_room", { p_owner_token: OWNER, p_settings: {} });
await rpc("npl_update_settings", { p_code: code, p_owner_token: OWNER, p_settings: { rounds: 5 } });
await rpc("npl_set_phase", { p_code: code, p_owner_token: OWNER, p_phase: "lobby" });
const a = await rpc("npl_join", { p_code: code, p_token: A, p_nickname: "Ana" });
await rpc("npl_join", { p_code: code, p_token: "b".repeat(32), p_nickname: "Bia" });
await rpc("npl_shuffle_teams", { p_code: code, p_owner_token: OWNER });
const tracks = [
  { deezer_id: 3135556, title: "Harder, Better, Faster, Stronger", title_short: "Harder, Better, Faster, Stronger", artist: "Daft Punk", artists: ["Daft Punk"], cover: null, album: null },
];
await rpc("npl_start_match", { p_code: code, p_owner_token: OWNER, p_tracks: tracks });
let st = await rpc("npl_get_state", { p_code: code });
const R = st.rounds[0].id;
await rpc("npl_round_begin", { p_code: code, p_owner_token: OWNER, p_round_id: R, p_artists: ["Daft Punk"] });
const bz = await rpc("npl_buzz", { p_code: code, p_token: A, p_round_id: R });
assert.equal(bz.ok, true);
const ans = await rpc("npl_submit_answer", { p_code: code, p_token: A, p_attempt_id: bz.attempt_id, p_artist: "daft punk", p_title: "" });
assert.equal(ans.result, "correct");
assert.equal(ans.points, 100);
await rpc("npl_next_round", { p_code: code, p_owner_token: OWNER, p_from_round: 1 });
st = await rpc("npl_get_state", { p_code: code });
assert.equal(st.room.phase, "finished");
assert.equal(st.players.find((p) => p.id === a.id).nickname, "Ana");
const { error } = await sb.rpc("npl_pause", { p_code: code, p_owner_token: "x".repeat(32), p_paused: true });
assert.match(error.message, /npl:not_owner/);
console.log("ok fluxo via supabase-js");
