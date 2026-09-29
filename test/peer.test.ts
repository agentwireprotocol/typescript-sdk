import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as ev from "../src/events.js";
import { Peer } from "../src/peer.js";
import { verifyGrant } from "../src/wire.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "awp-ts-test-"));
}

async function nextOf<T extends ev.Event["type"]>(
  peer: Peer,
  type: T,
  timeoutMs = 15_000,
): Promise<Extract<ev.Event, { type: T }>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`no ${type} within ${timeoutMs} ms`);
    const e = await peer.nextEvent(left);
    if (e.type === type) return e as Extract<ev.Event, { type: T }>;
  }
}

describe("Peer", () => {
  test("a conversation: messages, states, a blob, a grant, bye", async () => {
    const dir = tmp();
    const a = new Peer({ dir: join(dir, "a"), name: "a@test", pingInterval: 2000 });
    const b = new Peer({ dir: join(dir, "b"), name: "b@test", pingInterval: 2000 });
    try {
      const addr = await b.listen(`unix:${join(dir, "b.sock")}`);
      expect(b.addresses).toEqual([addr]);
      const key = await a.connect(addr, 10_000);
      expect(key).toBe(b.key);
      const cb = await nextOf(b, "connected");
      expect(cb.peer).toBe(a.key);
      expect(cb.name).toBe("a@test");
      expect(cb.outbound).toBe(false);
      const ca = await nextOf(a, "connected");
      expect(ca.outbound).toBe(true);

      const sent = a.send(key, "Please run make test.", {
        subject: "Run the suite",
        parts: [{ k: "data", mime: "application/json", data: { repo: "x" } }],
      });
      expect(sent.newThread).toBe(true);
      const m = await nextOf(b, "message");
      expect([m.peer, m.thread, m.subject, m.text]).toEqual([
        a.key,
        sent.thread,
        "Run the suite",
        "Please run make test.",
      ]);
      expect((m.parts[1] as { data: unknown }).data).toEqual({ repo: "x" });
      expect(m.requests).toEqual([]);
      expect((await nextOf(a, "acked")).id).toBe(sent.id);
      await a.waitAck(sent.id, 5000);

      b.setState(a.key, m.thread, "working", "running");
      const s = await nextOf(a, "state");
      expect([s.thread, s.state, s.note]).toEqual([m.thread, "working", "running"]);
      const reply = b.send(a.key, "3 of 42 failing", { thread: m.thread, replyTo: m.id });
      const r = await nextOf(a, "message");
      expect([r.id, r.replyTo, r.text, r.subject]).toEqual([reply.id, m.id, "3 of 42 failing", undefined]);
      const th = a.threads(key).find((t) => t.id === m.thread)!;
      expect([th.subject, th.theirState, th.closed]).toEqual(["Run the suite", "working", false]);

      // A file goes as a blob, in several chunks, and arrives byte for byte.
      const path = join(dir, "log.txt");
      const data = Buffer.from("integration output\n".repeat(30_000));
      writeFileSync(path, data);
      a.send(key, "log attached", { thread: m.thread, files: [path] });
      const blob = await nextOf(b, "blob");
      expect([blob.name, blob.size, blob.thread, blob.mime]).toEqual([
        "log.txt",
        data.length,
        m.thread,
        "text/plain",
      ]);
      expect(readFileSync(blob.path).equals(data)).toBe(true);

      // A grant from a to b; b holds it, a honors it; a request b may not make is refused.
      const g = a.grant(key, ["fs:read"], 3600);
      expect(verifyGrant(g)[0]).toBe(true);
      const gr = await nextOf(b, "grant");
      expect([gr.issuer, gr.caps]).toEqual([a.key, ["fs:read"]]);
      expect([...a.caps(key)]).toEqual(["fs:read"]);
      b.send(a.key, null, {
        thread: m.thread,
        parts: [{ k: "data", mime: "application/vnd.awp.exec+json", data: { cmd: ["ls"] } }],
      });
      const req = await nextOf(a, "message");
      expect(req.requests[0]).toEqual({
        part: 0,
        mime: "application/vnd.awp.exec+json",
        cap: "exec",
        allowed: false,
      });
      const err = await nextOf(b, "error");
      expect([err.code, err.replyTo]).toEqual(["forbidden", req.id]);

      const peers = a.listPeers();
      expect(peers.length).toBe(1);
      expect([peers[0]!.key, peers[0]!.connected, peers[0]!.name]).toEqual([b.key, true, "b@test"]);

      await b.bye(a.key, "done");
      expect((await nextOf(a, "bye")).reason).toBe("done");
      await nextOf(a, "disconnected");
      expect(a.connected(key)).toBe(false);
    } finally {
      await a.close();
      await b.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("messages queued while the peer is away arrive after it is back, and survive a restart", async () => {
    const dir = tmp();
    const bDir = join(dir, "b");
    const bSock = `unix:${join(dir, "b.sock")}`;
    let a = new Peer({ dir: join(dir, "a"), name: "a@test", pingInterval: 1000 });
    let b = new Peer({ dir: bDir, name: "b@test" });
    try {
      await b.listen(bSock);
      const key = await a.connect(bSock, 10_000);
      await nextOf(a, "connected");
      await b.close();
      await nextOf(a, "disconnected");

      const sent = Array.from({ length: 20 }, (_, i) =>
        a.send(key, `message ${i}`, { thread: "t1", subject: "queued" }),
      );
      expect(a.connected(key)).toBe(false);

      b = new Peer({ dir: bDir, name: "b@test" });
      await b.listen(bSock);
      const got: ev.Message[] = [];
      for (let i = 0; i < 20; i++) got.push(await nextOf(b, "message", 30_000));
      expect(got.map((m) => m.text)).toEqual(sent.map((_, i) => `message ${i}`));
      expect(got.map((m) => m.id)).toEqual(sent.map((s) => s.id));
      for (const s of sent) await a.waitAck(s.id, 10_000);
      await b.close();

      // a restarts with a message queued: it goes out when b is reachable.
      await a.close();
      a = new Peer({ dir: join(dir, "a"), name: "a@test", pingInterval: 1000 });
      const late = a.send(key, "after the restart", { thread: "t1" });
      b = new Peer({ dir: bDir, name: "b@test" });
      await b.listen(bSock);
      await a.connect(bSock, 10_000);
      const m = await nextOf(b, "message", 30_000);
      expect([m.id, m.text]).toEqual([late.id, "after the restart"]);
    } finally {
      await a.close();
      await b.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an ephemeral peer keeps nothing", async () => {
    const p = new Peer({ name: "tmp@test" });
    const dir = p.dir;
    expect(p.key.startsWith("ed25519:")).toBe(true);
    expect(p.addresses).toEqual([]);
    await p.close();
    expect(() => readFileSync(join(dir, "identity.json"))).toThrow();
  });
});
