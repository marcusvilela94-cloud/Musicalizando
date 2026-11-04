import type { StageDef } from "../types";

const STEP = 0.5; // grade de posições possíveis (s)

/**
 * Sorteia um ponto de início diferente dentro da prévia para cada trecho,
 * evitando sobreposição quando possível. O último estágio toca a prévia
 * inteira (início 0). Ex.: [12, 3, 20, 0.5, 9, 0].
 *
 * Coloca do trecho mais longo para o mais curto, escolhendo ao acaso entre as
 * posições que menos se sobrepõem às já escolhidas; repete algumas vezes e
 * fica com a combinação de menor sobreposição total.
 */
export function pickStageOffsets(stages: StageDef[], duration: number, rand: () => number = Math.random): number[] {
  const last = stages.length - 1;
  const order = stages
    .map((s, i) => ({ i, len: Math.min(s.seconds, duration) }))
    .filter(({ i, len }) => i !== last && len < duration - 0.05)
    .sort((a, b) => b.len - a.len);

  let best: number[] = stages.map(() => 0);
  let bestOverlap = Infinity;
  for (let attempt = 0; attempt < 40 && bestOverlap > 0; attempt++) {
    const offsets = stages.map(() => 0);
    const placed: [number, number][] = [];
    let total = 0;
    for (const { i, len } of order) {
      const maxStart = Math.max(0, duration - len);
      let min = Infinity;
      let candidates: number[] = [];
      for (let start = 0; start <= maxStart + 1e-9; start += STEP) {
        let ov = 0;
        for (const [a, b] of placed) ov += Math.max(0, Math.min(b, start + len) - Math.max(a, start));
        if (ov < min - 1e-9) {
          min = ov;
          candidates = [start];
        } else if (Math.abs(ov - min) <= 1e-9) candidates.push(start);
      }
      const start = candidates[Math.floor(rand() * candidates.length)] ?? 0;
      offsets[i] = Math.round(start * 10) / 10;
      placed.push([start, start + len]);
      total += min;
    }
    if (total < bestOverlap) {
      bestOverlap = total;
      best = offsets;
    }
  }
  return best;
}
