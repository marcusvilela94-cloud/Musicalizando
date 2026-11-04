"use client";
import { useEffect, useState } from "react";
import QRCode from "qrcode";

export function QrCode({ value, size = 220, className = "" }: { value: string; size?: number; className?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(value, { margin: 1, width: size * 2, color: { dark: "#1e0b3a", light: "#ffffff" } })
      .then((url) => alive && setSrc(url))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [value, size]);
  return (
    <div className={`rounded-2xl bg-white p-2 ${className}`} style={{ width: size + 16, height: size + 16 }}>
      {/* eslint-disable-next-line @next/next/no-img-element -- data URL gerada localmente */}
      {src && <img src={src} alt="QR code para entrar na sala" width={size} height={size} />}
    </div>
  );
}
