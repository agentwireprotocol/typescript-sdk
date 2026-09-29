/** One connection to a peer: the handshake, the reader, the FIFO writer and the timers (spec sections 7 and 9). */

import type { Duplex } from "node:stream";
import { LineSplitter, LineTooLongError } from "./framing.js";
import type { Peer } from "./peer.js";
import type { PeerState } from "./store.js";
import {
  ACKED_TYPES,
  BYE_TIMEOUT,
  CLOSING_ERR_CODES,
  HANDSHAKE_TIMEOUT,
  PRE_AUTH_FORBIDDEN,
  PROTOCOL_VERSION,
  RESUME_TIMEOUT,
  authPayload,
  b64decodeAny,
  b64url,
  ed25519Verify,
  encodeLine,
  parseKey,
} from "./wire.js";

type Item = ["entry", string] | ["once", string] | ["line", Buffer] | ["bye", Buffer];

export class Connection {
  readonly hello: Record<string, unknown>;
  readonly myHelloLine: Buffer;
  peerHelloLine: Buffer | null = null;
  peerHello: Record<string, unknown> | null = null;
  peerKeyRaw: Buffer | null = null;
  peerKeyStr: string | null = null;
  established = false;
  gotResume = false;
  live = false;
  ps: PeerState | null = null;
  closing = false;
  closeReason: string | null = null;
  outbound = false;
  dialed: string | undefined;
  readonly done: Promise<void>;
  private finish!: () => void;

  private queue: Item[] = [];
  private held: Item[] = [];
  private paused = false;
  private pumping = false;
  private byeQueued = false;
  private byeSent = false;
  private byeSentAt = 0;
  private linger = false;
  private readonly started = Date.now();
  private establishedAt = 0;
  private lastInbound = Date.now();
  private pingId: string | null = null;
  private pingAt = 0;
  private missed = 0;
  private timer: NodeJS.Timeout | null = null;
  private splitter = new LineSplitter();

  constructor(
    readonly peer: Peer,
    readonly duplex: Duplex,
    readonly label: string,
  ) {
    this.hello = peer.makeHello();
    this.myHelloLine = encodeLine(this.hello);
    this.done = new Promise<void>((r) => (this.finish = r));
  }

  /** Runs the connection until it ends; resolves with whether it was ever established. */
  async run(): Promise<boolean> {
    this.peer.allConns.add(this);
    this.duplex.on("data", (chunk: Buffer) => this.onData(chunk));
    this.duplex.on("end", () => this.close("connection closed by peer"));
    this.duplex.on("error", (e: Error) => this.close(`connection error: ${e.message}`));
    this.duplex.on("close", () => this.close("connection closed"));
    this.duplex.on("drain", () => {
      this.paused = false;
      this.pump();
    });
    this.write(this.myHelloLine);
    const iv = this.peer.pingInterval;
    const tick = iv <= 0 ? 250 : Math.max(20, Math.min(500, iv / 5));
    this.timer = setInterval(() => this.onTick(), tick);
    try {
      await this.done;
    } finally {
      if (this.timer) clearInterval(this.timer);
      await this.shutdown();
      this.peer.onConnClosed(this);
    }
    return this.established;
  }

  close(reason: string): void {
    if (this.closing) return;
    this.closing = true;
    this.closeReason = reason;
    this.finish();
  }

  private async shutdown(): Promise<void> {
    const d = this.duplex;
    if (this.linger && !d.destroyed && "end" in d) {
      // We sent a closing err: half-close and let the peer read it before a reset could destroy it.
      await new Promise<void>((r) => {
        const t = setTimeout(r, 1000);
        d.once("end", () => {
          clearTimeout(t);
          r();
        });
        try {
          d.end();
        } catch {
          clearTimeout(t);
          r();
        }
      });
    }
    d.destroy();
  }

  // -- writing --------------------------------------------------------------

  private write(line: Buffer): boolean {
    if (this.duplex.destroyed || this.duplex.writableEnded) return false;
    try {
      this.peer.trace?.("out", line);
      const ok = this.duplex.write(Buffer.concat([line, Buffer.from("\n")]));
      if (!ok) this.paused = true;
      return true;
    } catch (e) {
      this.close(`write failed: ${(e as Error).message}`);
      return false;
    }
  }

  /** Writes a control message at once, ahead of the FIFO. */
  sendNow(obj: Record<string, unknown>): boolean {
    if (this.byeSent || this.closing) return false;
    return this.write(encodeLine(obj));
  }

  sendErr(code: string, detail: string, re?: string, ref?: string): void {
    this.peer.log(`${this.label}: sending err ${code}: ${detail}`);
    this.sendNow(this.peer.makeErr(code, detail, re, ref));
  }

  /** Sends a closing err and closes. */
  fail(code: string, detail: string, re?: string): void {
    if (this.closing) return;
    if (!this.byeSent) this.write(encodeLine(this.peer.makeErr(code, detail, re)));
    this.peer.emitError(`${this.label}: sent err ${code}: ${detail}`);
    this.linger = true;
    this.close(`err ${code}: ${detail}`);
  }

  queueEntry(id: string): void {
    if (this.live && !this.byeQueued && !this.closing) {
      this.queue.push(["entry", id]);
      this.pump();
    }
  }

  queueOnce(id: string): void {
    if (this.live && !this.byeQueued && !this.closing) {
      this.queue.push(["once", id]);
      this.pump();
    }
  }

  queueAck(th: string, re: string): void {
    if (this.byeQueued || this.closing) return;
    const item: Item = ["line", encodeLine(this.peer.envelope("ack", { th, re }))];
    if (this.live) {
      this.queue.push(item);
      this.pump();
    } else {
      this.held.push(item); // never overtakes our own replay
    }
  }

  initiateBye(reason: string): string | null {
    if (this.byeQueued || this.byeSent || this.closing) return null;
    const obj = this.peer.envelope("bye", { reason });
    const line = encodeLine(obj);
    this.byeQueued = true;
    if (this.live) {
      this.queue.push(["bye", line]);
      this.pump();
    } else {
      this.write(line);
      this.byeSent = true;
      this.byeSentAt = Date.now();
    }
    return obj.id as string;
  }

  /** The peer's resume arrived: replay, then the held acks, then FIFO. */
  goLive(seen: Record<string, string>): void {
    if (this.live || this.closing || !this.ps) return;
    const ps = this.ps;
    this.peer.applySeen(ps, seen);
    const replay = [...ps.outbox.entries.keys()];
    for (const id of replay) this.queue.push(["entry", id]);
    for (const id of ps.sendOnce.items.keys()) this.queue.push(["once", id]);
    this.queue.push(...this.held);
    this.held = [];
    this.live = true;
    if (replay.length) this.peer.log(`${this.label}: replaying ${replay.length} outbox message(s)`);
    this.pump();
  }

  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (!this.closing && !this.paused && this.queue.length > 0 && !this.byeSent) {
        const [kind, val] = this.queue.shift()!;
        let line: Buffer;
        if (kind === "entry") {
          const e = this.ps!.outbox.entries.get(val);
          if (!e) continue; // pruned while queued
          try {
            line = this.peer.entryLine(e);
          } catch (ex) {
            this.peer.emitError(
              `cannot read outgoing blob data for ${val}: ${(ex as Error).message}; dropping it`,
            );
            this.peer.prune(this.ps!, val, "unreadable");
            continue;
          }
        } else if (kind === "once") {
          const obj = this.ps!.sendOnce.items.get(val);
          if (!obj) continue;
          line = encodeLine(obj);
        } else {
          line = val;
        }
        if (!this.write(line)) return;
        if (kind === "once") this.ps!.sendOnce.remove(val);
        else if (kind === "bye") {
          this.byeSent = true;
          this.byeSentAt = Date.now();
          this.queue = [];
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  // -- timers ---------------------------------------------------------------

  private onTick(): void {
    if (this.closing) return;
    const now = Date.now();
    if (!this.established) {
      if (now - this.started > HANDSHAKE_TIMEOUT) {
        this.peer.emitError(`${this.label}: handshake timed out`);
        this.close("handshake timeout");
      }
      return;
    }
    if (!this.gotResume && now - this.establishedAt > RESUME_TIMEOUT) {
      this.peer.log(
        `${this.label}: no resume from the peer within ${RESUME_TIMEOUT / 1000}s; replaying everything`,
      );
      this.gotResume = true;
      this.goLive({});
    }
    if (this.byeSent) {
      if (now - this.byeSentAt >= BYE_TIMEOUT) this.close("bye (the peer did not answer within 5s)");
      return;
    }
    const iv = this.peer.pingInterval;
    if (iv <= 0) return;
    if (this.pingId === null) {
      if (now - this.lastInbound >= iv) this.sendPing(now);
    } else if (now - this.pingAt >= iv) {
      this.missed++;
      if (this.missed >= 2) {
        this.close(`dead connection: ${this.missed} missed pongs`);
        return;
      }
      this.sendPing(now);
    }
  }

  private sendPing(now: number): void {
    const ping = this.peer.envelope("ping", {});
    this.pingId = ping.id as string;
    this.pingAt = now;
    this.sendNow(ping);
  }

  // -- reading --------------------------------------------------------------

  private onData(chunk: Buffer): void {
    if (this.closing) return;
    let lines: Buffer[];
    try {
      lines = this.splitter.push(chunk);
    } catch (e) {
      if (e instanceof LineTooLongError) this.fail("too_large", "line exceeds 1 MiB");
      else this.close(`read failed: ${(e as Error).message}`);
      return;
    }
    for (const line of lines) {
      if (this.closing) return;
      this.handleLine(line);
    }
  }

  private handleLine(line: Buffer): void {
    this.lastInbound = Date.now();
    this.pingId = null;
    this.missed = 0;
    if (line.toString("utf8").trim() === "") return;
    this.peer.trace?.("in", line);
    let obj: unknown;
    try {
      obj = JSON.parse(line.toString("utf8"));
    } catch (e) {
      this.fail("bad_frame", `line is not valid UTF-8 JSON: ${(e as Error).message}`);
      return;
    }
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
      this.fail("bad_frame", "line is not a JSON object");
      return;
    }
    const o = obj as Record<string, unknown>;
    const t = o.t;
    try {
      if (!this.established) this.handshake(line, o, t);
      else this.dispatch(o, t);
    } catch (e) {
      this.peer.log(`${this.label}: internal error handling ${String(t)}: ${(e as Error).stack ?? e}`);
      this.sendErr(
        "internal",
        `internal error handling ${String(t)}: ${(e as Error).message}`,
        typeof o.id === "string" ? o.id : undefined,
      );
    }
  }

  private handshake(line: Buffer, obj: Record<string, unknown>, t: unknown): void {
    const peer = this.peer;
    const oid = typeof obj.id === "string" ? obj.id : undefined;
    if (t === "hello") {
      if (this.peerHello !== null) {
        peer.log(`${this.label}: ignoring a repeated hello`);
        return;
      }
      peer.emitRecv(this, obj);
      const v = obj.v ?? 0;
      if (typeof v !== "number" || v !== PROTOCOL_VERSION) {
        this.fail(
          "version",
          `unsupported protocol version ${JSON.stringify(v)}; this peer speaks ${PROTOCOL_VERSION}`,
          oid,
        );
        return;
      }
      let raw: Buffer;
      try {
        raw = parseKey(obj.key);
      } catch (e) {
        this.fail("auth", `invalid key in hello: ${(e as Error).message}`, oid);
        return;
      }
      if (raw.equals(peer.identity.publicKey) || line.equals(this.myHelloLine)) {
        this.fail("auth", "hello carries our own key (reflected handshake)", oid);
        return;
      }
      this.peerHelloLine = line;
      this.peerHello = obj;
      this.peerKeyRaw = raw;
      this.peerKeyStr = obj.key as string;
      peer.log(`${this.label}: hello from ${this.peerKeyStr} name=${JSON.stringify(obj.name)}`);
      const sig = peer.identity.sign(authPayload(this.myHelloLine, line));
      const held = peer.held.valid();
      const auth = peer.envelope("auth", { sig: b64url(sig), grants: held.length ? held : undefined });
      this.write(encodeLine(auth));
      return;
    }
    if (t === "auth") {
      if (this.peerHello === null) {
        this.fail("auth", "auth received before hello", oid);
        return;
      }
      peer.emitRecv(this, obj);
      let sig: Buffer;
      try {
        sig = b64decodeAny(obj.sig);
      } catch {
        sig = Buffer.alloc(0);
      }
      if (!ed25519Verify(this.peerKeyRaw!, sig, authPayload(this.peerHelloLine!, this.myHelloLine))) {
        this.fail("auth", "auth signature does not verify", oid);
        return;
      }
      this.onEstablished(obj);
      return;
    }
    if (t === "err") {
      peer.emitRecv(this, obj);
      const code = obj.code as string;
      peer.emitError(
        `${this.label}: peer sent err ${code} during the handshake: ${String(obj.detail ?? "")}`,
      );
      if (CLOSING_ERR_CODES.has(code)) this.close(`peer sent err ${code}`);
      return;
    }
    if (t === "ping" || t === "pong") return;
    if (t === "bye") {
      peer.emitRecv(this, obj);
      this.close("bye before the handshake completed");
      return;
    }
    if (typeof t === "string" && PRE_AUTH_FORBIDDEN.has(t)) {
      this.fail("auth", `${t} received before the handshake completed`, oid);
      return;
    }
    peer.emitRecv(this, obj);
    peer.log(`${this.label}: ignoring unknown message type ${JSON.stringify(t)} during the handshake`);
  }

  private onEstablished(auth: Record<string, unknown>): void {
    const peer = this.peer;
    this.established = true;
    this.establishedAt = Date.now();
    this.ps = peer.bindPeer(this.peerKeyRaw!, this.peerKeyStr!, this.peerHello!);
    peer.registerConnection(this);
    if (Array.isArray(auth.grants)) for (const g of auth.grants) peer.receiveGrant(this, g, "auth");
    const h = this.peerHello!;
    const name = typeof h.name === "string" ? h.name : "";
    const caps = Array.isArray(h.caps) ? h.caps.filter((c): c is string => typeof c === "string") : [];
    const about = typeof h.about === "string" ? h.about : "";
    peer.log(`${this.label}: connected to ${this.peerKeyStr} (${name})`);
    peer.onConnected(this, name, caps, about);
    this.sendNow(peer.envelope("resume", { seen: { ...this.ps.inbox.seen } }));
  }

  private dispatch(obj: Record<string, unknown>, t: unknown): void {
    const peer = this.peer;
    if (t === "ping") {
      this.sendNow(peer.envelope("pong", { re: typeof obj.id === "string" ? obj.id : undefined }));
      return;
    }
    if (t === "pong") return;
    if (typeof t === "string" && ACKED_TYPES.has(t)) {
      peer.onMsgOrState(this, obj, t);
      return;
    }
    if (t === "chunk") {
      peer.onChunk(this, obj);
      return;
    }
    peer.emitRecv(this, obj);
    if (t === "ack") {
      if (typeof obj.re === "string") peer.prune(this.ps!, obj.re, "ack");
    } else if (t === "resume") {
      if (this.gotResume) {
        peer.log(`${this.label}: ignoring a repeated resume`);
        return;
      }
      this.gotResume = true;
      const seen: Record<string, string> = {};
      if (obj.seen && typeof obj.seen === "object") {
        for (const [k, v] of Object.entries(obj.seen as Record<string, unknown>))
          if (typeof v === "string") seen[k] = v;
      }
      this.goLive(seen);
    } else if (t === "grant") {
      peer.receiveGrant(this, obj.grant, "grant message");
    } else if (t === "introduce") {
      peer.onIntroduce(this, obj);
    } else if (t === "bye") {
      this.onBye(obj);
    } else if (t === "err") {
      this.onErr(obj);
    } else if (t === "hello" || t === "auth") {
      peer.log(`${this.label}: ignoring ${t} after the handshake`);
    }
  }

  private onBye(obj: Record<string, unknown>): void {
    this.peer.onByeExchange(this);
    if (!this.byeSent) {
      const reason = typeof obj.reason === "string" ? obj.reason : "bye";
      this.write(encodeLine(this.peer.envelope("bye", { reason })));
      this.byeSent = true;
      this.byeSentAt = Date.now();
    }
    this.close("bye");
  }

  private onErr(obj: Record<string, unknown>): void {
    const code = obj.code as string;
    const detail = typeof obj.detail === "string" ? obj.detail : "";
    if (code === "blob_refused") {
      let ref = typeof obj.ref === "string" ? obj.ref : null;
      if (!ref) ref = this.peer.refForEntry(this.ps!, obj.re);
      if (ref) this.peer.stopBlob(this.ps!, ref);
    }
    if (CLOSING_ERR_CODES.has(code)) {
      this.peer.emitError(`${this.label}: peer sent err ${code}: ${detail}`);
      this.close(`peer sent err ${code}: ${detail}`);
    } else {
      this.peer.log(`${this.label}: peer sent err ${code}: ${detail}`);
    }
  }
}
