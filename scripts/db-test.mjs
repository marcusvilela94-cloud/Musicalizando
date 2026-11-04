// Testa as migrações SQL num Postgres em memória (PGlite), sem tocar no Supabase.
// Uso: npm run test:db
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

const db = new PGlite();
const dir = join(import.meta.dirname, "..", "supabase", "migrations");

// Simula o que já existe num projeto Supabase
await db.exec(`
  create role anon; create role authenticated;
  create schema realtime;
  create table realtime.sent (id serial, payload jsonb, event text, topic text, private boolean);
  create function realtime.send(payload jsonb, event text, topic text, private boolean) returns void
    language sql as $$ insert into realtime.sent (payload, event, topic, private) values (payload, event, topic, private) $$;
`);

for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
  await db.exec(readFileSync(join(dir, f), "utf8"));
  console.log("ok migração", f);
}
// rodar duas vezes deve funcionar (idempotente)
for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
  await db.exec(readFileSync(join(dir, f), "utf8"));
}

const rpc = async (fn, ...args) => {
  const ph = args.map((_, i) => `$${i + 1}`).join(", ");
  const r = await db.query(`select public.${fn}(${ph}) as v`, args);
  return r.rows[0].v;
};
const fails = async (p, msg) => {
  try {
    await p;
  } catch (e) {
    if (msg) assert.match(e.message, new RegExp(msg));
    return;
  }
  throw new Error("esperava erro " + msg);
};
const sql = async (q, a) => (await db.query(q, a)).rows;

// ---------- normalização / similaridade ----------
const cls = async (ans, cands, title) => rpc("npl_classify", ans, cands, title);
assert.equal(await rpc("npl_normalize", "Os Paralamas do Sucesso"), "paralamas do sucesso");
assert.equal(await rpc("npl_normalize", "Simon & Garfunkel"), "simon garfunkel");
assert.equal(await rpc("npl_normalize", "Ação!"), "acao");
assert.equal(await cls("pos", ["Pós (Ao Vivo)"], true), "ok");
assert.equal(await cls("Evidências", ["Evidências - Ao Vivo"], true), "ok");
assert.equal(await cls("evidencia", ["Evidências"], true), "ok");
assert.equal(await cls("henrique e juliano", ["Henrique & Juliano"], false), "ok");
assert.equal(await cls("anita", ["Anitta", "MC Kevinho"], false), "ok");
assert.equal(await cls("kevinho", ["Anitta", "MC Kevinho"], false), "doubt");
assert.equal(await cls("xuxa", ["Anitta"], false), "wrong");
assert.equal(await cls("", ["Anitta"], false), "empty");
assert.equal(await cls("dont stop me now", ["Don't Stop Me Now (Remastered)"], true), "ok");
assert.equal(await cls("harder better", ["Harder, Better, Faster, Stronger"], true), "wrong");
assert.equal(await cls("the beatles", ["Beatles"], false), "ok");
console.log("ok normalização");

// ---------- sala ----------
const OWNER = "owner-token-123456789";
const P = (n) => `player-token-${n}-abcdefgh`;
const { code } = await rpc("npl_create_room", OWNER, { rounds: 5, penalty: 20, answerSeconds: 10 });
assert.match(code, /^\d{4}$/);
let st = await rpc("npl_get_state", code);
assert.equal(st.teams.length, 2);
assert.equal(st.room.owner_hash, undefined);
assert.equal(st.room.settings.penalty, 20);
await fails(rpc("npl_update_settings", code, "wrong-owner-token-xx", {}), "not_owner");

// acesso direto às tabelas negado para anon
await db.exec("set role anon");
await fails(db.query("select * from public.npl_rooms"), "permission denied");
await fails(db.query("select public.npl_recalc_scores(gen_random_uuid())"), "permission denied");
await db.exec("reset role");

const a = await rpc("npl_join", code, P(1), "Ana");
const b = await rpc("npl_join", code, P(2), "Beto");
const c = await rpc("npl_join", code, P(3), "Caio");
assert.equal(a.token_hash, undefined);
const again = await rpc("npl_join", code, P(1), "");
assert.equal(again.id, a.id, "reconexão volta ao mesmo jogador");

st = await rpc("npl_get_state", code);
const [T1, T2] = st.teams.map((t) => t.id);
await rpc("npl_set_team", code, P(1), T1);
await rpc("npl_set_team", code, P(2), T2);
await rpc("npl_set_team", code, P(3), T2);
await rpc("npl_rename_team", code, P(1), T1, "Os Brabos");
await fails(rpc("npl_rename_team", code, P(2), T1, "hack"), "not_allowed");

await rpc("npl_shuffle_teams", code, OWNER);
st = await rpc("npl_get_state", code);
const sizes = st.teams.map((t) => st.players.filter((p) => p.team_id === t.id).length).sort();
assert.deepEqual(sizes, [1, 2], "sorteio equilibrado");
// volta para o arranjo conhecido
await rpc("npl_move_player", code, OWNER, a.id, T1);
await rpc("npl_move_player", code, OWNER, b.id, T2);
await rpc("npl_move_player", code, OWNER, c.id, T2);

// solo e volta
await rpc("npl_update_settings", code, OWNER, { teamMode: "solo" });
st = await rpc("npl_get_state", code);
assert.equal(st.teams.length, 3);
assert.equal(new Set(st.players.map((p) => p.team_id)).size, 3);
await rpc("npl_update_settings", code, OWNER, { teamMode: "teams", teamCount: 2 });
st = await rpc("npl_get_state", code);
assert.equal(st.teams.length, 2);
const teamIds = st.teams.map((t) => t.id);
await rpc("npl_move_player", code, OWNER, a.id, teamIds[0]);
await rpc("npl_move_player", code, OWNER, b.id, teamIds[1]);
await rpc("npl_move_player", code, OWNER, c.id, teamIds[1]);
const [A, B] = teamIds;

// ---------- partida ----------
const tracks = [1, 2, 3, 4, 5].map((i) => ({
  deezer_id: 1000 + i,
  title: i === 1 ? "Evidências (Ao Vivo)" : `Musica Numero ${i}`,
  title_short: i === 1 ? "Evidências" : `Musica Numero ${i}`,
  artist: i === 1 ? "Chitãozinho & Xororó" : `Artista ${i}`,
  artists: [i === 1 ? "Chitãozinho & Xororó" : `Artista ${i}`],
  cover: "x",
}));
await rpc("npl_start_match", code, OWNER, tracks);
st = await rpc("npl_get_state", code);
assert.equal(st.room.phase, "playing");
assert.equal(st.rounds.length, 1);
assert.equal(st.rounds[0].reveal, null, "resposta escondida");
let R = st.rounds[0].id;
const ht = await rpc("npl_host_tracks", code, OWNER);
assert.deepEqual(ht.map((x) => x.deezer_id), [1001, 1002]);
await fails(rpc("npl_host_tracks", code, P(1)), "not_owner");

// botão antes da rodada abrir
assert.equal((await rpc("npl_buzz", code, P(1), R)).reason, "closed");
assert.equal(await rpc("npl_host_answer", code, OWNER), null, "sem dúvida, sem resposta");
await rpc("npl_round_begin", code, OWNER, R, ["Participação Especial"]);
await rpc("npl_advance_stage", code, OWNER, R, 1); // estágio 2 = 80 pts

// dois toques "simultâneos": só um ganha (conexões paralelas no PGlite são serializadas,
// no Postgres real o FOR UPDATE da sala garante a mesma coisa)
const [r1, r2] = await Promise.all([rpc("npl_buzz", code, P(2), R), rpc("npl_buzz", code, P(1), R)]);
assert.equal([r1, r2].filter((x) => x.ok).length, 1, "só um toque vence");
assert.equal(r1.ok, true);
assert.equal(r2.reason, "taken");
// colega do mesmo time não abre outra vez
assert.equal((await rpc("npl_buzz", code, P(3), R)).reason, "own_turn");
st = await rpc("npl_get_state", code);
assert.equal(st.attempts.filter((x) => x.kind === "late").length, 1, "toque atrasado registrado");

// time B erra -> penalidade, B bloqueado
await fails(rpc("npl_submit_answer", code, P(1), r1.attempt_id, "x", "y").then((r) => {
  if (r.reason === "not_your_team") throw new Error("not_your_team");
}), "not_your_team");
let ans = await rpc("npl_submit_answer", code, P(3), r1.attempt_id, "Zezé", "Pirata");
assert.equal(ans.result, "wrong");
st = await rpc("npl_get_state", code);
assert.equal(st.teams.find((t) => t.id === B).score, -20);
assert.equal(st.rounds[0].locked_team_id, B);
assert.equal(st.rounds[0].status, "playing");
assert.equal((await rpc("npl_buzz", code, P(2), R)).reason, "locked");

// time A erra -> bloqueio passa para A
let ra = await rpc("npl_buzz", code, P(1), R);
assert.equal(ra.ok, true);
ans = await rpc("npl_submit_answer", code, P(1), ra.attempt_id, "", "nao sei");
assert.equal(ans.result, "wrong");
st = await rpc("npl_get_state", code);
assert.equal(st.rounds[0].locked_team_id, A);
assert.equal((await rpc("npl_buzz", code, P(1), R)).reason, "locked");

// B rouba: artista + título no estágio 2 = 80*1.5 = 120, roubo = 60
let rb = await rpc("npl_buzz", code, P(2), R);
assert.equal(rb.ok, true);
ans = await rpc("npl_submit_answer", code, P(2), rb.attempt_id, "chitaozinho e xororo", "evidencias");
assert.equal(ans.result, "correct");
assert.equal(ans.points, 60);
st = await rpc("npl_get_state", code);
assert.equal(st.rounds[0].status, "revealed");
assert.equal(st.rounds[0].reveal.title, "Evidências (Ao Vivo)");
assert.ok(st.rounds[0].reveal.artists.includes("Participação Especial"));
assert.equal(st.teams.find((t) => t.id === B).score, 40); // -20 + 60
assert.equal(st.teams.find((t) => t.id === A).score, -20);

// dono inverte o erro de A -> vira acerto (roubo? não: foi a 2a tentativa, já havia erro de B)
await rpc("npl_override", code, OWNER, ra.attempt_id, true);
st = await rpc("npl_get_state", code);
assert.equal(st.teams.find((t) => t.id === A).score, 60); // título no estágio 2 = 120 / 2
await rpc("npl_override", code, OWNER, ra.attempt_id, false);
st = await rpc("npl_get_state", code);
assert.equal(st.teams.find((t) => t.id === A).score, -20);

// próxima rodada (chamada dupla não avança duas vezes)
await rpc("npl_show_scoreboard", code, OWNER, R);
await rpc("npl_next_round", code, OWNER, 1);
await rpc("npl_next_round", code, OWNER, 1);
st = await rpc("npl_get_state", code);
assert.equal(st.room.round_no, 2);
R = st.rounds[1].id;
await rpc("npl_round_begin", code, OWNER, R, []);

// zona de dúvida: "Musica Numer 2" vs "Musica Numero 2"? isso é ok; use algo a ~30%
rb = await rpc("npl_buzz", code, P(2), R);
ans = await rpc("npl_submit_answer", code, P(2), rb.attempt_id, "", "Muziqa Nmro 2");
assert.equal(ans.result, "doubt");
st = await rpc("npl_get_state", code);
assert.equal(st.rounds[1].status, "doubt");
assert.equal((await rpc("npl_buzz", code, P(1), R)).reason, "taken");
await fails(rpc("npl_judge", code, P(1), rb.attempt_id, true), "not_owner");
assert.equal((await rpc("npl_host_answer", code, OWNER)).title, "Musica Numero 2");
await fails(rpc("npl_host_answer", code, P(1)), "not_owner");
assert.equal(await rpc("npl_judge", code, OWNER, rb.attempt_id, true), "correct");
st = await rpc("npl_get_state", code);
assert.equal(st.teams.find((t) => t.id === B).score, 40 + 150);

// tempo esgotado + pausa
await rpc("npl_next_round", code, OWNER, 2);
st = await rpc("npl_get_state", code);
R = st.rounds[2].id;
await rpc("npl_round_begin", code, OWNER, R, []);
ra = await rpc("npl_buzz", code, P(1), R);
assert.equal(await rpc("npl_tick", code), false);
await db.query("update npl_attempts set deadline = clock_timestamp() - interval '5 seconds' where id = $1", [ra.attempt_id]);
assert.equal(await rpc("npl_tick", code), true);
st = await rpc("npl_get_state", code);
assert.equal(st.attempts.find((x) => x.id === ra.attempt_id).status, "timeout");
assert.equal(st.rounds[2].locked_team_id, A);
await rpc("npl_pause", code, OWNER, true);
assert.equal((await rpc("npl_buzz", code, P(2), R)).reason, "paused");
await rpc("npl_pause", code, OWNER, false);

// estágios até o fim -> revela sem pontos
for (let s = 1; s <= 6; s++) await rpc("npl_advance_stage", code, OWNER, R, s);
st = await rpc("npl_get_state", code);
assert.equal(st.rounds[2].status, "revealed");
assert.equal(st.rounds[2].winner_team_id, null);

// jogador entra no meio: só joga a partir da próxima rodada
const d = await rpc("npl_join", code, P(4), "Duda");
await rpc("npl_set_team", code, P(4), A);
await fails(rpc("npl_set_team", code, P(4), B), "team_locked");
await rpc("npl_next_round", code, OWNER, 3);
st = await rpc("npl_get_state", code);
R = st.rounds[3].id;
await rpc("npl_round_begin", code, OWNER, R, []);
assert.equal((await rpc("npl_buzz", code, P(4), R)).ok, true, "Duda joga na rodada 4");

// pular música
await rpc("npl_skip_round", code, OWNER, R);
st = await rpc("npl_get_state", code);
assert.equal(st.rounds[3].skipped, true);
await rpc("npl_adjust_score", code, OWNER, A, 10);
await rpc("npl_next_round", code, OWNER, 4);
st = await rpc("npl_get_state", code);
R = st.rounds[4].id;
await rpc("npl_round_begin", code, OWNER, R, []);
await rpc("npl_skip_round", code, OWNER, R);
await rpc("npl_next_round", code, OWNER, 5);
st = await rpc("npl_get_state", code);
assert.equal(st.room.phase, "finished");
assert.equal(st.teams.find((t) => t.id === A).score, -30); // -20 erro, -20 tempo, +10 ajuste

// revanche zera o placar e mantém os times
await rpc("npl_start_match", code, OWNER, tracks);
st = await rpc("npl_get_state", code);
assert.equal(st.room.match_no, 2);
assert.deepEqual(st.teams.map((t) => t.score), [0, 0]);
assert.equal(st.teams.length, 2);

const sent = await sql("select count(*)::int as n, min(topic) as t from realtime.sent");
assert.ok(sent[0].n > 20);
assert.match(sent[0].t, /^npl_room_/);

// limpeza de salas antigas
await db.query("update npl_rooms set last_activity_at = now() - interval '7 hours'");
await rpc("npl_create_room", OWNER, {});
assert.equal((await sql("select count(*)::int as n from npl_rooms"))[0].n, 1);
assert.equal((await sql("select count(*)::int as n from npl_players"))[0].n, 0);

console.log("ok todos os testes do banco");
