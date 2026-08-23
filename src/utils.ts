import type { Context } from "hono";

export const CHUNK_SIZE = 1024 * 1024;
export const MIN_PART_SIZE = 5 * 1024 * 1024;
export const DEFAULT_PART_SIZE = 8 * 1024 * 1024;
export const MAX_PART_SIZE = 64 * 1024 * 1024;
export const MAX_DAG_BLOCK_SIZE = 2 * 1024 * 1024;

export function nowIso(): string {
  return new Date().toISOString();
}

export function addHours(date: Date, hours: number): string {
  return new Date(date.getTime() + hours * 3_600_000).toISOString();
}

export function jsonError(c: Context, status: number, code: string, message: string, details?: unknown): Response {
  return c.json({ error: { code, message, details } }, status as never);
}

export function clampPartSize(size: number, requested?: number): number {
  if (size === 0) return MIN_PART_SIZE;
  const selected = requested ?? DEFAULT_PART_SIZE;
  const rounded = Math.ceil(selected / CHUNK_SIZE) * CHUNK_SIZE;
  return Math.min(MAX_PART_SIZE, Math.max(MIN_PART_SIZE, rounded));
}

export function normalizePath(input: string): string {
  const decoded = decodeURIComponent(input || "/");
  const parts = decoded.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === ".." || part.includes("\\") || part.includes("\0"))) {
    throw new Error("Invalid path");
  }
  return `/${parts.join("/")}`;
}

export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function base64ToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const stride = 0x8000;
  for (let index = 0; index < bytes.length; index += stride) {
    binary += String.fromCharCode(...bytes.subarray(index, index + stride));
  }
  return btoa(binary);
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function safeFilename(value: string): string {
  return value.replace(/[\r\n"\\/]/g, "_").slice(0, 255) || "download";
}