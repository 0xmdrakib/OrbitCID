import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";
import * as dagPb from "@ipld/dag-pb";
import * as dagCbor from "@ipld/dag-cbor";
import { UnixFS } from "ipfs-unixfs";
import type { Env } from "./types";
import { first } from "./db";

export function parseCid(value: string): CID {
  return CID.parse(value);
}

export async function rawCid(bytes: Uint8Array): Promise<CID> {
  return CID.createV1(raw.code, await sha256.digest(bytes));
}

export async function verifyBlock(cid: CID, bytes: Uint8Array): Promise<boolean> {
  if (cid.multihash.code !== sha256.code) return false;
  const digest = await sha256.digest(bytes);
  if (digest.bytes.length !== cid.multihash.bytes.length) return false;
  return digest.bytes.every((byte, index) => byte === cid.multihash.bytes[index]);
}

export function codecName(code: number): string {
  if (code === raw.code) return "raw";
  if (code === dagPb.code) return "dag-pb";
  if (code === dagCbor.code) return "dag-cbor";
  return `0x${code.toString(16)}`;
}

export function blockKey(cid: CID | string): string {
  const value = typeof cid === "string" ? cid : cid.toString();
  return `blocks/${value.slice(0, 4)}/${value}`;
}

export interface LocatedBlock {
  cid: CID;
  bytes: Uint8Array;
}

export async function getBlock(env: Env, cidValue: CID | string): Promise<LocatedBlock | null> {
  const cid = typeof cidValue === "string" ? parseCid(cidValue) : cidValue;
  const stored = await env.BLOCKS.get(blockKey(cid));
  if (stored) return { cid, bytes: new Uint8Array(await stored.arrayBuffer()) };

  const location = await first<{ object_key: string; offset: number; length: number }>(
    env.DB.prepare("SELECT object_key, offset, length FROM block_locations WHERE cid = ? LIMIT 1").bind(cid.toString())
  );
  if (!location) return null;
  const object = await env.OBJECTS.get(location.object_key, { range: { offset: location.offset, length: location.length } });
  if (!object) return null;
  return { cid, bytes: new Uint8Array(await object.arrayBuffer()) };
}

export async function putBlock(env: Env, cid: CID, bytes: Uint8Array): Promise<void> {
  if (!(await verifyBlock(cid, bytes))) throw new Error(`CID mismatch for ${cid}`);
  const key = blockKey(cid);
  const existing = await env.BLOCKS.head(key);
  if (!existing) {
    await env.BLOCKS.put(key, bytes, {
      httpMetadata: { contentType: "application/vnd.ipld.raw" },
      customMetadata: { cid: cid.toString(), codec: codecName(cid.code) }
    });
  }
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO blocks (cid, codec, size, r2_key, ref_count, created_at, last_accessed_at) VALUES (?, ?, ?, ?, 0, ?, ?) ON CONFLICT(cid) DO UPDATE SET last_accessed_at = excluded.last_accessed_at"
  ).bind(cid.toString(), codecName(cid.code), bytes.length, key, now, now).run();
}

function collectCids(value: unknown, output: CID[]): void {
  if (CID.asCID(value)) {
    output.push(value as CID);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => collectCids(entry, output));
  } else if (value && typeof value === "object") {
    Object.values(value as Record<string, unknown>).forEach((entry) => collectCids(entry, output));
  }
}

export function decodeLinks(cid: CID, bytes: Uint8Array): CID[] {
  if (cid.code === raw.code) return [];
  if (cid.code === dagPb.code) return dagPb.decode(bytes).Links.map((link) => link.Hash);
  if (cid.code === dagCbor.code) {
    const links: CID[] = [];
    collectCids(dagCbor.decode(bytes), links);
    return links;
  }
  throw new Error(`Unsupported codec ${codecName(cid.code)}`);
}

export interface ResolvedUnixFs {
  cid: CID;
  type: "file" | "directory" | "raw";
  inlineData?: Uint8Array;
}

export async function resolveUnixFs(env: Env, root: CID, pathSegments: string[]): Promise<ResolvedUnixFs> {
  let current = root;
  for (const segment of pathSegments) {
    const block = await getBlock(env, current);
    if (!block || current.code !== dagPb.code) throw new Error("Path not found");
    const node = dagPb.decode(block.bytes);
    const unixfs = node.Data ? UnixFS.unmarshal(node.Data) : null;
    if (!unixfs?.isDirectory()) throw new Error("Path is not a directory");
    const link = node.Links.find((candidate) => candidate.Name === segment);
    if (!link) throw new Error("Path not found");
    current = link.Hash;
  }

  if (current.code === raw.code) return { cid: current, type: "raw" };
  const block = await getBlock(env, current);
  if (!block || current.code !== dagPb.code) return { cid: current, type: "file" };
  const node = dagPb.decode(block.bytes);
  const unixfs = node.Data ? UnixFS.unmarshal(node.Data) : null;
  if (unixfs?.isDirectory()) return { cid: current, type: "directory" };
  return { cid: current, type: "file", inlineData: node.Links.length === 0 ? unixfs?.data : undefined };
}

export async function walkDag(env: Env, root: CID, maxDepth: number, maxBlocks = 100_000): Promise<CID[]> {
  const seen = new Set<string>();
  const ordered: CID[] = [];
  const stack: Array<{ cid: CID; depth: number }> = [{ cid: root, depth: 0 }];
  while (stack.length) {
    const item = stack.pop()!;
    const key = item.cid.toString();
    if (seen.has(key)) continue;
    if (item.depth > maxDepth) throw new Error("DAG depth exceeds configured limit");
    if (seen.size >= maxBlocks) throw new Error("DAG block count exceeds configured limit");
    seen.add(key);
    ordered.push(item.cid);
    if (item.cid.code === raw.code) {
      const exists = await first<{ cid: string }>(env.DB.prepare("SELECT cid FROM blocks WHERE cid = ?").bind(key));
      if (!exists) throw new Error(`Missing raw block ${key}`);
      continue;
    }
    const block = await getBlock(env, item.cid);
    if (!block || !(await verifyBlock(item.cid, block.bytes))) throw new Error(`Missing or corrupt block ${key}`);
    for (const child of decodeLinks(item.cid, block.bytes)) stack.push({ cid: child, depth: item.depth + 1 });
  }
  return ordered;
}