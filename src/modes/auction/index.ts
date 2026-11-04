import type { ModeDef } from "../types";
import { AuctionPhone } from "./AuctionPhone";
import { AuctionTvEngine } from "./AuctionTvEngine";
import { AuctionPresenterView, AuctionTvView } from "./AuctionTvView";

/**
 * Leilão: a TV mostra uma dica (artista OU gênero + ano), os times dão lances
 * de quantos segundos precisam (começa em 20 s) e o menor lance ouve primeiro
 * exatamente aquele trecho. Acerto vale 100; errou, passa para o próximo da fila.
 */
export const auctionMode: ModeDef = {
  id: "auction",
  label: "Leilão",
  description: "Com uma dica, os times apostam quantos segundos precisam. Menor lance ouve primeiro.",
  stages: [],
  pickOffsets: () => [],
  TvEngine: AuctionTvEngine,
  TvRoundView: AuctionTvView,
  PhoneRoundView: AuctionPhone,
  PresenterRoundView: AuctionPresenterView,
};
