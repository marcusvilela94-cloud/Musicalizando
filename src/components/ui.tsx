"use client";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { textOn } from "@/lib/colors";
import type { Team } from "@/lib/types";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "success";
const VARIANTS: Record<Variant, string> = {
  primary: "bg-yellow-300 text-violet-950 hover:bg-yellow-200 shadow-[0_6px_0_#a16207] active:shadow-none active:translate-y-[6px]",
  secondary: "bg-white/15 text-white hover:bg-white/25 border border-white/20",
  ghost: "bg-transparent text-white/80 hover:bg-white/10",
  danger: "bg-rose-500 text-white hover:bg-rose-400 shadow-[0_6px_0_#9f1239] active:shadow-none active:translate-y-[6px]",
  success: "bg-emerald-400 text-emerald-950 hover:bg-emerald-300 shadow-[0_6px_0_#047857] active:shadow-none active:translate-y-[6px]",
};

export function Button({
  variant = "primary",
  className = "",
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      {...rest}
      className={`font-display font-semibold rounded-2xl px-5 py-3 transition disabled:opacity-40 disabled:pointer-events-none no-select ${VARIANTS[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

export function Logo({ className = "" }: { className?: string }) {
  return (
    <span className={`font-display font-bold tracking-tight ${className}`}>
      <span className="text-yellow-300">Musica</span>
      <span className="text-pink-400">lizando</span>
      <span className="ml-1">🎶</span>
    </span>
  );
}

export function TeamChip({ team, className = "", children }: { team: Team; className?: string; children?: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full px-3 py-1 font-display font-semibold ${className}`}
      style={{ background: team.color, color: textOn(team.color) }}
    >
      {children ?? team.name}
    </span>
  );
}

export function Equalizer({ className = "" }: { className?: string }) {
  return (
    <div className={`npl-eq flex items-end gap-1 h-10 ${className}`}>
      {[0, 1, 2, 3, 4].map((i) => (
        <span key={i} className="w-2 rounded-full bg-current" />
      ))}
    </div>
  );
}

export function Card({ className = "", children }: { className?: string; children: ReactNode }) {
  return <div className={`rounded-3xl bg-white/10 border border-white/15 backdrop-blur p-5 ${className}`}>{children}</div>;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex flex-col items-center gap-3 text-white/80">
      <div className="h-10 w-10 rounded-full border-4 border-white/20 border-t-yellow-300 animate-spin" />
      {label && <p className="font-display text-lg">{label}</p>}
    </div>
  );
}
