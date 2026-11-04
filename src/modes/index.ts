import { classicMode } from "./classic";
import type { ModeDef } from "./types";

/** Registro de modos. Para um modo novo: criar src/modes/<id>/ e registrar aqui + npl_stage_points(). */
export const MODES: Record<string, ModeDef> = {
  [classicMode.id]: classicMode,
};

export const getMode = (id: string | null | undefined): ModeDef => MODES[id ?? ""] ?? classicMode;
