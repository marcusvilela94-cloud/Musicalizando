"use client";
// Telas de transição que esperam o controlador: apresentação da rodada
// ("Começar rodada") e "Vez do time X!" ("Continuar"). Nada avança sozinho.
import { TeamChip } from "@/components/ui";
import { textOn } from "@/lib/colors";
import { teamById, tiebreakLeft, tiebreakOf, turnClaims, turnOf } from "@/lib/game";
import { teamLabel } from "@/lib/icons";
import type { RoomState, Round } from "@/lib/types";
import { getMode } from "@/modes";
import { auctionOf } from "@/modes/auction/logic";
import { lyricsOf } from "@/modes/lyrics/LyricsView";
import { contOf } from "@/modes/continue/logic";
import { stemsOf } from "@/modes/stems/logic";

/** "Vez do time Verde" / "Vez do Time Azul" (sem repetir "time" quando o nome já começa assim). */
export const vezDo = (name: string) => (/^time\b/i.test(name.trim()) ? "Vez do" : "Vez do time");

/** Uma frase explicando como a rodada funciona (depende do formato da vez). */
export function roundHow(state: RoomState, round: Round) {
  const turns = !!turnOf(round);
  const pass = state.room.settings.passOnWrong !== false;
  if (tiebreakOf(round)) return "Empate no 1º lugar: quem acertar a música primeiro vence a partida!";
  const claim = turns
    ? pass
      ? " Quando souberem, apertem “Responder agora” no celular. Errou? A vez passa (trecho seguinte, metade dos pontos)."
      : " Quando souberem, apertem “Responder agora” no celular. Errou? Peçam mais trechos e tentem de novo."
    : "";
  switch (round.mode) {
    case "classic":
      return turns ? `Trechos cada vez maiores da música.${claim}` : "Trechos cada vez maiores: quem souber aperta EU SEI! — quanto antes, mais pontos.";
    case "obra":
      return turns ? `A trilha toca: acertem o filme, anime ou novela.${claim}` : "A trilha toca: quem souber a obra aperta EU SEI!";
    case "stems":
      return turns ? `A música entra por partes (instrumentos).${claim}` : "A música entra por partes (instrumentos): quem souber aperta EU SEI!";
    case "auction":
      return "Com a dica, cada time dá um lance de quantos segundos precisa. Quem der o menor lance ouve primeiro.";
    case "lyrics":
      return turns ? "Os versos aparecem um a um: o time da vez responde qual é a música." : "Os versos aparecem um a um: quem souber a música aperta EU SEI!";
    case "continue":
      return turns
        ? "A música para antes de uma linha: quando ela parar, o time da vez completa a letra."
        : "A música para antes de uma linha: quando ela parar, quem souber aperta EU SEI! e completa.";
    case "quiz_open":
      return turns
        ? "A pergunta aparece primeiro para todos lerem; no “Valendo!” o time da vez responde."
        : "A pergunta aparece primeiro para todos lerem; no “Valendo!” quem souber aperta EU SEI!";
    case "quiz_choice":
      return "A pergunta e as alternativas aparecem primeiro; no “Valendo!” todos respondem pelo celular. Mais rápido = mais pontos.";
    default:
      return getMode(round.mode).description;
  }
}

/** "de 100 a 10 pts", "100 pts"… */
export function roundWorth(state: RoomState, round: Round) {
  if (tiebreakOf(round)) return "vale a vitória";
  if (round.mode === "auction") return "100 pts";
  if (round.mode === "quiz_choice") return "de 100 a 50 pts (pela rapidez)";
  const stm = stemsOf(round);
  const lyr = lyricsOf(round);
  const cont = contOf(round);
  const pts = stm ? stm.points : getMode(round.mode).stages.slice(0, lyr ? lyr.total : cont ? cont.max : undefined).map((s) => s.points);
  const hi = Math.max(...pts);
  const lo = Math.min(...pts);
  const art =
    ["classic", "stems", "lyrics"].includes(round.mode) && state.room.settings.scoring === "artist_title"
      ? stm?.variant === "single" && stm.instrument === "vocals"
        ? " (artista vale tudo; música é bônus)"
        : " (música; artista vale metade)"
      : "";
  return `${hi === lo ? hi : `de ${hi} a ${lo}`} pts${art}`;
}

/** Tela de apresentação da rodada (TV grande; celulares compacto). */
export function RoundIntro({ state, round, size = "tv" }: { state: RoomState; round: Round; size?: "tv" | "phone" }) {
  const def = getMode(round.mode);
  const tv = size === "tv";
  const tb = tiebreakOf(round);
  const turn = turnOf(round);
  const team = teamById(state, turn?.team);
  const auc = auctionOf(round);
  return (
    <div className={`npl-pop flex w-full flex-col items-center text-center ${tv ? "max-w-5xl gap-5" : "max-w-sm gap-3"}`}>
      <p className={`font-display text-white/70 ${tv ? "text-3xl" : "text-lg"}`}>
        {tb ? (tb.n > 1 ? `Música extra ${tb.n}` : "Fim das rodadas") : `${tv ? "Rodada" : "Próxima rodada ·"} ${round.round_no} de ${state.room.total_rounds}`}
      </p>
      <p className={`leading-none ${tv ? "text-[8rem]" : "text-6xl"}`}>{tb ? "☠️" : def.icon}</p>
      <p className={`font-display font-bold uppercase ${tb ? "text-rose-300" : "text-yellow-300"} ${tv ? "text-8xl" : "text-4xl"}`}>
        {tb ? (tb.n > 1 ? "Mais uma!" : "Morte súbita!") : def.label}
      </p>
      <p className={`font-display text-white/90 ${tv ? "text-3xl" : "text-lg"}`}>{roundHow(state, round)}</p>
      {tb && (
        <div className="flex flex-wrap justify-center gap-2">
          {tiebreakLeft(tb).map((id) => {
            const t = teamById(state, id);
            return t ? <TeamChip key={id} team={t} className={tv ? "text-3xl px-5 py-1" : ""}>{t.name}</TeamChip> : null;
          })}
        </div>
      )}
      {auc?.hint && (
        <p className={`rounded-2xl bg-white/10 px-4 py-2 font-display ${tv ? "text-3xl" : "text-lg"}`}>
          Dica: {auc.hint === "artist" ? <>🎤 <b>{auc.artist}</b> (vale a música)</> : <>🎸 <b>{auc.genre}</b> · {auc.year} (vale o artista)</>}
        </p>
      )}
      {team && (
        <div className={`rounded-3xl font-display font-bold ${tv ? "px-10 py-4 text-5xl" : "px-5 py-2 text-2xl"}`} style={{ background: team.color, color: textOn(team.color) }}>
          {vezDo(team.name)} {teamLabel(team)}
        </div>
      )}
      <p className={`font-display ${tv ? "text-4xl" : "text-xl"}`}>
        Vale <b className="text-yellow-300">{roundWorth(state, round)}</b>
      </p>
    </div>
  );
}

/** "Vez do time X!" depois de um erro (passa a vez valendo metade). */
export function TurnHandoff({ state, round, size = "tv", mine }: { state: RoomState; round: Round; size?: "tv" | "phone"; mine?: boolean }) {
  const turn = turnOf(round);
  const team = teamById(state, turn?.team);
  if (!team) return null;
  const tv = size === "tv";
  return (
    <div
      className={`npl-pop flex w-full flex-col items-center rounded-[2.5rem] text-center ${tv ? "max-w-4xl gap-4 p-10" : "max-w-sm gap-2 p-6"}`}
      style={{ background: team.color, color: textOn(team.color) }}
    >
      <p className={`font-display ${tv ? "text-4xl" : "text-xl"}`}>Passou a vez!</p>
      <p className={`font-display font-bold ${tv ? "text-8xl" : "text-4xl"}`}>{mine ? "Vez do seu time!" : <>{vezDo(team.name)} {teamLabel(team)}!</>}</p>
      <p className={`font-display ${tv ? "text-3xl" : "text-lg"}`}>
        {turnClaims(round) ? "segue do próximo trecho, " : ""}valendo metade dos pontos
      </p>
      <p className={`font-display opacity-80 ${tv ? "text-2xl" : "text-base"}`}>Aguardando o “Continuar”…</p>
    </div>
  );
}
