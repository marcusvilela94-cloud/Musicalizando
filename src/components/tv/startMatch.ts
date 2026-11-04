"use client";
import { api, deezer } from "@/lib/api";
import type { RoomState } from "@/lib/types";
import type { TvCtx } from "./TvApp";

/** Libera o áudio (precisa ser num clique), sorteia as músicas e começa a partida. */
export async function startMatch(state: RoomState, ctx: TvCtx): Promise<string[]> {
  await ctx.unlockAudio();
  const { sources, rounds } = state.room.settings;
  const { tracks, warnings } = await deezer.build(sources, rounds);
  await api.startMatch(ctx.code, ctx.owner, tracks);
  return warnings;
}
