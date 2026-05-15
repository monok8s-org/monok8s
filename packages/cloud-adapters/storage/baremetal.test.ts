/**
 * @jest-environment node
 *
 * Runtime contract test for the bare-metal MinIO StorageAdapter. Hermetic
 * via stubbed MinIO client surface — the test verifies the adapter
 * wiring (each StorageAdapter method delegates to the right MinIO client
 * method with the right shape) rather than running a real S3 round-trip.
 * Real-S3 round-trip against an in-process fake-server lands as a
 * follow-up if/when one is needed; the wiring-level contract here matches
 * what #110's AC asks for in scope.
 */
import { describe, beforeEach, it, expect } from "@jest/globals";

import { newBaremetalAdapter } from "./baremetal";

// Minimal Mocked-shape MinIO client surface — only the methods our
// StorageAdapter uses. Each is a hand-rolled spy capturing call args.
type Call = readonly unknown[];
type Spy = ((...args: unknown[]) => unknown) & { calls: Call[] };

const spy = (returns: (call: Call) => unknown): Spy => {
  const calls: Call[] = [];
  const fn = ((...args: unknown[]) => {
    calls.push(args);
    return returns(args);
  }) as Spy;
  fn.calls = calls;
  return fn;
};

interface FakeClient {
  putObject: Spy;
  getObject: Spy;
  removeObject: Spy;
  listObjectsV2: Spy;
}

const newFakeClient = (overrides: Partial<FakeClient> = {}): FakeClient => ({
  putObject:     overrides.putObject     ?? spy(() => Promise.resolve({ etag: "deadbeef" })),
  getObject:     overrides.getObject     ?? spy(() => Promise.resolve(asyncIterableOf([]))),
  removeObject:  overrides.removeObject  ?? spy(() => Promise.resolve(undefined)),
  listObjectsV2: overrides.listObjectsV2 ?? spy(() => emptyEmitter()),
});

// Async iterable over the supplied chunks — matches the shape minio's
// getObject returns to its caller.
const asyncIterableOf = (chunks: Uint8Array[]): AsyncIterable<Uint8Array> => ({
  [Symbol.asyncIterator]() {
    let i = 0;
    return {
      async next() {
        return i < chunks.length
          ? { value: chunks[i++]!, done: false }
          : { value: undefined as unknown as Uint8Array, done: true };
      },
    };
  },
});

// EventEmitter-style stub matching what minio.listObjectsV2 returns —
// the adapter consumes it via `on("data", ...)` / `on("end", ...)`.
type Emitter = { on: (ev: string, cb: (arg?: unknown) => void) => Emitter };
const emptyEmitter = (): Emitter => ({
  on(ev, cb) {
    if (ev === "end") setImmediate(() => cb());
    return this;
  },
});
const emitterWithObjects = (objs: { name: string }[]): Emitter => ({
  on(ev, cb) {
    if (ev === "data") setImmediate(() => objs.forEach((o) => cb(o)));
    if (ev === "end") setImmediate(() => setImmediate(() => cb()));
    return this;
  },
});

describe("cloud-adapters/storage/baremetal — runtime wiring contract", () => {
  let client: FakeClient;

  beforeEach(() => {
    client = newFakeClient();
  });

  it("put forwards body to client.putObject with the bound bucket", async () => {
    const adapter = newBaremetalAdapter(client as never, "tenant-bucket");
    await adapter.put("keys/u1.json", new TextEncoder().encode("hello"));
    expect(client.putObject.calls).toHaveLength(1);
    const [bucket, key, buf] = client.putObject.calls[0]!;
    expect(bucket).toBe("tenant-bucket");
    expect(key).toBe("keys/u1.json");
    expect(new TextDecoder().decode(buf as Uint8Array)).toBe("hello");
  });

  it("get streams client.getObject output and returns concatenated bytes", async () => {
    const chunks = [new TextEncoder().encode("hel"), new TextEncoder().encode("lo")];
    client.getObject = spy(() => Promise.resolve(asyncIterableOf(chunks)));
    const adapter = newBaremetalAdapter(client as never, "tenant-bucket");
    const got = await adapter.get("keys/u1.json");
    expect(new TextDecoder().decode(got)).toBe("hello");
    expect(client.getObject.calls[0]).toEqual(["tenant-bucket", "keys/u1.json"]);
  });

  it("delete forwards to client.removeObject", async () => {
    const adapter = newBaremetalAdapter(client as never, "tenant-bucket");
    await adapter.delete("keys/u1.json");
    expect(client.removeObject.calls[0]).toEqual(["tenant-bucket", "keys/u1.json"]);
  });

  it("list accumulates names from the client.listObjectsV2 event stream", async () => {
    client.listObjectsV2 = spy(() =>
      emitterWithObjects([{ name: "prefix/a.json" }, { name: "prefix/b.json" }]),
    );
    const adapter = newBaremetalAdapter(client as never, "tenant-bucket");
    const keys = await adapter.list("prefix/");
    expect(keys).toEqual(["prefix/a.json", "prefix/b.json"]);
    expect(client.listObjectsV2.calls[0]).toEqual(["tenant-bucket", "prefix/", true]);
  });
});
