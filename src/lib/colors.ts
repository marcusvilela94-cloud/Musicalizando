/** Cor de texto legível (preto/branco) sobre a cor do time. */
export function textOn(hex: string): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return L > 0.35 ? "#111827" : "#FFFFFF";
}

/** Paleta dos times (a mesma de npl_palette() no banco). */
export const PALETTE = [
  { name: "Vermelho", color: "#EF4444" },
  { name: "Azul", color: "#3B82F6" },
  { name: "Verde", color: "#22C55E" },
  { name: "Amarelo", color: "#FACC15" },
  { name: "Roxo", color: "#A855F7" },
  { name: "Laranja", color: "#F97316" },
  { name: "Rosa", color: "#F472B6" },
  { name: "Ciano", color: "#22D3EE" },
  { name: "Lima", color: "#A3E635" },
  { name: "Marrom", color: "#A0522D" },
  { name: "Branco", color: "#F8FAFC" },
  { name: "Vinho", color: "#9F1239" },
] as const;
