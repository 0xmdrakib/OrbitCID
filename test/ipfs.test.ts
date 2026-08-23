import { describe, expect, it } from "vitest";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import * as raw from "multiformats/codecs/raw";
import * as dagPb from "@ipld/dag-pb";
import { UnixFS } from "ipfs-unixfs";
import { importer } from "ipfs-unixfs-importer";
import { fixedSize } from "ipfs-unixfs-importer/chunker";
import { CarReader, CarWriter } from "@ipld/car";
import { codecName, decodeLinks, rawCid, verifyBlock } from "../src/ipfs";
import { CHUNK_SIZE } from "../src/utils";

async function collectCar(root: CID, blocks: Array<{ cid: CID; bytes: Uint8Array }>): Promise<Uint8Array> {
  const { writer, out } = CarWriter.create([root]);
  const chunks: Uint8Array[] = [];
  const drain = (async () => { for await (const chunk of out) chunks.push(chunk); })();
  for (const block of blocks) await writer.put(block);
  await writer.close();
  await drain;
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

describe("IPFS primitives", () => {
  it("creates and verifies a CIDv1 raw block", async () => {
    const bytes = new TextEncoder().encode("hello private ipfs");
    const cid = await rawCid(bytes);
    expect(cid.version).toBe(1);
    expect(cid.code).toBe(raw.code);
    expect(codecName(cid.code)).toBe("raw");
    expect(await verifyBlock(cid, bytes)).toBe(true);
    expect(await verifyBlock(cid, new TextEncoder().encode("tampered"))).toBe(false);
  });

  it("decodes links from a UnixFS DAG-PB node", async () => {
    const leafBytes = new TextEncoder().encode("linked data");
    const leaf = await rawCid(leafBytes);
    const unixfs = new UnixFS({ type: "file", blockSizes: [BigInt(leafBytes.length)] });
    const nodeBytes = dagPb.encode({ Data: unixfs.marshal(), Links: [{ Hash: leaf, Name: "", Tsize: leafBytes.length }] });
    const node = CID.createV1(dagPb.code, await sha256.digest(nodeBytes));
    expect(await verifyBlock(node, nodeBytes)).toBe(true);
    expect(decodeLinks(node, nodeBytes).map(String)).toEqual([leaf.toString()]);
  });

  it("uses one MiB raw leaves for a multi-chunk UnixFS file", async () => {
    const content = new Uint8Array(CHUNK_SIZE * 2 + 7).fill(42);
    const stored = new Map<string, Uint8Array>();
    let root: CID | null = null;
    for await (const entry of importer([{ path: "large.bin", content }], {
      put: async (cid, bytes) => { if (!(bytes instanceof Uint8Array)) throw new Error("unexpected stream"); stored.set(cid.toString(), bytes); return cid; }
    }, { cidVersion: 1, rawLeaves: true, chunker: fixedSize({ chunkSize: CHUNK_SIZE }) })) root = entry.cid;
    expect(root).not.toBeNull();
    expect(root!.code).toBe(dagPb.code);
    const rawBlocks = [...stored.keys()].map((value) => CID.parse(value)).filter((cid) => cid.code === raw.code);
    expect(rawBlocks).toHaveLength(2); // the two identical 1 MiB chunks deduplicate to one CID
    expect(decodeLinks(root!, stored.get(root!.toString())!)).toHaveLength(3);
  });

  it("round-trips verified blocks through CARv1", async () => {
    const bytes = new TextEncoder().encode("car round trip");
    const cid = await rawCid(bytes);
    const car = await collectCar(cid, [{ cid, bytes }]);
    const reader = await CarReader.fromBytes(car);
    expect((await reader.getRoots()).map(String)).toEqual([cid.toString()]);
    const block = await reader.get(cid);
    expect(block?.bytes).toEqual(bytes);
  });
});