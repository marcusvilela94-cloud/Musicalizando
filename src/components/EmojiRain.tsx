"use client";
import { useEffect, useState } from "react";

/**
 * Chuva de emojis por cima da tela (acerto na TV, pódio). Cada montagem
 * sorteia posições; troque a `key` para chover de novo.
 */
export function EmojiRain({ emojis, count = 36, waves = 1, size = "text-6xl" }: { emojis: string[]; count?: number; waves?: number; size?: string }) {
  // sorteia as posições uma vez, ao montar
  const [drops] = useState(() =>
      Array.from({ length: count * waves }, (_, i) => ({
        emoji: emojis[i % Math.max(1, emojis.length)] ?? "🎉",
        left: Math.random() * 96,
        delay: Math.floor(i / count) * 2 + Math.random() * 1.2,
        dur: 1.8 + Math.random() * 1.6,
        spin: (Math.random() > 0.5 ? 1 : -1) * (180 + Math.random() * 360),
        scale: 0.7 + Math.random() * 0.8,
      })),
  );
  return (
    <div className="pointer-events-none absolute inset-0 z-30 overflow-hidden" aria-hidden>
      {drops.map((d, i) => (
        <span
          key={i}
          className={`npl-fall ${size}`}
          style={
            {
              left: `${d.left}%`,
              scale: String(d.scale),
              "--npl-delay": `${d.delay}s`,
              "--npl-dur": `${d.dur}s`,
              "--npl-spin": `${d.spin}deg`,
            } as React.CSSProperties
          }
        >
          {d.emoji}
        </span>
      ))}
    </div>
  );
}

/** Aplica o tema da sala no <body> (TV e celulares). */
export function RoomTheme({ theme }: { theme: string | undefined }) {
  useEffect(() => {
    const t = theme && theme !== "party" ? theme : "";
    if (t) document.body.dataset.theme = t;
    else delete document.body.dataset.theme;
    return () => {
      delete document.body.dataset.theme;
    };
  }, [theme]);
  return null;
}
