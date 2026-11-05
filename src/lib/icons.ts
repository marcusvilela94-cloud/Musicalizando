// Ícones (emojis) de jogadores e times. A MESMA lista está em npl_icons()
// (supabase/migrations/..._npl_icones.sql), que valida a troca.
import type { Player, Team } from "./types";

export const ICONS = [
  "🦖", "🦄", "🐙", "🦊", "🐸", "🐼", "🐨", "🐯", "🦁", "🐵", "🐧", "🦉", "🦩", "🐢", "🐳", "🦈", "🐝", "🦋", "🐌", "🦀",
  "🍕", "🌮", "🍩", "🍔", "🥑", "🍉", "🍦", "🧀", "🥨", "🍟", "🎸", "🎺", "🥁", "🎷", "🎤", "🎧", "🚀", "👽", "🤖", "👻",
  "🤠", "🥸", "😎", "🤡", "💀", "🌈", "🔥", "⚡", "🌵", "🍄", "🎩", "👑", "🦸", "🧙", "🐔", "🦥", "🦦", "🐷", "🦝", "🐲",
] as const;

/** "🦖 Os Brabos" */
export const teamLabel = (t: Pick<Team, "name" | "icon">) => (t.icon ? `${t.icon} ${t.name}` : t.name);
/** "🦊 Ana" */
export const playerLabel = (p: Pick<Player, "nickname" | "icon">) => (p.icon ? `${p.icon} ${p.nickname}` : p.nickname);
