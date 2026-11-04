"use client";
// Sem login: cada aparelho gera um token aleatório e guarda no localStorage.

function randomToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const PLAYER_KEY = "npl_player_token";
const OWNER_KEY = "npl_owner_tokens";
const NICK_KEY = "npl_nickname";

export function getPlayerToken(): string {
  let t = localStorage.getItem(PLAYER_KEY);
  if (!t) {
    t = randomToken();
    localStorage.setItem(PLAYER_KEY, t);
  }
  return t;
}

function ownerMap(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(OWNER_KEY) ?? "{}");
  } catch {
    return {};
  }
}

export function newOwnerToken() {
  return randomToken();
}

export function getOwnerToken(code: string): string | null {
  return ownerMap()[code] ?? null;
}

export function saveOwnerToken(code: string, token: string) {
  const m = ownerMap();
  m[code] = token;
  // guarda só as 10 salas mais recentes
  const entries = Object.entries(m).slice(-10);
  localStorage.setItem(OWNER_KEY, JSON.stringify(Object.fromEntries(entries)));
}

export function getSavedNickname() {
  return localStorage.getItem(NICK_KEY) ?? "";
}
export function saveNickname(n: string) {
  localStorage.setItem(NICK_KEY, n);
}
