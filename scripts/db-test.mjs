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
// créditos múltiplos e conectores de parceria
const jm = ["Jorge & Mateus"];
for (const a of ["Jorge e Mateus", "jorge and mateus", "Jorge x Mateus", "Jorge feat. Mateus", "Jorge ft Mateus", "Jorge & Mateus"]) {
  assert.equal(await cls(a, jm, false), "ok", a);
}
assert.equal(await cls("Jorge", jm, false), "wrong", "integrante sozinho não vale");
assert.equal(await cls("Mateus", jm, false), "wrong", "integrante sozinho não vale");
const ml = ["Major Lazer", "Anitta", "Pabllo Vittar"];
assert.equal(await cls("Pabllo Vittar", ml, false), "ok", "contributor vale");
assert.equal(await cls("Anitta e Pablo Vitar", ml, false), "ok", "basta um dos citados");
assert.equal(await cls("Major Lazer feat. Anitta", ml, false), "ok");
assert.equal(await cls("Malcolm X", ["Malcolm X"], true), "ok", "título não perde o x");
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

// ---------- estilo "Com apresentador" ----------
st = await rpc("npl_get_state", code);
assert.equal(st.room.settings.roomStyle, "all", "padrão: todos jogam");
assert.equal(st.room.settings.answerMode, "typed", "todos jogam: sempre digitada");
assert.equal(st.room.settings.lockSeconds, 15);
assert.equal(st.room.settings.sounds, true);
assert.equal(st.room.settings.sfxVolume, "high");
assert.equal(st.room.settings.clipMode, "sequence", "trechos: em sequência por padrão");
await rpc("npl_update_settings", code, OWNER, { roomStyle: "host", answerMode: "spoken", lockSeconds: 99 });
st = await rpc("npl_get_state", code);
assert.equal(st.room.settings.answerMode, "spoken", "com apresentador: falada");
assert.equal(st.room.settings.lockSeconds, 15, "valor inválido volta ao padrão");
await rpc("npl_update_settings", code, OWNER, { lockSeconds: 5, sfxVolume: "low" });
st = await rpc("npl_get_state", code);
assert.equal(st.room.settings.lockSeconds, 5, "5 s é aceito");
assert.equal(st.room.settings.sfxVolume, "low");
await rpc("npl_update_settings", code, OWNER, { lockSeconds: 15, sfxVolume: "alto demais" });
st = await rpc("npl_get_state", code);
assert.equal(st.room.settings.sfxVolume, "high", "volume inválido volta ao padrão");
await rpc("npl_update_settings", code, OWNER, { clipMode: "alternate" });
assert.equal((await rpc("npl_get_state", code)).room.settings.clipMode, "alternate");
await rpc("npl_update_settings", code, OWNER, { clipMode: "zigzag" });
assert.equal((await rpc("npl_get_state", code)).room.settings.clipMode, "sequence");
assert.equal(st.owner.claimed, false);
assert.equal(st.room.ctrl_hash, undefined, "hash do apresentador não vaza");

const CLAIM = "claim-secret-1234567890";
const PRES = "presenter-token-1234567890";
await fails(rpc("npl_open_claim", code, P(1), CLAIM), "not_host");
await rpc("npl_open_claim", code, OWNER, CLAIM);
await fails(rpc("npl_claim_owner", code, "errado-errado-errado", PRES), "bad_claim");
assert.equal((await rpc("npl_claim_owner", code, CLAIM, PRES)).ok, true);
await fails(rpc("npl_claim_owner", code, CLAIM, P(2)), "bad_claim"); // uso único
assert.equal((await rpc("npl_claim_owner", code, "qualquer-coisa-xxxxx", PRES)).ok, true, "reconexão com o mesmo token");
assert.equal(await rpc("npl_is_owner", code, PRES), true);
assert.equal(await rpc("npl_is_owner", code, P(2)), false);
st = await rpc("npl_get_state", code);
assert.equal(st.owner.claimed, true);
assert.equal(st.room.claim_hash, undefined);
await rpc("npl_update_settings", code, PRES, { answerMode: "typed" });
await rpc("npl_update_settings", code, PRES, { answerMode: "spoken" });

// ---------- partida (falada) ----------
const tracks = [1, 2, 3, 4, 5].map((i) => ({
  deezer_id: 1000 + i,
  title: i === 1 ? "Evidências (Ao Vivo)" : `Musica Numero ${i}`,
  title_short: i === 1 ? "Evidências" : `Musica Numero ${i}`,
  artist: i === 1 ? "Chitãozinho & Xororó" : `Artista ${i}`,
  artists: [i === 1 ? "Chitãozinho & Xororó" : `Artista ${i}`],
  cover: "x",
}));
await rpc("npl_start_match", code, PRES, tracks);
st = await rpc("npl_get_state", code);
assert.equal(st.room.phase, "playing");
assert.equal(st.rounds[0].reveal, null, "resposta escondida");
let R = st.rounds[0].id;
const ht = await rpc("npl_host_tracks", code, OWNER);
assert.deepEqual(ht.map((x) => x.deezer_id), [1001, 1002]);
await fails(rpc("npl_host_tracks", code, PRES), "not_host");
await fails(rpc("npl_round_begin", code, PRES, R, [], []), "not_host");

assert.equal((await rpc("npl_buzz", code, P(2), R)).reason, "closed");
await rpc("npl_round_begin", code, OWNER, R, ["Participação Especial"], [12, 3, 20, 0.5, 9, 0, "x"]);
st = await rpc("npl_get_state", code);
assert.deepEqual(st.rounds[0].offsets, [12, 3, 20, 0.5, 9, 0], "pontos de início guardados");
assert.equal(st.rounds[0].status, "playing");
assert.equal(st.rounds[0].play_seq, 0, "nada toca sozinho");
assert.equal((await rpc("npl_host_answer", code, PRES)).title, "Evidências (Ao Vivo)", "apresentador vê desde o início");
await fails(rpc("npl_host_answer", code, P(1)), "not_owner");

// tocar / repetir / próximo trecho
let p = await rpc("npl_play", code, PRES, R, 1, false);
assert.equal(p.ok, true);
assert.equal(p.round.play_seq, 1);
assert.equal(p.round.played_stage, 1);
p = await rpc("npl_play", code, PRES, R, 1, false); // repetir
assert.equal(p.round.play_seq, 2);
assert.equal(p.round.stage, 1);
p = await rpc("npl_play", code, PRES, R, 1, true); // próximo trecho (80 pts)
assert.equal(p.round.stage, 2);
assert.equal(p.round.played_stage, 2);
assert.equal((await rpc("npl_play", code, PRES, R, 1, true)).ok, false, "toque duplo não avança duas vezes");
await fails(rpc("npl_play", code, P(2), R, 2, false), "not_owner");

// EU SEI! no silêncio entre trechos, dois toques "simultâneos"
const [r1, r2] = await Promise.all([rpc("npl_buzz", code, P(2), R), rpc("npl_buzz", code, P(1), R)]);
assert.equal([r1, r2].filter((x) => x.ok).length, 1, "só um toque vence");
assert.equal(r1.ok, true);
assert.equal(r2.reason, "taken");
assert.equal((await rpc("npl_buzz", code, P(3), R)).reason, "own_turn");
assert.equal((await rpc("npl_submit_answer", code, P(2), r1.attempt_id, "a", "b")).reason, "spoken");
await fails(rpc("npl_decide", code, P(2), r1.attempt_id, true, true), "not_owner");

// B erra -> penalidade, bloqueio por tempo, volta a esperar no mesmo estágio
assert.equal(await rpc("npl_decide", code, PRES, r1.attempt_id, false, false), "wrong");
st = await rpc("npl_get_state", code);
assert.equal(st.teams.find((t) => t.id === B).score, -20);
assert.equal(st.rounds[0].locks[B].secs, 15);
assert.equal(st.rounds[0].locks[B].started_at, null, "contagem não começa no erro");
assert.equal(st.rounds[0].locks[B].until, null);
assert.equal(st.rounds[0].status, "playing");
assert.equal(st.rounds[0].stage, 2);
let lk = await rpc("npl_buzz", code, P(2), R);
assert.equal(lk.reason, "locked", "bloqueado enquanto a música não volta");
assert.equal(lk.until, null);
// a música volta (repetir): a contagem começa agora
await rpc("npl_play", code, PRES, R, 2, false);
st = await rpc("npl_get_state", code);
const lockB = Date.parse(st.rounds[0].locks[B].until);
assert.ok(Math.abs(lockB - st.server_now - 15000) < 2000, "bloqueado por ~15 s a partir do play");
assert.ok(st.rounds[0].locks[B].started_at);
lk = await rpc("npl_buzz", code, P(2), R);
assert.equal(lk.reason, "locked");
assert.ok(lk.until);
// tocar de novo não reinicia uma contagem que já está correndo
await rpc("npl_play", code, PRES, R, 2, false);
st = await rpc("npl_get_state", code);
assert.equal(Date.parse(st.rounds[0].locks[B].until), lockB, "contagem não reinicia");

// A acerta só o artista (roubo vale normal): 80 * 50% = 40; rodada continua
let ra = await rpc("npl_buzz", code, P(1), R);
assert.equal(ra.ok, true);
assert.equal(await rpc("npl_decide", code, PRES, ra.attempt_id, true, false), "partial");
st = await rpc("npl_get_state", code);
assert.equal(st.rounds[0].status, "playing");
assert.equal(st.rounds[0].found.artist, "Chitãozinho & Xororó");
assert.equal(st.rounds[0].found.title, undefined);
assert.equal(st.rounds[0].artist_team_id, A);
assert.equal(st.teams.find((t) => t.id === A).score, 40);
assert.equal(st.attempts.find((x) => x.id === ra.attempt_id).steal, true, "etiqueta de roubo continua");
assert.equal(st.rounds[0].locks[A], undefined, "acerto parcial não bloqueia");

// pausa congela o bloqueio
await rpc("npl_pause", code, PRES, true);
await db.query("update npl_rooms set paused_at = paused_at - interval '10 seconds' where code = $1", [code]);
await rpc("npl_pause", code, PRES, false);
st = await rpc("npl_get_state", code);
assert.ok(Date.parse(st.rounds[0].locks[B].until) - lockB >= 9500, "bloqueio andou junto com a pausa");
// o tempo de bloqueio passou: B volta a poder apertar
await db.query(`update npl_rounds set locks = jsonb_set(locks, array[$1::text, 'until'], to_jsonb(clock_timestamp() - interval '1 second')) where id = $2`, [B, R]);
const rb0 = await rpc("npl_buzz", code, P(2), R);
assert.equal(rb0.ok, true, "liberado depois do tempo");
assert.equal(await rpc("npl_decide", code, PRES, rb0.attempt_id, false, false), "wrong");
// B errou de novo (aguardando a música); A erra -> B é liberado na hora, A fica bloqueado
st = await rpc("npl_get_state", code);
assert.equal(st.rounds[0].locks[B].until, null);
const ra0 = await rpc("npl_buzz", code, P(1), R);
assert.equal(ra0.ok, true);
assert.equal(await rpc("npl_decide", code, PRES, ra0.attempt_id, false, false), "wrong");
st = await rpc("npl_get_state", code);
assert.equal(st.rounds[0].locks[B], undefined, "outro time errou: B liberado");
assert.ok(st.rounds[0].locks[A], "A bloqueado");
const rb1 = await rpc("npl_buzz", code, P(2), R);
assert.equal(rb1.ok, true, "B pode apertar");
assert.equal(await rpc("npl_decide", code, PRES, rb1.attempt_id, false, false), "wrong");
// desfaz essas duas tentativas extras (só testavam o bloqueio) para manter o placar do resto do teste
await db.query("delete from npl_attempts where id in ($1, $2)", [ra0.attempt_id, rb1.attempt_id]);
await db.query("select npl_rescore_round($1)", [R]);
await db.query("select npl_recalc_scores(room_id) from npl_rounds where id = $1", [R]);
st = await rpc("npl_get_state", code);
assert.deepEqual(Object.keys(st.rounds[0].locks), [B]);

// próximo trecho (60 pts) e o mesmo time A tenta a música: "Os dois" só conta a música
await rpc("npl_play", code, PRES, R, 2, true);
ra = await rpc("npl_buzz", code, P(1), R);
assert.equal(await rpc("npl_decide", code, PRES, ra.attempt_id, true, true), "correct");
st = await rpc("npl_get_state", code);
assert.equal(st.rounds[0].status, "revealed");
assert.equal(st.rounds[0].title_team_id, A);
assert.equal(st.rounds[0].reveal.title, "Evidências (Ao Vivo)");
assert.ok(st.rounds[0].reveal.artists.includes("Participação Especial"));
assert.equal(st.teams.find((t) => t.id === A).score, 40 + 60);
assert.equal(st.teams.find((t) => t.id === B).score, -40);

// inverter: o 1º erro de B na verdade acertou os dois (80*1.5 = 120, sem penalidade)
await rpc("npl_override_parts", code, PRES, r1.attempt_id, true, true);
st = await rpc("npl_get_state", code);
assert.equal(st.teams.find((t) => t.id === B).score, 120 - 20);
assert.equal(st.teams.find((t) => t.id === A).score, 0, "partes já eram de B: A fica sem pontos");
assert.equal(st.rounds[0].winner_team_id, B);
await rpc("npl_override_parts", code, PRES, r1.attempt_id, false, false);
st = await rpc("npl_get_state", code);
assert.equal(st.teams.find((t) => t.id === B).score, -40);
assert.equal(st.teams.find((t) => t.id === A).score, 100);

// bug da pausa na revelação: pausar, continuar e avançar sempre funciona
await rpc("npl_pause", code, PRES, true);
await rpc("npl_pause", code, PRES, false);
await rpc("npl_pause", code, PRES, true);
await rpc("npl_show_scoreboard", code, PRES, R); // avança mesmo pausado e tira a pausa
st = await rpc("npl_get_state", code);
assert.equal(st.rounds[0].status, "scoreboard");
assert.equal(st.room.paused, false);
await rpc("npl_pause", code, PRES, true);
await rpc("npl_next_round", code, PRES, 1);
await rpc("npl_next_round", code, PRES, 1);
st = await rpc("npl_get_state", code);
assert.equal(st.room.round_no, 2, "avançou uma vez só");
assert.equal(st.room.paused, false);
R = st.rounds[1].id;
await rpc("npl_round_begin", code, OWNER, R, [], []);

// apresentador sumiu: a TV pausa; ao voltar, retoma (mas não tira uma pausa dele)
await fails(rpc("npl_owner_away", code, PRES, true), "not_host");
await rpc("npl_owner_away", code, OWNER, true);
st = await rpc("npl_get_state", code);
assert.equal(st.room.paused, true);
assert.equal(st.room.pause_reason, "owner_away");
assert.equal((await rpc("npl_play", code, PRES, R, 1, false)).ok, false, "pausado não toca");
await rpc("npl_owner_away", code, OWNER, false);
st = await rpc("npl_get_state", code);
assert.equal(st.room.paused, false);
await rpc("npl_pause", code, PRES, true);
await rpc("npl_owner_away", code, OWNER, false);
st = await rpc("npl_get_state", code);
assert.equal(st.room.paused, true, "pausa do apresentador continua");
await rpc("npl_pause", code, PRES, false);

// ---------- com apresentador + digitada ----------
await db.query(`update npl_rooms set settings = settings || '{"answerMode":"typed"}' where code = $1`, [code]);
await rpc("npl_play", code, PRES, R, 1, false);
let rb = await rpc("npl_buzz", code, P(2), R);
// artista certo + música errada: ganha o artista (50), leva penalidade e bloqueio
let ans = await rpc("npl_submit_answer", code, P(3), rb.attempt_id, "Artista 2", "outra coisa totalmente");
assert.equal(ans.result, "partial");
assert.equal(ans.points, 50 - 20);
st = await rpc("npl_get_state", code);
assert.ok(st.rounds[1].locks[B]);
assert.equal(st.rounds[1].found.artist, "Artista 2");
// A: zona de dúvida na música (o artista já saiu, é ignorado) -> o apresentador decide
ra = await rpc("npl_buzz", code, P(1), R);
ans = await rpc("npl_submit_answer", code, P(1), ra.attempt_id, "qualquer", "Muziqa Nmro 2");
assert.equal(ans.result, "doubt");
st = await rpc("npl_get_state", code);
assert.equal(st.attempts.find((x) => x.id === ra.attempt_id).answer_artist, null);
await fails(rpc("npl_judge", code, P(2), ra.attempt_id, true), "not_owner");
assert.equal(await rpc("npl_judge", code, PRES, ra.attempt_id, true), "correct");
st = await rpc("npl_get_state", code);
assert.equal(st.rounds[1].status, "revealed");
assert.equal(st.teams.find((t) => t.id === A).score, 100 + 100);
assert.equal(st.teams.find((t) => t.id === B).score, -40 + 30);

// ---------- estilo "Todos jogam" (controles na TV, digitada, "Quase!") ----------
await db.query(`update npl_rooms set settings = settings || '{"roomStyle":"all"}' where code = $1`, [code]);
await rpc("npl_next_round", code, OWNER, 2); // a TV comanda
st = await rpc("npl_get_state", code);
R = st.rounds[2].id;
await rpc("npl_round_begin", code, OWNER, R, [], []);
assert.equal(await rpc("npl_host_answer", code, OWNER), null, "todos jogam: ninguém vê a resposta antes");
await rpc("npl_play", code, OWNER, R, 1, false);
ra = await rpc("npl_buzz", code, P(1), R);
ans = await rpc("npl_submit_answer", code, P(1), ra.attempt_id, "Artista 3", "Muziqa Nmro 3");
assert.equal(ans.result, "almost");
assert.equal(ans.title, "doubt");
st = await rpc("npl_get_state", code);
assert.equal(st.rounds[2].status, "answering", "a vez continua; nada vaza para a TV");
assert.equal(st.attempts.find((x) => x.id === ra.attempt_id).status, "open");
ans = await rpc("npl_submit_answer", code, P(1), ra.attempt_id, "Artista 3", "Musica Numero 3");
assert.equal(ans.result, "correct");
assert.equal(ans.points, 150);
// Contestar (TV, na revelação): inverte para "não valeu"
await rpc("npl_override_parts", code, OWNER, ra.attempt_id, false, false);
st = await rpc("npl_get_state", code);
assert.equal(st.teams.find((t) => t.id === A).score, 200 - 20);
await rpc("npl_override_parts", code, OWNER, ra.attempt_id, true, true);
st = await rpc("npl_get_state", code);
assert.equal(st.teams.find((t) => t.id === A).score, 350);

// "Quase!" e o tempo acaba: conta como erro
await rpc("npl_next_round", code, OWNER, 3);
st = await rpc("npl_get_state", code);
R = st.rounds[3].id;
await rpc("npl_round_begin", code, OWNER, R, [], []);
rb = await rpc("npl_buzz", code, P(2), R);
assert.equal((await rpc("npl_submit_answer", code, P(2), rb.attempt_id, "", "Muziqa Nmro 4")).result, "almost");
assert.equal(await rpc("npl_tick", code), false);
await db.query("update npl_attempts set deadline = clock_timestamp() - interval '5 seconds' where id = $1", [rb.attempt_id]);
assert.equal(await rpc("npl_tick", code), true);
st = await rpc("npl_get_state", code);
assert.equal(st.attempts.find((x) => x.id === rb.attempt_id).status, "timeout");
assert.ok(st.rounds[3].locks[B]);
assert.equal(st.teams.find((t) => t.id === B).score, -10 - 20);
await rpc("npl_pause", code, OWNER, true);
assert.equal((await rpc("npl_buzz", code, P(1), R)).reason, "paused");
await rpc("npl_pause", code, OWNER, false);

// último trecho: não avança mais; revela sem pontos
for (let s = 1; s <= 5; s++) assert.equal((await rpc("npl_play", code, OWNER, R, s, true)).ok, true);
assert.equal((await rpc("npl_play", code, OWNER, R, 6, true)).ok, false);
await rpc("npl_end_round", code, OWNER, R);
st = await rpc("npl_get_state", code);
assert.equal(st.rounds[3].status, "revealed");
assert.equal(st.rounds[3].skipped, false);
assert.equal(st.rounds[3].winner_team_id, null);

// jogador entra no meio: só joga a partir da próxima rodada
await rpc("npl_join", code, P(4), "Duda");
await rpc("npl_set_team", code, P(4), A);
await fails(rpc("npl_set_team", code, P(4), B), "team_locked");
await rpc("npl_next_round", code, OWNER, 4);
st = await rpc("npl_get_state", code);
R = st.rounds[4].id;
await rpc("npl_round_begin", code, OWNER, R, [], []);
assert.equal((await rpc("npl_buzz", code, P(4), R)).ok, true, "Duda joga na rodada 5");

// pular música e fim
await rpc("npl_skip_round", code, OWNER, R);
st = await rpc("npl_get_state", code);
assert.equal(st.rounds[4].skipped, true);
await rpc("npl_adjust_score", code, OWNER, A, 10);
await rpc("npl_next_round", code, OWNER, 5);
st = await rpc("npl_get_state", code);
assert.equal(st.room.phase, "finished");
assert.equal(st.teams.find((t) => t.id === A).score, 360);

// revanche zera o placar e mantém os times
await rpc("npl_start_match", code, OWNER, tracks);
st = await rpc("npl_get_state", code);
assert.equal(st.room.match_no, 2);
assert.deepEqual(st.teams.map((t) => t.score), [0, 0]);
assert.equal(st.teams.length, 2);

// "Só a música": música = 100%
await db.query(`update npl_rooms set settings = settings || '{"scoring":"title","roomStyle":"host","answerMode":"spoken"}' where code = $1`, [code]);
st = await rpc("npl_get_state", code);
R = st.rounds[0].id;
await rpc("npl_round_begin", code, OWNER, R, [], []);
rb = await rpc("npl_buzz", code, P(2), R);
assert.equal(await rpc("npl_decide", code, PRES, rb.attempt_id, true, false), "wrong", "artista não vale em 'só a música'");
ra = await rpc("npl_buzz", code, P(1), R);
assert.equal(await rpc("npl_decide", code, PRES, ra.attempt_id, false, true), "correct");
st = await rpc("npl_get_state", code);
assert.equal(st.teams.find((t) => t.id === A).score, 100);

// com apresentador: sem ele não começa; quem vira apresentador sai do time
const { code: code2 } = await rpc("npl_create_room", OWNER, { roomStyle: "host" });
await rpc("npl_join", code2, P(5), "Eva");
await rpc("npl_join", code2, P(6), "Fábio");
await rpc("npl_join", code2, P(7), "Gil");
await fails(rpc("npl_start_match", code2, OWNER, tracks), "no_owner");
await rpc("npl_open_claim", code2, OWNER, CLAIM);
await rpc("npl_claim_owner", code2, CLAIM, P(7));
st = await rpc("npl_get_state", code2);
assert.equal(st.players.length, 2, "apresentador não joga");
await rpc("npl_start_match", code2, P(7), tracks);
// todos jogam: começa sem apresentador
const { code: code3 } = await rpc("npl_create_room", OWNER, {});
await rpc("npl_join", code3, P(5), "Eva");
await rpc("npl_join", code3, P(6), "Fábio");
await rpc("npl_start_match", code3, OWNER, tracks);

// ---------- modo Leilão (3 times, todos jogam, digitada) ----------
{
  const { code: c4 } = await rpc("npl_create_room", OWNER, { mode: "auction", teamCount: 3, answerSeconds: 10, penalty: 50 });
  let s4 = await rpc("npl_get_state", c4);
  assert.equal(s4.room.settings.mode, "auction");
  await rpc("npl_update_settings", c4, OWNER, { modeSelection: "random", modePool: ["classic", "auction", "xx", "auction"] });
  assert.deepEqual((await rpc("npl_get_state", c4)).room.settings.modePool, ["classic", "auction"], "só modos conhecidos");
  await rpc("npl_update_settings", c4, OWNER, { mode: "bogus", modeSelection: "fixed", modePool: [] });
  assert.equal((await rpc("npl_get_state", c4)).room.settings.mode, "classic");
  await rpc("npl_update_settings", c4, OWNER, { mode: "auction", modePool: ["auction"] });
  const [pa, pb, pc] = [P(8), P(9), P(10)];
  await rpc("npl_join", c4, pa, "Ana");
  await rpc("npl_join", c4, pb, "Bia");
  await rpc("npl_join", c4, pc, "Cris");
  s4 = await rpc("npl_get_state", c4);
  const [TA, TB, TC] = s4.teams.map((t) => t.id);
  await rpc("npl_set_team", c4, pa, TA);
  await rpc("npl_set_team", c4, pb, TB);
  await rpc("npl_set_team", c4, pc, TC);
  await rpc("npl_start_match", c4, OWNER, tracks);
  s4 = await rpc("npl_get_state", c4);
  let R4 = s4.rounds[0].id;
  assert.equal(s4.rounds[0].mode, "auction");
  const meta = { genre: "Sertanejo", year: 2004, compilation: false };
  await rpc("npl_round_begin", c4, OWNER, R4, ["Convidado"], [], meta);
  s4 = await rpc("npl_get_state", c4);
  let au = s4.rounds[0].auction;
  assert.equal(au.hint, "artist", "primeira rodada: dica artista");
  assert.equal(au.artist, "Chitãozinho & Xororó");
  assert.ok(au.artists.includes("Convidado"));
  assert.equal(au.genre, null);
  assert.deepEqual(au.order, [TA, TB, TC]);
  assert.equal(au.turn, TA);
  const bid = (tok, secs) => rpc("npl_auction_bid", c4, tok, R4, secs);
  const startNow = async () =>
    db.query(`update npl_rounds set auction = auction || jsonb_build_object('starts_at', clock_timestamp() - interval '60 seconds') where id = $1`, [R4]);
  assert.equal((await bid(pa, 15)).reason, "not_started", "dica aparece antes dos lances");
  await startNow();
  assert.equal((await rpc("npl_buzz", c4, pa, R4)).reason, "auction");
  assert.equal((await rpc("npl_play", c4, OWNER, R4, 1, false)).ok, false, "sem trechos do clássico");
  assert.equal((await bid(pb, 15)).reason, "not_your_turn");
  assert.equal((await bid(pa, 20)).reason, "bad_bid");
  assert.equal((await bid(pa, 0)).reason, "bad_bid");
  assert.equal((await bid(pa, 15)).ok, true);
  assert.equal((await bid(pb, 15)).reason, "bad_bid", "tem que ser menor");
  assert.equal((await bid(pb, 12)).ok, true);
  assert.equal((await bid(pc, null)).ok, true, "C: pode tocar");
  au = (await rpc("npl_get_state", c4)).rounds[0].auction;
  assert.equal(au.turn, TA, "volta para A (B tem o menor lance)");
  assert.equal(au.phase, "bidding");
  assert.equal((await bid(pa, null)).phase, "proving", "todos os outros disseram pode tocar");
  s4 = await rpc("npl_get_state", c4);
  au = s4.rounds[0].auction;
  assert.deepEqual(au.queue, [{ team: TB, secs: 12 }, { team: TA, secs: 15 }, { team: TC, secs: 20 }]);
  assert.equal(au.winner, TB);
  assert.equal(au.log.length, 4);
  // prova: B ouve 12 s
  await fails(rpc("npl_auction_play", c4, pa, R4, 0), "not_owner");
  assert.equal((await rpc("npl_auction_play", c4, OWNER, R4, 1)).ok, false, "posição errada");
  const play0 = await rpc("npl_auction_play", c4, OWNER, R4, 0);
  assert.equal(play0.ok, true);
  assert.equal((await rpc("npl_auction_play", c4, OWNER, R4, 0)).ok, false, "uma vez só");
  s4 = await rpc("npl_get_state", c4);
  let att = s4.attempts.find((x) => x.id === play0.attempt_id);
  assert.equal(att.team_id, TB);
  assert.equal(att.stage, 12);
  assert.ok(Math.abs(Date.parse(att.deadline) - s4.server_now - 22000) < 2000, "prazo = 12 s de trecho + 10 s de resposta");
  assert.equal(s4.rounds[0].status, "answering");
  assert.equal((await rpc("npl_submit_answer", c4, pa, play0.attempt_id, "", "Evidências")).reason, "not_your_team");
  // B erra (o artista não vale nesta rodada): sem penalidade, vez passa para A
  let an = await rpc("npl_submit_answer", c4, pb, play0.attempt_id, "Chitãozinho & Xororó", "Outra Música Qualquer");
  assert.equal(an.result, "wrong");
  assert.equal(an.points, 0, "sem penalidade no leilão");
  s4 = await rpc("npl_get_state", c4);
  assert.equal(s4.rounds[0].status, "playing");
  assert.equal(s4.rounds[0].auction.qidx, 1);
  assert.equal(s4.attempts.find((x) => x.id === play0.attempt_id).answer_artist, null, "artista não é conferido");
  // A: "Quase!" e depois acerta -> 100 fixos
  const play1 = await rpc("npl_auction_play", c4, OWNER, R4, 1);
  assert.equal((await rpc("npl_submit_answer", c4, pa, play1.attempt_id, "", "Evixxxcias")).result, "almost");
  an = await rpc("npl_submit_answer", c4, pa, play1.attempt_id, "", "Evidências");
  assert.equal(an.result, "correct");
  assert.equal(an.points, 100);
  s4 = await rpc("npl_get_state", c4);
  assert.equal(s4.rounds[0].status, "revealed");
  assert.equal(s4.rounds[0].title_team_id, TA);
  assert.equal(s4.teams.find((t) => t.id === TA).score, 100);
  assert.equal(s4.teams.find((t) => t.id === TB).score, 0);

  // rodada 2: dica gênero/ano, quem abre gira (B); ninguém dá lance; turno vencido = "Pode tocar!"
  await rpc("npl_next_round", c4, OWNER, 1);
  s4 = await rpc("npl_get_state", c4);
  R4 = s4.rounds[1].id;
  await rpc("npl_round_begin", c4, OWNER, R4, [], [], meta);
  s4 = await rpc("npl_get_state", c4);
  au = s4.rounds[1].auction;
  assert.equal(au.hint, "genre");
  assert.equal(au.genre, "Sertanejo");
  assert.equal(au.year, 2004);
  assert.equal(au.artist, null, "artista escondido");
  assert.equal(au.artists, null);
  assert.deepEqual(au.order, [TB, TC, TA], "rodízio");
  await startNow();
  assert.equal(await rpc("npl_tick", c4), false);
  // pausa congela o turno
  await rpc("npl_pause", c4, OWNER, true);
  assert.equal((await bid(pb, 10)).reason, "paused");
  await db.query("update npl_rooms set paused_at = paused_at - interval '10 seconds' where code = $1", [c4]);
  await rpc("npl_pause", c4, OWNER, false);
  const au2 = (await rpc("npl_get_state", c4)).rounds[1].auction;
  assert.ok(Date.parse(au2.turn_deadline) - Date.parse(au.turn_deadline) >= 9500, "turno andou junto com a pausa");
  await db.query(`update npl_rounds set auction = auction || jsonb_build_object('turn_deadline', clock_timestamp() - interval '2 seconds') where id = $1`, [R4]);
  assert.equal(await rpc("npl_tick", c4), true);
  au = (await rpc("npl_get_state", c4)).rounds[1].auction;
  assert.equal(au.turn, TC, "tempo esgotado conta como pode tocar");
  assert.equal((await bid(pc, null)).ok, true);
  assert.equal((await bid(pa, null)).phase, "proving");
  au = (await rpc("npl_get_state", c4)).rounds[1].auction;
  assert.deepEqual(au.queue, [{ team: TB, secs: 20 }, { team: TC, secs: 20 }, { team: TA, secs: 20 }], "sem lances: todos 20 s no rodízio");
  assert.equal(au.winner, null);
  // B: tempo esgotado -> C; C acerta o artista (vale) -> 100
  const pl0 = await rpc("npl_auction_play", c4, OWNER, R4, 0);
  await db.query("update npl_attempts set deadline = clock_timestamp() - interval '5 seconds' where id = $1", [pl0.attempt_id]);
  assert.equal(await rpc("npl_tick", c4), true);
  s4 = await rpc("npl_get_state", c4);
  assert.equal(s4.attempts.find((x) => x.id === pl0.attempt_id).status, "timeout");
  assert.equal(s4.rounds[1].auction.qidx, 1);
  const pl1 = await rpc("npl_auction_play", c4, OWNER, R4, 1);
  assert.equal((await rpc("npl_submit_answer", c4, pc, pl1.attempt_id, "", "Musica Numero 2")).reason, "empty", "música não vale aqui");
  an = await rpc("npl_submit_answer", c4, pc, pl1.attempt_id, "Artista 2", "");
  assert.equal(an.result, "correct");
  s4 = await rpc("npl_get_state", c4);
  assert.equal(s4.rounds[1].artist_team_id, TC);
  assert.equal(s4.rounds[1].found.artist, "Artista 2");
  assert.equal(s4.teams.find((t) => t.id === TC).score, 100);

  // rodada 3: volta a dica artista; lance de 1 s fecha na hora; todos erram -> revela sem pontos
  await rpc("npl_next_round", c4, OWNER, 2);
  s4 = await rpc("npl_get_state", c4);
  R4 = s4.rounds[2].id;
  await rpc("npl_round_begin", c4, OWNER, R4, [], [], meta);
  au = (await rpc("npl_get_state", c4)).rounds[2].auction;
  assert.equal(au.hint, "artist");
  assert.equal(au.turn, TC);
  await startNow();
  assert.equal((await bid(pc, 1)).phase, "proving", "1 s ninguém cobre");
  au = (await rpc("npl_get_state", c4)).rounds[2].auction;
  assert.deepEqual(au.queue, [{ team: TC, secs: 1 }, { team: TA, secs: 20 }, { team: TB, secs: 20 }]);
  for (let i = 0; i < 3; i++) {
    const pl = await rpc("npl_auction_play", c4, OWNER, R4, i);
    await rpc("npl_end_turn", c4, OWNER, pl.attempt_id);
  }
  s4 = await rpc("npl_get_state", c4);
  assert.equal(s4.rounds[2].status, "revealed");
  assert.equal(s4.rounds[2].winner_team_id, null);

  // rodada 4: queria gênero, mas é coletânea -> dica artista; falada: "artista certo" não vale
  await rpc("npl_next_round", c4, OWNER, 3);
  s4 = await rpc("npl_get_state", c4);
  R4 = s4.rounds[3].id;
  await rpc("npl_round_begin", c4, OWNER, R4, [], [], { ...meta, compilation: true });
  au = (await rpc("npl_get_state", c4)).rounds[3].auction;
  assert.equal(au.hint, "artist", "coletânea: dica artista");
  await startNow();
  await bid(pa, 5);
  await bid(pb, null);
  assert.equal((await bid(pc, null)).phase, "proving");
  const pl = await rpc("npl_auction_play", c4, OWNER, R4, 0);
  assert.equal(await rpc("npl_decide", c4, OWNER, pl.attempt_id, true, false), "wrong");
  const pl2 = await rpc("npl_auction_play", c4, OWNER, R4, 1);
  assert.equal(await rpc("npl_decide", c4, OWNER, pl2.attempt_id, false, true), "correct");
  // contestar: o primeiro na verdade acertou -> os 100 vão para ele
  await rpc("npl_override_parts", c4, OWNER, pl.attempt_id, false, true);
  s4 = await rpc("npl_get_state", c4);
  assert.equal(s4.rounds[3].title_team_id, TA);
  assert.equal(s4.teams.find((t) => t.id === TA).score, 200);
  assert.equal(s4.teams.find((t) => t.id === TB).score, 0);
  console.log("ok leilão");
}

// ---------- desempate (morte súbita) ----------
{
  const { code: c5 } = await rpc("npl_create_room", OWNER, { rounds: 5, teamCount: 3, answerSeconds: 10, penalty: 50 });
  let s5 = await rpc("npl_get_state", c5);
  assert.equal(s5.room.settings.tiebreak, "sudden", "padrão: morte súbita");
  assert.equal(s5.room.settings.versionFilter, true, "padrão: filtro de versões ligado");
  await rpc("npl_update_settings", c5, OWNER, { tiebreak: "xx", versionFilter: "sim" });
  s5 = await rpc("npl_get_state", c5);
  assert.equal(s5.room.settings.tiebreak, "sudden");
  assert.equal(s5.room.settings.versionFilter, true);
  await rpc("npl_update_settings", c5, OWNER, { versionFilter: false });
  assert.equal((await rpc("npl_get_state", c5)).room.settings.versionFilter, false);

  const [qa, qb, qc] = [P(20), P(21), P(22)];
  await rpc("npl_join", c5, qa, "Ana");
  await rpc("npl_join", c5, qb, "Bia");
  await rpc("npl_join", c5, qc, "Cris");
  s5 = await rpc("npl_get_state", c5);
  const [TA, TB, TC] = s5.teams.map((t) => t.id);
  await rpc("npl_set_team", c5, qa, TA);
  await rpc("npl_set_team", c5, qb, TB);
  await rpc("npl_set_team", c5, qc, TC);
  const mk = (n) => Array.from({ length: n }, (_, i) => ({
    deezer_id: 5000 + i, title: `Faixa Numero ${i + 1}`, title_short: `Faixa Numero ${i + 1}`,
    artist: `Cantor ${i + 1}`, artists: [`Cantor ${i + 1}`], cover: "x",
  }));
  const cur = async () => {
    const s = await rpc("npl_get_state", c5);
    return { s, r: s.rounds.find((x) => x.round_no === s.room.round_no) };
  };
  // pula todas as músicas normais -> todos empatados com 0
  const skipAll = async () => {
    for (;;) {
      const { s, r } = await cur();
      if (r.round_no > s.room.total_rounds) return;
      await rpc("npl_skip_round", c5, OWNER, r.id);
      await rpc("npl_next_round", c5, OWNER, r.round_no);
      if ((await rpc("npl_get_state", c5)).room.phase !== "playing") return;
    }
  };

  // 7 músicas para 5 rodadas: 2 de reserva
  const st5 = await rpc("npl_start_match", c5, OWNER, mk(7));
  assert.equal(st5.total_rounds, 5);
  assert.equal(st5.reserve, 2);
  await skipAll();
  let { s, r } = await cur();
  assert.equal(s.room.phase, "playing", "empate -> morte súbita");
  assert.equal(r.round_no, 6);
  assert.equal(r.mode, "classic");
  assert.deepEqual(r.tiebreak.teams, [TA, TB, TC]);
  assert.equal(r.tiebreak.n, 1);
  await rpc("npl_round_begin", c5, OWNER, r.id, [], []);
  await rpc("npl_play", c5, OWNER, r.id, 1, false);
  // A erra -> fora (sem bloqueio por tempo, sem penalidade)
  let bz = await rpc("npl_buzz", c5, qa, r.id);
  assert.equal(bz.ok, true);
  assert.equal((await rpc("npl_submit_answer", c5, qa, bz.attempt_id, "Cantor 6", "")).reason, "empty", "artista não vale no desempate");
  await rpc("npl_submit_answer", c5, qa, bz.attempt_id, "", "outra coisa");
  ({ s, r } = await cur());
  assert.equal(r.status, "playing");
  assert.deepEqual(r.tiebreak.out, [TA]);
  assert.deepEqual(r.locks, {}, "sem bloqueio no desempate");
  assert.equal(s.teams.find((t) => t.id === TA).score, 0, "sem penalidade no desempate");
  assert.equal((await rpc("npl_buzz", c5, qa, r.id)).reason, "tiebreak", "quem errou está fora");
  // B acerta -> vence; pontos não entram no placar
  bz = await rpc("npl_buzz", c5, qb, r.id);
  assert.equal((await rpc("npl_submit_answer", c5, qb, bz.attempt_id, "", "Faixa Numero 6")).result, "correct");
  ({ s, r } = await cur());
  assert.equal(r.status, "revealed");
  assert.equal(r.winner_team_id, TB);
  assert.deepEqual(s.teams.map((t) => t.score), [0, 0, 0], "desempate não pontua");
  await rpc("npl_next_round", c5, OWNER, 6);
  assert.equal((await rpc("npl_get_state", c5)).room.phase, "finished");

  // revanche: ninguém acerta -> outra música; dois erram -> sobra um e ele vence
  await rpc("npl_update_settings", c5, OWNER, { rounds: 5 });
  await rpc("npl_start_match", c5, OWNER, mk(7));
  await rpc("npl_adjust_score", c5, OWNER, TC, -10); // C fica fora do empate
  await skipAll();
  ({ s, r } = await cur());
  assert.deepEqual(r.tiebreak.teams, [TA, TB], "só os empatados no 1º lugar");
  assert.equal((await rpc("npl_buzz", c5, qc, r.id)).reason, "tiebreak");
  await rpc("npl_round_begin", c5, OWNER, r.id, [], []);
  await rpc("npl_end_round", c5, OWNER, r.id); // ninguém acertou
  await rpc("npl_next_round", c5, OWNER, 6);
  ({ s, r } = await cur());
  assert.equal(r.round_no, 7, "mais uma música de desempate");
  assert.deepEqual(r.tiebreak.teams, [TA, TB]);
  assert.equal(r.tiebreak.n, 2);
  await rpc("npl_round_begin", c5, OWNER, r.id, [], []);
  bz = await rpc("npl_buzz", c5, qa, r.id);
  await rpc("npl_end_turn", c5, OWNER, bz.attempt_id);
  ({ s, r } = await cur());
  assert.equal(r.status, "revealed", "sobrou um só time");
  assert.equal(r.tiebreak.survivor, TB);
  assert.equal(r.winner_team_id, null);
  await rpc("npl_next_round", c5, OWNER, 7);
  assert.equal((await rpc("npl_get_state", c5)).room.phase, "finished");

  // sem música reserva: fica o empate
  await rpc("npl_start_match", c5, OWNER, mk(6));
  await skipAll();
  ({ s, r } = await cur());
  assert.equal(r.round_no, 6);
  await rpc("npl_skip_round", c5, OWNER, r.id);
  await rpc("npl_next_round", c5, OWNER, 6);
  assert.equal((await rpc("npl_get_state", c5)).room.phase, "finished", "acabaram as reservas");

  // aceitar empate: termina na última música
  await rpc("npl_update_settings", c5, OWNER, { tiebreak: "accept" });
  await rpc("npl_start_match", c5, OWNER, mk(7));
  await skipAll();
  s = await rpc("npl_get_state", c5);
  assert.equal(s.room.phase, "finished");
  assert.equal(s.room.round_no, 5);
  console.log("ok desempate");
}

// ---------- modo "Só pela letra" ----------
{
  const { code: c6 } = await rpc("npl_create_room", OWNER, { mode: "lyrics", modePool: ["lyrics"], rounds: 5, answerSeconds: 10 });
  let s6 = await rpc("npl_get_state", c6);
  assert.equal(s6.room.settings.mode, "lyrics", "modo letra aceito");
  const [la, lb] = [P(30), P(31)];
  await rpc("npl_join", c6, la, "Ana");
  await rpc("npl_join", c6, lb, "Bia");
  s6 = await rpc("npl_get_state", c6);
  const [TA, TB] = s6.teams.map((t) => t.id);
  await rpc("npl_set_team", c6, la, TA);
  await rpc("npl_set_team", c6, lb, TB);
  const verses = (i) => ({
    masked: [[`linha a${i}`, `linha b${i}`], [`linha c${i}`, `linha d${i}`], [`refrão ___ ${i}`, "de novo"]],
    plain: [[`linha a${i}`, `linha b${i}`], [`linha c${i}`, `linha d${i}`], [`refrão Canção ${i}`, "de novo"]],
  });
  const lt = [1, 2, 3, 4].map((i) => ({
    deezer_id: 7000 + i, title: `Canção ${i}`, title_short: `Canção ${i}`, artist: `Banda ${i}`, artists: [`Banda ${i}`], cover: "x",
    lyrics: verses(i),
  }));
  // só 4 com letra: a TV avisa e começa com 4
  const st6 = await rpc("npl_start_match", c6, OWNER, lt, 4);
  assert.equal(st6.total_rounds, 4);
  s6 = await rpc("npl_get_state", c6);
  let r6 = s6.rounds[0];
  assert.equal(r6.mode, "lyrics");
  assert.deepEqual(r6.lyrics, {}, "nada da letra antes de abrir");
  assert.ok(!JSON.stringify(s6).includes("linha a"), "letra não vaza no estado");
  await rpc("npl_round_begin", c6, OWNER, r6.id, [], [], {});
  s6 = await rpc("npl_get_state", c6);
  r6 = s6.rounds[0];
  assert.equal(r6.lyrics.total, 3);
  assert.equal(r6.lyrics.shown.length, 1, "1º verso aparece");
  assert.ok(!JSON.stringify(s6).includes("linha c"), "só os versos revelados");
  assert.equal(r6.lyrics.plain, undefined);
  assert.equal((await rpc("npl_play", c6, OWNER, r6.id, 1, false)).ok, false, "sem tocar no modo letra");
  // erro no 1º verso: bloqueio aguarda o próximo verso
  let bz6 = await rpc("npl_buzz", c6, la, r6.id);
  assert.equal(bz6.ok, true);
  await rpc("npl_submit_answer", c6, la, bz6.attempt_id, "", "nada a ver");
  s6 = await rpc("npl_get_state", c6);
  assert.equal(s6.rounds[0].locks[TA].until, null, "aguardando o próximo verso");
  const adv = await rpc("npl_play", c6, OWNER, r6.id, 1, true);
  assert.equal(adv.ok, true);
  assert.equal(adv.round.lyrics.shown.length, 2);
  assert.ok(adv.round.locks[TA].until, "contagem começou com o novo verso");
  bz6 = await rpc("npl_buzz", c6, lb, r6.id);
  const res6 = await rpc("npl_submit_answer", c6, lb, bz6.attempt_id, "", "Canção 1");
  assert.equal(res6.result, "partial", "música certa, falta o artista");
  assert.equal(res6.points, 75, "2 versos = 75");
  await rpc("npl_play", c6, OWNER, r6.id, 2, true);
  assert.equal((await rpc("npl_play", c6, OWNER, r6.id, 3, true)).ok, false, "acabaram os versos");
  await rpc("npl_end_round", c6, OWNER, r6.id);
  s6 = await rpc("npl_get_state", c6);
  assert.equal(s6.rounds[0].lyrics.plain[2][0], "refrão Canção 1", "revelação mostra sem ___");

  // misturar: música sem letra nunca cai no modo letra
  const room6 = (await sql("select id, match_no from npl_rooms where code = $1", [c6]))[0];
  room6.settings = { modeSelection: "random", modePool: ["lyrics", "classic", "auction"], mode: "lyrics" };
  await sql("insert into npl_tracks (room_id, match_no, position, deezer_id, title, artist) values ($1, $2, 99, 1, 'x', 'y')", [room6.id, room6.match_no]);
  const picks = new Set();
  for (let i = 0; i < 40; i++) picks.add((await sql("select public.npl_round_mode($1, $2, 99, $3) as m", [room6.id, room6.match_no, room6.settings]))[0].m);
  assert.ok(!picks.has("lyrics"), "sem letra -> outro modo");
  assert.ok(picks.size >= 2, "sorteia entre os outros");
  const lp = new Set();
  for (let i = 0; i < 40; i++) lp.add((await sql("select public.npl_round_mode($1, $2, 1, $3) as m", [room6.id, room6.match_no, room6.settings]))[0].m);
  assert.ok(lp.has("lyrics"), "com letra pode cair no modo letra");
  console.log("ok modo letra");
}

// ---------- ícones ----------
{
  const { code: c7 } = await rpc("npl_create_room", OWNER, { teamCount: 3 });
  const [ia, ib] = [P(40), P(41)];
  await rpc("npl_join", c7, ia, "Ana");
  await rpc("npl_join", c7, ib, "Bia");
  let s7 = await rpc("npl_get_state", c7);
  const icons = (await sql("select public.npl_icons() as a"))[0].a;
  assert.ok(s7.teams.every((t) => icons.includes(t.icon)), "time nasce com ícone");
  assert.equal(new Set(s7.teams.map((t) => t.icon)).size, 3, "ícones diferentes na sala");
  assert.ok(s7.players.every((p) => icons.includes(p.icon)), "jogador nasce com ícone");
  await rpc("npl_set_icon", c7, ia, "🦖");
  await fails(rpc("npl_set_icon", c7, ia, "lol"), "bad_icon");
  const [TA, TB] = s7.teams.map((t) => t.id);
  await rpc("npl_set_team", c7, ia, TA);
  await rpc("npl_set_team_icon", c7, ia, TA, "🌮");
  await fails(rpc("npl_set_team_icon", c7, ib, TA, "🍕"), "not_allowed");
  await rpc("npl_set_team_icon", c7, OWNER, TB, "🍕");
  s7 = await rpc("npl_get_state", c7);
  assert.equal(s7.players.find((p) => p.nickname === "Ana").icon, "🦖");
  assert.equal(s7.teams.find((t) => t.id === TA).icon, "🌮");
  assert.equal(s7.teams.find((t) => t.id === TB).icon, "🍕");
  // cada um por si: o time usa o ícone do jogador
  await rpc("npl_update_settings", c7, OWNER, { teamMode: "solo" });
  await rpc("npl_set_icon", c7, ib, "👽");
  s7 = await rpc("npl_get_state", c7);
  const bia = s7.players.find((p) => p.nickname === "Bia");
  assert.equal(s7.teams.find((t) => t.id === bia.team_id).icon, "👽");
  console.log("ok ícones");
}

// ---------- vários modos ligados (modo planejado por música) ----------
{
  const { code: c8 } = await rpc("npl_create_room", OWNER, {
    mode: "classic", modeSelection: "random", modePool: ["classic", "auction", "lyrics"], modeOrder: "blocks", rounds: 5,
  });
  let s8 = await rpc("npl_get_state", c8);
  assert.equal(s8.room.settings.modeOrder, "blocks");
  await rpc("npl_update_settings", c8, OWNER, { modeOrder: "zig" });
  assert.equal((await rpc("npl_get_state", c8)).room.settings.modeOrder, "alternate", "padrão: alternando");
  await rpc("npl_join", c8, P(50), "Ana");
  await rpc("npl_join", c8, P(51), "Bia");
  s8 = await rpc("npl_get_state", c8);
  await rpc("npl_set_team", c8, P(50), s8.teams[0].id);
  await rpc("npl_set_team", c8, P(51), s8.teams[1].id);
  const v = { masked: [["a", "b"], ["c", "d"], ["e", "f"]], plain: [["a", "b"], ["c", "d"], ["e", "f"]] };
  const plan = ["auction", "classic", "lyrics", "lyrics", "classic"];
  const tr8 = plan.map((m, i) => ({
    deezer_id: 9000 + i, title: `T${i}`, title_short: `T${i}`, artist: "A", artists: ["A"], cover: "x", mode: m,
    lyrics: i === 2 ? v : undefined, // a 4ª (lyrics) está sem letra -> vira outro modo
  }));
  await rpc("npl_start_match", c8, OWNER, tr8, 5);
  const modes = [];
  for (let i = 1; i <= 5; i++) {
    s8 = await rpc("npl_get_state", c8);
    const r = s8.rounds.find((x) => x.round_no === i);
    modes.push(r.mode);
    await rpc("npl_skip_round", c8, OWNER, r.id);
    await rpc("npl_next_round", c8, OWNER, i);
  }
  assert.deepEqual(modes.slice(0, 3), ["auction", "classic", "lyrics"], "segue o plano");
  assert.notEqual(modes[3], "lyrics", "sem letra não cai no modo letra");
  assert.equal(modes[4], "classic");
  console.log("ok vários modos");
}

// ---------- tema e cor do time ----------
{
  const { code: c9 } = await rpc("npl_create_room", OWNER, { theme: "neon" });
  let s9 = await rpc("npl_get_state", c9);
  assert.equal(s9.room.settings.theme, "neon");
  await rpc("npl_update_settings", c9, OWNER, { theme: "disco" });
  assert.equal((await rpc("npl_get_state", c9)).room.settings.theme, "party", "tema inválido -> padrão");
  await rpc("npl_join", c9, P(60), "Ana");
  s9 = await rpc("npl_get_state", c9);
  const [t1, t2] = s9.teams;
  await rpc("npl_set_team", c9, P(60), t1.id);
  assert.match(t1.name, /^Time /);
  await rpc("npl_set_team_color", c9, P(60), t1.id, "#A855F7"); // Roxo
  s9 = await rpc("npl_get_state", c9);
  assert.equal(s9.teams.find((t) => t.id === t1.id).color, "#A855F7");
  assert.equal(s9.teams.find((t) => t.id === t1.id).name, "Time Roxo", "nome padrão acompanha a cor");
  await fails(rpc("npl_set_team_color", c9, P(60), t1.id, t2.color), "color_taken");
  await fails(rpc("npl_set_team_color", c9, P(60), t1.id, "#123456"), "bad_color");
  await fails(rpc("npl_set_team_color", c9, P(60), t2.id, "#F97316"), "not_allowed");
  await rpc("npl_rename_team", c9, P(60), t1.id, "Os Brabos");
  await rpc("npl_set_team_color", c9, OWNER, t1.id, "#F97316");
  assert.equal((await rpc("npl_get_state", c9)).teams.find((t) => t.id === t1.id).name, "Os Brabos", "nome próprio fica");
  console.log("ok tema e cores");
}

// ---------- modo "Continuar a letra" ----------
{
  const cl = async (a, t) => (await sql("select public.npl_classify_line($1, $2) as r", [a, t]))[0].r;
  const L = "E o que foi prometido ninguém prometeu";
  assert.equal(await cl("e o que foi prometido ninguem prometeu", L), "ok");
  assert.equal(await cl("o que foi prometido ninguem", L), "ok", "70%+ das palavras na ordem");
  assert.equal(await cl("o que foi prometido", L), "doubt", "entre 50% e 70% = quase");
  assert.equal(await cl("ninguem prometeu", L), "wrong");
  assert.equal(await cl("prometeu ninguém prometido foi que o e", L), "wrong", "fora de ordem não vale");
  assert.equal(await cl("e o que foi prometdo ninguem prometeu", L), "ok", "erro de digitação");
  assert.equal(await cl("", L), "empty");
  assert.equal(await cl("dont stop me now", "Don't stop me now"), "ok");

  const { code: cc } = await rpc("npl_create_room", OWNER, { mode: "continue", modePool: ["continue"], rounds: 5, answerSeconds: 10, penalty: 50, scoring: "artist_title" });
  let sc = await rpc("npl_get_state", cc);
  assert.equal(sc.room.settings.mode, "continue");
  await rpc("npl_join", cc, P(70), "Ana");
  await rpc("npl_join", cc, P(71), "Bia");
  sc = await rpc("npl_get_state", cc);
  const [CA, CB] = sc.teams.map((t) => t.id);
  await rpc("npl_set_team", cc, P(70), CA);
  await rpc("npl_set_team", cc, P(71), CB);
  const cont = {
    lines: [
      { text: "Todos os dias quando acordo", start: 1, end: 4 },
      { text: "Não tenho mais o tempo que passou", start: 4, end: 8 },
      { text: "Mas tenho muito tempo", start: 8.5, end: 11 },
      { text: "Temos todo o tempo do mundo", start: 11, end: 14.5 },
    ],
    hidden: { text: L, start: 15, end: 18.2 },
    after: [{ text: "Depois vem esta", start: 18.2, end: 22 }, { text: "E mais esta aqui", start: 22, end: 26 }],
  };
  const ct = [1, 2, 3].map((i) => ({
    deezer_id: 9500 + i, title: `Faixa ${i}`, title_short: `Faixa ${i}`, artist: "Banda", artists: ["Banda"], cover: "x",
    mode: "continue", cont: i === 3 ? { lines: [], hidden: {} } : cont,
  }));
  await rpc("npl_start_match", cc, OWNER, ct, 3);
  sc = await rpc("npl_get_state", cc);
  let rc = sc.rounds[0];
  assert.equal(rc.mode, "continue");
  await rpc("npl_round_begin", cc, OWNER, rc.id, [], [], {});
  sc = await rpc("npl_get_state", cc);
  rc = sc.rounds[0];
  assert.equal(rc.cont.ctx, 4, "trecho único: todas as linhas desde a 1ª completa");
  assert.equal(rc.cont.max, 1);
  assert.equal(rc.cont.lines[0].text, "Todos os dias quando acordo");
  assert.equal(rc.cont.after, undefined, "linhas seguintes só na revelação");
  assert.ok(!JSON.stringify(sc).includes("Depois vem"), "linhas seguintes não vazam");
  assert.equal(rc.cont.hidden.words, 7, "nº de palavras da escondida");
  assert.ok(!JSON.stringify(sc).includes("prometido"), "linha escondida não vaza");
  // tocar e erro: bloqueio aguarda a música voltar
  assert.equal((await rpc("npl_play", cc, OWNER, rc.id, 1, false)).ok, true);
  let bc = await rpc("npl_buzz", cc, P(70), rc.id);
  assert.equal((await rpc("npl_submit_answer", cc, P(70), bc.attempt_id, "", "o que foi prometido")).result, "almost", "quase");
  await rpc("npl_submit_answer", cc, P(70), bc.attempt_id, "", "nada a ver com nada");
  sc = await rpc("npl_get_state", cc);
  assert.equal(sc.teams.find((t) => t.id === CA).score, -50, "penalidade vale no Continuar a letra");
  assert.equal(sc.rounds[0].locks[CA].until, null, "aguardando tocar de novo");
  assert.equal((await rpc("npl_play", cc, OWNER, rc.id, 1, true)).ok, false, "sem 'Mais contexto'");
  const again = await rpc("npl_play", cc, OWNER, rc.id, 1, false); // repetir
  assert.equal(again.ok, true);
  assert.ok(again.round.locks[CA].until, "contagem começou ao tocar de novo");
  bc = await rpc("npl_buzz", cc, P(71), rc.id);
  const rr = await rpc("npl_submit_answer", cc, P(71), bc.attempt_id, "", "e o que foi prometido ninguem prometeu");
  assert.equal(rr.result, "correct", "só a linha vale (mesmo com 'Artista e música')");
  assert.equal(rr.points, 100, "acerto vale 100 fixos (mesmo depois de repetir)");
  sc = await rpc("npl_get_state", cc);
  assert.equal(sc.rounds[0].status, "revealed");
  assert.equal(sc.rounds[0].cont.reveal.text, L, "revelação mostra a linha");
  assert.equal(Number(sc.rounds[0].cont.reveal.end), 18.2);
  assert.deepEqual(sc.rounds[0].cont.after.map((l) => l.text), ["Depois vem esta", "E mais esta aqui"], "cantar junto");
  await fails(rpc("npl_cont_skip", cc, P(70), rc.id), "not_owner");
  await rpc("npl_cont_skip", cc, OWNER, rc.id);
  assert.equal((await rpc("npl_get_state", cc)).rounds[0].cont.sung, true, "pula para a revelação normal");
  // apresentador vê a linha certa
  await rpc("npl_next_round", cc, OWNER, 1);
  // música sem dados válidos não entra no modo
  await rpc("npl_next_round", cc, OWNER, 1);
  sc = await rpc("npl_get_state", cc);
  console.log("ok continuar a letra");
}

// ---------- cache da sincronização e preparação em segundo plano ----------
{
  const { code: cs } = await rpc("npl_create_room", OWNER, { modeSelection: "random", modePool: ["classic", "continue"], rounds: 5 });
  const entry = { deezer_id: 777, algo: 1, ok: true, offset: 48.2, line_count: 30, lines: [{ i: 3, s: 4.3, e: 8.9, u: 8.1 }], eligible: [5, 7], confidence: 92 };
  await fails(rpc("npl_sync_put", cs, P(80), entry), "not_owner");
  await rpc("npl_sync_put", cs, OWNER, entry);
  await rpc("npl_sync_put", cs, OWNER, { ...entry, deezer_id: 778, ok: false, reason: "pouca música antes", lines: [], eligible: [] });
  const got = await rpc("npl_sync_get", [777, 778, 999]);
  assert.equal(got.length, 2);
  assert.equal(got.find((c) => c.deezer_id == 777).eligible[0], 5);
  assert.equal(got.find((c) => c.deezer_id == 778).ok, false, "descartada também fica no cache");
  assert.ok(!JSON.stringify(got).includes("text"), "sem letra no cache");
  await db.exec("set role anon");
  await fails(db.query("select * from public.npl_sync_cache"), "permission denied");
  await db.exec("reset role");

  await rpc("npl_join", cs, P(81), "Ana");
  await rpc("npl_join", cs, P(82), "Bia");
  let ss = await rpc("npl_get_state", cs);
  await rpc("npl_set_team", cs, P(81), ss.teams[0].id);
  await rpc("npl_set_team", cs, P(82), ss.teams[1].id);
  const tr = [1, 2, 3, 4].map((i) => ({ deezer_id: 9700 + i, title: `T${i}`, title_short: `T${i}`, artist: "A", artists: ["A"], cover: "x", mode: i === 3 ? "continue" : "classic" }));
  const st = await rpc("npl_start_match", cs, OWNER, tr, 4);
  const plan = { lines: [{ text: "linha um aqui", start: 1, end: 5 }, { text: "linha dois aqui", start: 5, end: 11 }], hidden: { text: "a linha escondida certa", start: 12, end: 15 }, after: [] };
  const filled = await rpc("npl_fill_cont", cs, OWNER, st.match_no, 3, { deezer_id: 5555, title: "Nova", title_short: "Nova", artist: "B", artists: ["B"], cover: "y", cont: plan }, { active: true, done: 1, total: 1 });
  assert.equal(filled.ok, true, "rodada futura recebe a música preparada");
  ss = await rpc("npl_get_state", cs);
  assert.deepEqual(ss.room.prep, { active: true, done: 1, total: 1 });
  assert.equal((await rpc("npl_fill_cont", cs, OWNER, st.match_no + 1, 4, null, null)).ok, false, "outra partida não mexe");
  assert.equal((await rpc("npl_fill_cont", cs, OWNER, st.match_no, 1, { deezer_id: 1, title: "x", artist: "y", cont: plan }, null)).ok, false, "rodada que já começou não muda");
  // rodada 3 vira "continuar"; a 4 (sem preparo) cai em outro modo
  for (let i = 1; i <= 4; i++) {
    ss = await rpc("npl_get_state", cs);
    const r = ss.rounds.find((x) => x.round_no === i);
    if (i === 3) assert.equal(r.mode, "continue", "música preparada em segundo plano");
    await rpc("npl_skip_round", cs, OWNER, r.id);
    await rpc("npl_next_round", cs, OWNER, i);
  }
  console.log("ok cache de sincronização");
}

// ---------- quizzes (aberto e alternativas) ----------
{
  const mkRoom = async (settings, n) => {
    const { code: c } = await rpc("npl_create_room", OWNER, { teamCount: n, ...settings });
    let s = await rpc("npl_get_state", c);
    for (let i = 0; i < n; i++) {
      await rpc("npl_join", c, P(90 + i), `Q${i}`);
      await rpc("npl_set_team", c, P(90 + i), s.teams[i].id);
    }
    s = await rpc("npl_get_state", c);
    return { c, teams: s.teams.map((t) => t.id) };
  };
  const quizTrack = (i, quiz, mode) => ({ deezer_id: 9900 + i, title: `Q${i}`, title_short: `Q${i}`, artist: "Banda", artists: ["Banda"], cover: "x", album: "Disco", mode, quiz });
  const cur = async (c) => {
    const s = await rpc("npl_get_state", c);
    return { s, r: s.rounds.find((x) => x.round_no === s.room.round_no) };
  };

  // alternativas: todos respondem ao mesmo tempo, pontos pelo tempo
  const { c: qc, teams: qt } = await mkRoom({ modePool: ["quiz_choice"], mode: "quiz_choice" }, 3);
  const choice = { kind: "album", q: "De qual álbum é esta música?", answer: "Disco", options: ["Outro", "Disco", "Mais um", "Último"], correct: 1, open: true, trivia_id: "c80-01" };
  await rpc("npl_start_match", qc, OWNER, [quizTrack(1, choice, "quiz_choice"), quizTrack(2, choice, "quiz_choice")], 2);
  let { s: qs, r: qr } = await cur(qc);
  assert.equal(qr.mode, "quiz_choice");
  assert.deepEqual(qs.room.trivia_recent, ["c80-01"], "curiosidade usada fica nas recentes");
  await rpc("npl_round_begin", qc, OWNER, qr.id, [], [], {});
  ({ r: qr } = await cur(qc));
  assert.equal(qr.quiz.options.length, 4);
  assert.equal(qr.quiz.correct, undefined, "a certa não aparece antes");
  assert.equal(qr.quiz.answer, undefined);
  assert.equal(qr.play_seq, 1, "a prévia toca sozinha");
  assert.equal((await rpc("npl_quiz_choose", qc, P(90), qr.id, 1)).reason, "early", "3 s para ler a pergunta");
  assert.equal((await rpc("npl_buzz", qc, P(90), qr.id)).reason, "choice");
  await db.query("update npl_rounds set quiz = quiz || jsonb_build_object('starts_at', now() - interval '0.1 seconds', 'deadline', now() + interval '15 seconds') where id = $1", [qr.id]);
  assert.equal((await rpc("npl_quiz_choose", qc, P(90), qr.id, 1)).ok, true);
  assert.equal((await rpc("npl_quiz_choose", qc, P(90), qr.id, 2)).reason, "already", "vale o primeiro toque do time");
  assert.equal((await rpc("npl_quiz_choose", qc, P(91), qr.id, 7)).reason, "bad_choice");
  assert.equal((await rpc("npl_quiz_choose", qc, P(91), qr.id, 0)).ok, true);
  ({ s: qs, r: qr } = await cur(qc));
  assert.equal(qr.status, "playing");
  assert.equal(qr.quiz.answered.length, 2);
  assert.equal(qs.attempts.length, 0, "escolhas ficam ocultas até fechar");
  await db.exec("set role anon");
  await fails(db.query("select * from public.npl_quiz_answers"), "permission denied");
  await db.exec("reset role");
  await rpc("npl_quiz_choose", qc, P(92), qr.id, 1);
  ({ s: qs, r: qr } = await cur(qc));
  assert.equal(qr.status, "revealed", "todos responderam: revela");
  assert.equal(qr.quiz.correct, 1);
  assert.equal(qr.quiz.answer, "Disco");
  assert.deepEqual(qr.quiz.counts, [1, 2, 0, 0]);
  const pts = (t) => qs.teams.find((x) => x.id === t).score;
  assert.ok(pts(qt[0]) >= 50 && pts(qt[0]) <= 100, `acerto vale de 50 a 100 (${pts(qt[0])})`);
  assert.ok(pts(qt[0]) >= 95, "respondeu logo: perto de 100");
  assert.equal(pts(qt[1]), 0);
  assert.ok(pts(qt[2]) <= pts(qt[0]), "quem respondeu depois ganha menos");
  assert.equal(qr.winner_team_id, qt[0], "o mais rápido aparece como vencedor");
  // prazo acabou: fecha com quem respondeu; "Encerrar respostas" também
  await rpc("npl_next_round", qc, OWNER, 1);
  ({ r: qr } = await cur(qc));
  await rpc("npl_round_begin", qc, OWNER, qr.id, [], [], {});
  await db.query("update npl_rounds set quiz = quiz || jsonb_build_object('starts_at', now() - interval '20 seconds', 'deadline', now() - interval '5 seconds') where id = $1", [qr.id]);
  assert.equal(await rpc("npl_tick", qc), true);
  ({ s: qs, r: qr } = await cur(qc));
  assert.equal(qr.status, "revealed");
  assert.deepEqual(qr.quiz.counts, [0, 0, 0, 0]);

  // o prazo segue o "Tempo de resposta" (10 s) e a pontuação é proporcional a ele
  {
    const { c: tc10, teams: t10 } = await mkRoom({ modePool: ["quiz_choice"], mode: "quiz_choice", answerSeconds: 10 }, 2);
    await rpc("npl_start_match", tc10, OWNER, [quizTrack(1, choice, "quiz_choice")], 1);
    let { r } = await cur(tc10);
    await rpc("npl_round_begin", tc10, OWNER, r.id, [], [], {});
    ({ r } = await cur(tc10));
    assert.equal(r.quiz.secs, 10);
    const span = Date.parse(r.quiz.deadline) - Date.parse(r.quiz.starts_at);
    assert.ok(Math.abs(span - 10000) < 50, `prazo de 10 s (${span})`);
    // respondeu na metade do prazo (5 s de 10): vale 75
    await db.query("update npl_rounds set quiz = quiz || jsonb_build_object('starts_at', now() - interval '5 seconds') where id = $1", [r.id]);
    await rpc("npl_quiz_choose", tc10, P(90), r.id, 1);
    await rpc("npl_quiz_choose", tc10, P(91), r.id, 0);
    const s = await rpc("npl_get_state", tc10);
    const sc = s.teams.find((x) => x.id === t10[0]).score;
    assert.ok(sc >= 74 && sc <= 76, `metade do prazo vale ~75 (${sc})`);
  }
  // "Sem limite": sem prazo; só fecha quando todos respondem; referência de 30 s
  {
    const { c: tc0, teams: t0 } = await mkRoom({ modePool: ["quiz_choice"], mode: "quiz_choice", answerSeconds: 0 }, 2);
    await rpc("npl_start_match", tc0, OWNER, [quizTrack(1, choice, "quiz_choice")], 1);
    let { r } = await cur(tc0);
    await rpc("npl_round_begin", tc0, OWNER, r.id, [], [], {});
    ({ r } = await cur(tc0));
    assert.equal(r.quiz.deadline, undefined, "sem limite: sem prazo");
    assert.equal(r.quiz.secs, 30);
    await db.query("update npl_rounds set quiz = quiz || jsonb_build_object('starts_at', now() - interval '15 seconds') where id = $1", [r.id]);
    await rpc("npl_tick", tc0);
    ({ r } = await cur(tc0));
    assert.equal(r.status, "playing", "sem limite: o tempo não fecha a pergunta");
    // pausa e volta sem prazo não quebra
    await rpc("npl_pause", tc0, OWNER, true);
    await rpc("npl_pause", tc0, OWNER, false);
    ({ r } = await cur(tc0));
    assert.equal(r.quiz.deadline, undefined);
    await rpc("npl_quiz_choose", tc0, P(90), r.id, 1);
    await rpc("npl_quiz_choose", tc0, P(91), r.id, 1);
    const s = await rpc("npl_get_state", tc0);
    assert.equal(s.rounds[0].status, "revealed", "todos responderam: revela");
    const sc = s.teams.find((x) => x.id === t0[0]).score;
    assert.ok(sc >= 74 && sc <= 76, `15 s de 30 vale ~75 (${sc})`);
  }
  console.log("ok quiz de alternativas");

  // aberto: EU SEI!, ano exato 100, errou por 1 = 50 (encerra), bloqueio corre na hora
  const year = { kind: "year", q: "Em que ano saiu esta música?", answer: "1994", year: 1994, options: ["1994", "1991", "1996", "1990"], correct: 0, open: true };
  const albumQ = { kind: "album", q: "De qual álbum é esta música?", answer: "Disco Bom", accept: ["Disco Bom"], open: true };
  const { c: oc, teams: ot } = await mkRoom({ modePool: ["quiz_open"], mode: "quiz_open", penalty: 20 }, 2);
  await rpc("npl_start_match", oc, OWNER, [quizTrack(1, albumQ, "quiz_open"), quizTrack(2, year, "quiz_open"), quizTrack(3, { ...year, open: false }, "quiz_open")], 3);
  let { r: or } = await cur(oc);
  await rpc("npl_round_begin", oc, OWNER, or.id, [], [], {});
  ({ r: or } = await cur(oc));
  assert.equal(or.mode, "quiz_open");
  assert.equal(or.quiz.q, "De qual álbum é esta música?");
  assert.equal(or.quiz.options, undefined, "aberto não mostra alternativas");
  let ob = await rpc("npl_buzz", oc, P(90), or.id);
  let oa = await rpc("npl_submit_answer", oc, P(90), ob.attempt_id, "", "Outra coisa nada a ver");
  assert.equal(oa.result, "wrong");
  ({ r: or } = await cur(oc));
  assert.ok(or.locks[ot[0]].until, "no quiz a contagem do bloqueio começa na hora");
  ob = await rpc("npl_buzz", oc, P(91), or.id);
  oa = await rpc("npl_submit_answer", oc, P(91), ob.attempt_id, "", "disco bom (deluxe)");
  assert.equal(oa.result, "correct");
  assert.equal(oa.points, 100);
  ({ r: or } = await cur(oc));
  assert.equal(or.quiz.answer, "Disco Bom");
  await rpc("npl_next_round", oc, OWNER, 1);
  ({ r: or } = await cur(oc));
  await rpc("npl_round_begin", oc, OWNER, or.id, [], [], {});
  ob = await rpc("npl_buzz", oc, P(90), or.id);
  oa = await rpc("npl_submit_answer", oc, P(90), ob.attempt_id, "", "foi em 95");
  assert.equal(oa.result, "correct", "errar por 1 ano encerra a rodada");
  assert.equal(oa.half, true);
  assert.equal(oa.points, 50);
  await rpc("npl_next_round", oc, OWNER, 2);
  ({ r: or } = await cur(oc));
  assert.equal(or.mode, "classic", "pergunta que não serve para o aberto cai em outro modo");
  console.log("ok quiz aberto");

  // "Qual é a obra?": joga como o clássico, mas a resposta é a obra
  {
    const s0 = await rpc("npl_get_state", (await rpc("npl_create_room", OWNER, { obraPacks: ["anime", "x", "anime"] })).code);
    assert.deepEqual(s0.room.settings.obraPacks, ["anime"], "pacotes limpos");
    const s1 = await rpc("npl_get_state", (await rpc("npl_create_room", OWNER, { obraPacks: [] })).code);
    assert.deepEqual(s1.room.settings.obraPacks, ["cinema", "anime", "novelas"], "nenhum pacote = todos");

    const { c: wc, teams: wt } = await mkRoom({ modePool: ["obra"], mode: "obra", penalty: 20, scoring: "artist_title" }, 2);
    const obraQ = (obra, accept, extra = {}) => ({ kind: "obra", q: "Qual é a obra?", answer: obra, accept, pack: "cinema", emoji: "🎬", ...extra });
    await rpc("npl_start_match", wc, OWNER, [
      quizTrack(1, obraQ("Rocky III", ["Rocky III", "Rocky 3", "Rocky"]), "obra"),
      quizTrack(2, obraQ("Pantanal", ["Pantanal"], { pack: "novelas", emoji: "📺", tipo: "abertura" }), "obra"),
      quizTrack(3, null, "obra"),
    ], 3);
    let { s: ws, r: wr } = await cur(wc);
    await rpc("npl_round_begin", wc, OWNER, wr.id, [], [0, 0, 0, 0, 0, 0], {});
    ({ s: ws, r: wr } = await cur(wc));
    assert.equal(wr.mode, "obra");
    assert.deepEqual(wr.quiz, { kind: "obra", q: "Qual é a obra?", pack: "cinema", emoji: "🎬" }, "só o pacote aparece");
    assert.ok(!JSON.stringify(ws).includes("Rocky"), "a obra não vaza");
    assert.equal(wr.play_seq, 0, "toca com o Tocar, como o clássico");
    await rpc("npl_play", wc, OWNER, wr.id, 1, false);
    assert.equal((await rpc("npl_play", wc, OWNER, wr.id, 1, true)).ok, false, "prévia inteira: sem 'Próximo trecho'");
    let wb = await rpc("npl_buzz", wc, P(90), wr.id);
    let wa = await rpc("npl_submit_answer", wc, P(90), wb.attempt_id, "", "Q1");
    assert.equal(wa.result, "wrong", "o nome da música não vale");
    ({ s: ws } = await cur(wc));
    assert.equal(ws.teams.find((t) => t.id === wt[0]).score, -20, "penalidade vale");
    wb = await rpc("npl_buzz", wc, P(91), wr.id);
    wa = await rpc("npl_submit_answer", wc, P(91), wb.attempt_id, "", "rocky 3");
    assert.equal(wa.result, "correct", "nome aceito");
    assert.equal(wa.points, 100, "vale como o clássico (sem metade do artista)");
    ({ s: ws, r: wr } = await cur(wc));
    assert.equal(wr.status, "revealed");
    assert.equal(wr.quiz.answer, "Rocky III");
    assert.equal(wr.found.title, "Rocky III");
    assert.equal(wr.reveal.title, "Q1", "a música aparece na revelação");
    // novela: tipo na revelação; "Quase!" com erro de digitação
    await rpc("npl_next_round", wc, OWNER, 1);
    ({ r: wr } = await cur(wc));
    await rpc("npl_round_begin", wc, OWNER, wr.id, [], [0, 0, 0, 0, 0, 0], {});
    await rpc("npl_play", wc, OWNER, wr.id, 1, false);
    wb = await rpc("npl_buzz", wc, P(91), wr.id);
    wa = await rpc("npl_submit_answer", wc, P(91), wb.attempt_id, "", "Pantanl");
    assert.ok(["almost", "correct", "doubt"].includes(wa.result), `erro de digitação (${wa.result})`);
    if (wa.result === "almost") wa = await rpc("npl_submit_answer", wc, P(91), wb.attempt_id, "", "Pantanal");
    ({ r: wr } = await cur(wc));
    assert.equal(wr.quiz.tipo, "abertura");
    assert.equal(wr.quiz.answer, "Pantanal");
    // sem dados da obra: vira clássico
    await rpc("npl_next_round", wc, OWNER, 2);
    ({ r: wr } = await cur(wc));
    assert.equal(wr.mode, "classic", "faixa sem obra cai em outro modo");
  }
  console.log("ok qual é a obra");

  // ---------- Instrumentos: fila, cache e separador ----------
  {
    const { c: sc0 } = await mkRoom({}, 2);
    // o jogo pede; o anon não lê as tabelas nem chama as RPCs do separador
    assert.equal(await rpc("npl_stems_request", sc0, OWNER, [111, 222, 333, 111]), 3, "3 pedidos (sem repetir)");
    await db.exec("set role anon");
    await fails(db.query("select * from public.npl_stems_queue"), "permission denied");
    await fails(db.query("select public.npl_stems_claim()"), "permission denied");
    await fails(db.query("select public.npl_stems_heartbeat('{}'::jsonb)"), "permission denied");
    await db.exec("reset role");
    let st = await rpc("npl_stems_status", [111, 222, 333]);
    assert.equal(st.worker.alive, false, "separador desligado");
    assert.deepEqual(st.queue, { pending: 3 });
    await rpc("npl_stems_heartbeat", { version: "test" });
    st = await rpc("npl_stems_status", [111]);
    assert.equal(st.worker.alive, true, "sinal de vida");
    // separador: pega um por vez, na ordem
    const job = await rpc("npl_stems_claim");
    assert.equal(job.deezer_id, 111);
    assert.equal(job.status, "processing");
    assert.equal((await rpc("npl_stems_claim")).deezer_id, 222, "o próximo pedido");
    const paths = (k) => ({ drums: `${k}/drums.mp3`, bass: `${k}/bass.mp3`, guitar: `${k}/guitar.mp3`, vocals: `${k}/vocals.mp3` });
    await rpc("npl_stems_done", 111, "key-111-aaaa", paths("key-111-aaaa"), 120_000_000,
      { drums: true, bass: true, guitar: false, vocals: true }, { guitar: -60 });
    await rpc("npl_stems_fail", 222, "Prévia indisponível");
    st = await rpc("npl_stems_status", [111, 222, 333]);
    assert.equal(st.ready.length, 1);
    assert.equal(st.ready[0].audible.guitar, false, "guitarra vazia marcada");
    assert.deepEqual(st.queue, { error: 1, pending: 1 }, "1 com erro, 1 na fila");
    assert.equal(st.errors[0].error, "Prévia indisponível");
    // pedir de novo: a que deu erro volta para a fila; a pronta não
    assert.equal(await rpc("npl_stems_request", sc0, OWNER, [111, 222]), 1);
    // limite: acima de 200 MB apaga as usadas há mais tempo
    await rpc("npl_stems_done", 333, "key-333-bbbb", paths("key-333-bbbb"), 100_000_000,
      { drums: true, bass: true, guitar: true, vocals: true }, {});
    await db.query("update npl_stems_cache set last_used_at = now() - interval '1 day' where deezer_id = 111");
    await rpc("npl_stems_touch", sc0, OWNER, [333]);
    const gone = await rpc("npl_stems_evict", 200_000_000);
    assert.deepEqual(gone.map((g) => g.deezer_id), [111], "apaga a usada há mais tempo");
    assert.equal(gone[0].paths.drums, "key-111-aaaa/drums.mp3");
    assert.equal((await rpc("npl_stems_status", [111])).ready.length, 0);
    assert.deepEqual(await rpc("npl_stems_evict", 200_000_000), [], "já cabe");
    await db.exec("delete from npl_stems_cache; delete from npl_stems_queue;");

    // pausar / continuar / limpar a fila
    assert.equal(await rpc("npl_stems_request", sc0, OWNER, [501, 502, 503]), 3);
    assert.equal((await rpc("npl_stems_claim")).deezer_id, 501, "a atual");
    await fails(rpc("npl_stems_set_paused", sc0, "token-errado", true), "");
    assert.equal(await rpc("npl_stems_set_paused", sc0, OWNER, true), true);
    st = await rpc("npl_stems_status", []);
    assert.equal(st.global.paused, true);
    assert.equal(st.global.pending, 2);
    assert.equal(st.global.processing, 1);
    assert.equal(await rpc("npl_stems_claim"), null, "pausada: não entrega nada");
    // a atual termina normalmente mesmo pausada
    await db.query("update npl_stems_queue set started_at = now() - interval '40 seconds' where deezer_id = 501");
    await rpc("npl_stems_done", 501, "key-501", paths("key-501"), 1000, { drums: true, bass: true, guitar: true, vocals: true }, {});
    st = await rpc("npl_stems_status", []);
    assert.ok(st.global.avg_seconds >= 39 && st.global.avg_seconds <= 41, "tempo médio por música");
    assert.equal(await rpc("npl_stems_set_paused", sc0, OWNER, false), false);
    assert.equal((await rpc("npl_stems_claim")).deezer_id, 502, "continuou");
    assert.equal(await rpc("npl_stems_clear", sc0, OWNER), 1, "limpa só a pendente");
    st = await rpc("npl_stems_status", [501, 502, 503]);
    assert.deepEqual(st.queue, { processing: 1 }, "a que está sendo separada fica");
    assert.equal(st.ready.length, 1, "o cache fica");
    await db.exec("delete from npl_stems_cache; delete from npl_stems_queue;");

    // dados da música: vêm no pedido, passam para o cache; as antigas são completadas (sem sobrescrever)
    await rpc("npl_stems_request", sc0, OWNER, [601, 602], [
      { deezer_id: 601, title: "Tempo Perdido", artist: "Legião Urbana", cover: "https://x/c.jpg", album_id: 7, extra: "fora" },
      { deezer_id: 999, title: "Não pedida", artist: "X" },
    ]);
    await rpc("npl_stems_claim");
    await rpc("npl_stems_done", 601, "key-601", paths("key-601"), 1000, { drums: true, bass: true, guitar: true, vocals: true }, {});
    await rpc("npl_stems_claim");
    await rpc("npl_stems_done", 602, "key-602", paths("key-602"), 1000, { drums: true, bass: true, guitar: true, vocals: true }, {});
    let cached = await rpc("npl_stems_cached");
    const m601 = cached.find((x) => x.deezer_id === 601).meta;
    assert.deepEqual(m601, { title: "Tempo Perdido", title_short: "Tempo Perdido", artist: "Legião Urbana", cover: "https://x/c.jpg", album_id: 7 });
    assert.equal(cached.find((x) => x.deezer_id === 602).meta, null, "sem dados: o servidor completa");
    assert.equal(await rpc("npl_stems_fill_meta", [{ deezer_id: 602, title: "Índios", artist: "Legião Urbana" }, { deezer_id: 601, title: "Trocado", artist: "Y" }]), 2, "fila + cache da 602; a 601 fica");
    cached = await rpc("npl_stems_cached");
    assert.equal(cached.find((x) => x.deezer_id === 602).meta.title, "Índios");
    assert.equal(cached.find((x) => x.deezer_id === 601).meta.title, "Tempo Perdido", "não sobrescreve");
    await db.exec("delete from npl_stems_cache; delete from npl_stems_queue;");

    // fontes recentes: as da sala ao começar, no máximo 10, a mais nova primeiro
    await db.exec("delete from npl_recent_sources");
    await fails(rpc("npl_sources_used", sc0, "token-errado"), "");
    for (let i = 0; i < 12; i++) {
      await rpc("npl_update_settings", sc0, OWNER, { sources: [{ type: "playlist", id: `p${i}`, label: `Lista ${i}`, picture: "https://x/p.jpg" }] });
      await rpc("npl_sources_used", sc0, OWNER);
    }
    await rpc("npl_update_settings", sc0, OWNER, {
      sources: [
        { type: "artist", id: "27", label: "Daft Punk", level: "fan", picture: "javascript:alert(1)" },
        { type: "cache", id: "stems", label: "Músicas já preparadas" },
        { type: "playlist", id: "p5", label: "Lista 5 (de novo)" },
        { type: "hack", id: "x", label: "?" },
      ],
    });
    await rpc("npl_sources_used", sc0, OWNER);
    const recent = await rpc("npl_recent_sources");
    assert.equal(recent.length, 10);
    assert.deepEqual(recent.slice(0, 3).map((s) => s.id), ["27", "stems", "p5"]);
    assert.deepEqual(recent[0], { type: "artist", id: "27", label: "Daft Punk", level: "fan" }, "nível guardado, foto inválida fora");
    assert.equal(recent[2].label, "Lista 5 (de novo)", "repetida: atualiza e sobe");
    assert.equal(recent[3].id, "p11");
    await db.exec("set role anon");
    await fails(db.query("select * from public.npl_recent_sources"), "permission denied");
    await db.exec("reset role");
  }

  // ---------- Instrumentos: partida ----------
  {
    const { c: ic, teams: it } = await mkRoom({ modePool: ["stems"], mode: "stems", scoring: "artist_title", penalty: 20 }, 2);
    let si = await rpc("npl_get_state", ic);
    assert.equal(si.room.settings.stemsVariant, "layers", "padrão: camadas");
    assert.equal(si.room.settings.stemsInstrument, "random");
    const stemTrack = (i, stems) => ({ deezer_id: 9800 + i, title: `S${i}`, title_short: `S${i}`, artist: "Banda S", artists: ["Banda S"], cover: "x", album: "A", mode: "stems", stems });
    await rpc("npl_start_match", ic, OWNER, [
      stemTrack(1, { key: "abcd-1234-efgh", variant: "layers", layers: ["vocals", "drums", "bass"] }), // sem guitarra
      stemTrack(2, { key: "abcd-5678-efgh", variant: "single", instrument: "vocals" }),
      stemTrack(3, { key: "../hack" }), // chave inválida: vira outro modo
    ], 3);
    let { r: ir } = await cur(ic);
    await rpc("npl_round_begin", ic, OWNER, ir.id, [], [], {});
    ({ r: ir } = await cur(ic));
    assert.equal(ir.mode, "stems");
    assert.deepEqual(ir.stems.layers, ["drums", "bass", "vocals"], "ordem do jogo; guitarra vazia pulada");
    assert.deepEqual(ir.stems.points, [100, 75, 20]);
    assert.equal(ir.stems.key, "abcd-1234-efgh");
    await rpc("npl_play", ic, OWNER, ir.id, 1, false);
    assert.equal((await rpc("npl_play", ic, OWNER, ir.id, 1, true)).ok, true, "próxima camada");
    assert.equal((await rpc("npl_play", ic, OWNER, ir.id, 2, true)).ok, true, "+ voz");
    assert.equal((await rpc("npl_play", ic, OWNER, ir.id, 3, true)).ok, false, "não há 4ª camada");
    let ib = await rpc("npl_buzz", ic, P(90), ir.id);
    let ia = await rpc("npl_submit_answer", ic, P(90), ib.attempt_id, "Banda S", "S1");
    assert.equal(ia.result, "correct");
    assert.equal(ia.points, 30, "música 20 + artista 10 na camada da voz");
    // um instrumento só, a voz: artista vale inteiro, título é bônus
    await rpc("npl_next_round", ic, OWNER, 1);
    ({ r: ir } = await cur(ic));
    await rpc("npl_round_begin", ic, OWNER, ir.id, [], [], {});
    ({ r: ir } = await cur(ic));
    assert.equal(ir.stems.variant, "single");
    assert.equal(ir.stems.instrument, "vocals");
    assert.deepEqual(ir.stems.points, [100, 60, 30]);
    await rpc("npl_play", ic, OWNER, ir.id, 1, false);
    ib = await rpc("npl_buzz", ic, P(91), ir.id);
    ia = await rpc("npl_submit_answer", ic, P(91), ib.attempt_id, "Banda S", "");
    assert.equal(ia.points, 100, "voz: o artista vale 100");
    ({ r: ir } = await cur(ic));
    assert.equal(ir.status, "playing", "ainda dá para ganhar o bônus do título");
    ib = await rpc("npl_buzz", ic, P(90), ir.id);
    ia = await rpc("npl_submit_answer", ic, P(90), ib.attempt_id, "", "S2");
    assert.equal(ia.points, 50, "voz: título vale metade (bônus)");
    await rpc("npl_next_round", ic, OWNER, 2);
    ({ r: ir } = await cur(ic));
    assert.equal(ir.mode, "classic", "faixa sem stems válidos cai em outro modo");
    si = await rpc("npl_get_state", ic);
    assert.equal(si.teams.find((t) => t.id === it[1]).score, 100);
  }
  console.log("ok instrumentos");
}

// ---------- "Um time por vez" ----------
{
  const { code: tc } = await rpc("npl_create_room", OWNER, { teamCount: 3, turnFormat: "turns", answerSeconds: 20, scoring: "title" });
  let ts = await rpc("npl_get_state", tc);
  for (let i = 0; i < 3; i++) {
    await rpc("npl_join", tc, P(95 + i), `T${i}`);
    await rpc("npl_set_team", tc, P(95 + i), ts.teams[i].id);
  }
  ts = await rpc("npl_get_state", tc);
  const tt = ts.teams.map((t) => t.id);
  const tracks = [1, 2, 3, 4].map((i) => ({ deezer_id: 9950 + i, title: `Faixa Vez ${i}`, title_short: `Faixa Vez ${i}`, artist: "Vez", artists: ["Vez"], cover: "x" }));
  await rpc("npl_start_match", tc, OWNER, tracks, 3);
  const cur = async () => {
    const s = await rpc("npl_get_state", tc);
    const r = s.rounds.find((x) => x.round_no === s.room.round_no);
    return { s, r, a: s.attempts.find((x) => x.id === r.current_attempt_id) };
  };
  let { r: tr } = await cur();
  await rpc("npl_round_begin", tc, OWNER, tr.id, [], [0, 0, 0, 0, 0, 0]);
  let { r, a } = await cur();
  assert.equal(r.status, "answering", "a rodada já abre com a vez do time");
  assert.equal(r.turn.team, tt[0]);
  assert.equal(a.team_id, tt[0]);
  assert.equal(a.deadline, null, "o prazo só começa quando o trecho toca");
  assert.equal((await rpc("npl_buzz", tc, P(96), r.id)).reason, "turns");
  assert.equal((await rpc("npl_play", tc, OWNER, r.id, 1, false)).ok, true, "Tocar com a vez aberta");
  ({ r, a } = await cur());
  assert.ok(a.deadline, "prazo começou");
  assert.equal((await rpc("npl_play", tc, OWNER, r.id, 1, true)).ok, true, "Próximo trecho durante a vez");
  ({ r, a } = await cur());
  assert.equal(a.stage_points, 80, "vale o trecho atual");
  assert.equal((await rpc("npl_submit_answer", tc, P(96), a.id, "", "x")).reason, "not_your_team");
  await rpc("npl_submit_answer", tc, P(95), a.id, "", "nada a ver mesmo");
  ({ r, a } = await cur());
  assert.equal(r.status, "answering", "errou: passa a vez");
  assert.equal(a.team_id, tt[1]);
  assert.equal(a.stage_points, 40, "valendo metade");
  assert.ok(a.deadline, "a música continua: o prazo já corre");
  const ok2 = await rpc("npl_submit_answer", tc, P(96), a.id, "", "Faixa Vez 1");
  assert.equal(ok2.result, "correct");
  assert.equal(ok2.points, 40);
  await rpc("npl_next_round", tc, OWNER, 1);
  ({ r } = await cur());
  await rpc("npl_round_begin", tc, OWNER, r.id, [], []);
  ({ r, a } = await cur());
  assert.equal(r.turn.team, tt[1], "rodízio: a 2ª rodada é do 2º time");
  // tempo esgotado também passa; todos erraram: revela
  await rpc("npl_play", tc, OWNER, r.id, 1, false);
  for (let i = 0; i < 3; i++) {
    ({ r, a } = await cur());
    await db.query("update npl_attempts set deadline = now() - interval '5 seconds' where id = $1", [a.id]);
    assert.equal(await rpc("npl_tick", tc), true);
  }
  ({ r } = await cur());
  assert.equal(r.status, "revealed", "todos tentaram: revela");
  assert.equal(r.turn.tried.length, 3);
  // passa a vez desligada: errou, revela
  await rpc("npl_next_round", tc, OWNER, 2);
  await rpc("npl_finish_match", tc, OWNER);
  await rpc("npl_update_settings", tc, OWNER, { passOnWrong: false });
  await rpc("npl_start_match", tc, OWNER, tracks, 3);
  ({ r } = await cur());
  await rpc("npl_round_begin", tc, OWNER, r.id, [], []);
  ({ r, a } = await cur());
  await rpc("npl_submit_answer", tc, P(95), a.id, "", "errado");
  ({ r } = await cur());
  assert.equal(r.status, "revealed", "sem passar a vez: errou, revela");
  console.log("ok um time por vez");
}

const sent = await sql("select count(*)::int as n, min(topic) as t from realtime.sent");
assert.ok(sent[0].n > 20);
assert.match(sent[0].t, /^npl_room_/);

// limpeza de salas antigas
await db.query("update npl_rooms set last_activity_at = now() - interval '7 hours'");
await rpc("npl_create_room", OWNER, {});
assert.equal((await sql("select count(*)::int as n from npl_rooms"))[0].n, 1);
assert.equal((await sql("select count(*)::int as n from npl_players"))[0].n, 0);

console.log("ok todos os testes do banco");
