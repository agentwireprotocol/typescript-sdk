/** The Peer: listen, connect, send, and receive events (spec). */

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  fsyncSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import type { Socket } from "node:net";
import { Connection } from "./connection.js";
import type * as ev from "./events.js";
import type { Part } from "./schema.js";
import {
  FSYNC,
  FileBackend,
  GrantList,
  MemoryBackend,
  PENDING,
  PeerState,
  loadOrCreateIdentity,
  type Backend,
  type OutboxEntry,
} from "./store.js";
import {
  TailcatListener,
  formatTarget,
  isLoopback,
  listen,
  openStream,
  parseAddr,
  type Target,
} from "./transport.js";
import {
  ACKED_TYPES,
  AwpError,
  BACKOFF_CAP,
  BACKOFF_INITIAL,
  CHUNK_SIZE,
  DEFAULT_BLOB_LIMIT,
  DEFAULT_GRANT_TTL,
  DEFAULT_PING_INTERVAL,
  HELLO_CAPS,
  Identity,
  MAX_LINE,
  PROTOCOL_VERSION,
  REQUEST_MIMES,
  UlidGen,
  b64decodeAny,
  b64std,
  b64url,
  blobRefs,
  encodeLine,
  formatKey,
  keyFingerprint,
  mintGrant,
  nowTs,
  parseKey,
  safeName,
  ulidDecode,
  verifyGrant,
} from "./wire.js";
import { randomBytes } from "node:crypto";

export interface PeerOptions {
  /**
   * The state directory: the identity, and per peer the outbox of unacked messages, received ids,
   * threads, grants and blobs. Omit it for a temporary directory with a fresh identity, kept in memory
   * apart from blob files and removed on close.
   */
  dir?: string;
  /** Sent in hello. Defaults to "awp-ts@<hostname>". */
  name?: string;
  about?: string;
  /** Keys whose grants are honored as this Peer's own. */
  trust?: string[];
  /** Idle time before a ping, in ms; default 30 000. 0 disables pings. */
  pingInterval?: number;
  /** The largest blob accepted or sent; default 50 MiB. */
  blobLimit?: number;
  /** The hello caps; default chat, blob, grant, introduce. */
  caps?: string[];
  /** The tailcat CLI, for tailcat addresses; default "tailcat" on PATH. */
  tailcat?: string;
  /** Receives the log; default: nothing. */
  log?: (line: string) => void;
  /** Receives every line sent ("out") and received ("in"). */
  trace?: (dir: "in" | "out", line: Buffer) => void;
}

export interface Sent {
  id: string;
  thread: string;
  to: string;
  newThread: boolean;
}

export interface SendOptions {
  /** Continues an existing thread; a new one starts otherwise. */
  thread?: string;
  /** Titles a new thread; derived from the text otherwise. */
  subject?: string;
  /** The id of the message this one answers. */
  replyTo?: string;
  /** Code or data parts after the text. Blob parts are made from files. */
  parts?: Part[];
  /** Files sent as blobs in chunks ahead of the message. */
  files?: string[];
}

export interface PeerInfo {
  key: string;
  name?: string;
  about?: string;
  caps: string[];
  connected: boolean;
  lastConnected?: string;
}

export interface ThreadInfo {
  id: string;
  peer: string;
  subject?: string;
  myState?: string;
  theirState?: string;
  closed: boolean;
}

type Waiter = { resolve: (e: ev.Event) => void; reject: (e: Error) => void };

/**
 * An AWP peer.
 *
 * ```ts
 * const peer = new Peer({ dir: "~/.mybot", name: "mybot@host" });
 * const address = await peer.listen("tcp:127.0.0.1:7000");
 * const key = await peer.connect("tcp:10.0.0.2:7000");
 * peer.send(key, "Please run make test.", { subject: "Run the suite" });
 * for await (const event of peer.events()) { ... }
 * ```
 */
export class Peer {
  readonly dir: string;
  readonly name: string;
  readonly about: string;
  readonly identity: Identity;
  readonly key: string;
  readonly pingInterval: number;
  readonly blobLimit: number;
  readonly helloCaps: string[];
  readonly held: GrantList;
  readonly issued: GrantList;
  readonly allConns = new Set<Connection>();
  readonly trace: ((dir: "in" | "out", line: Buffer) => void) | undefined;
  /** Every received line as an object, for drivers that want the raw protocol. */
  rawHook: ((obj: Record<string, unknown>) => void) | null = null;

  private readonly backend: Backend;
  private readonly ephemeral: boolean;
  private readonly logf: (line: string) => void;
  private readonly tailcatBin: string;
  private readonly ids = new UlidGen();
  private readonly trusted = new Set<string>();
  private readonly peers = new Map<string, PeerState>();
  private readonly pending: PeerState;
  private readonly connections = new Map<string, Connection>();
  private readonly parked = new Set<string>();
  private readonly servers: { server: import("node:net").Server; shown: string | null }[] = [];
  private tailcat: TailcatListener | null = null;
  private readonly dialers = new Map<string, { stop: () => void; done: Promise<void> }>();
  private readonly dialWaiters = new Map<
    string,
    { resolve: (k: string) => void; reject: (e: Error) => void }
  >();
  private readonly queue: ev.Event[] = [];
  private readonly waiters: Waiter[] = [];
  private wakeResolvers: (() => void)[] = [];
  private defaultFp: string | null = null;
  private closed = false;
  private connCounter = 0;
  private readonly announced = new Set<string>();
  private readonly blobParts = new Map<string, { name?: string; mime?: string; th?: string }>();
  private readonly outgoingDir: string;

  constructor(opts: PeerOptions = {}) {
    this.ephemeral = !opts.dir;
    this.dir = opts.dir
      ? opts.dir.replace(/^~(?=\/|$)/, process.env.HOME ?? "~")
      : mkdtempSync(join(tmpdir(), "awp-"));
    this.backend = this.ephemeral ? new MemoryBackend(this.dir) : new FileBackend(this.dir);
    this.outgoingDir = join(this.dir, "outgoing");
    mkdirSync(this.outgoingDir, { recursive: true });
    this.logf = opts.log ?? (() => {});
    this.trace = opts.trace;
    this.tailcatBin = opts.tailcat ?? "tailcat";
    this.name = opts.name ?? `awp-ts@${hostname()}`;
    this.pingInterval =
      opts.pingInterval === undefined
        ? DEFAULT_PING_INTERVAL
        : opts.pingInterval > 0
          ? Math.max(50, opts.pingInterval)
          : 0;
    this.blobLimit = opts.blobLimit ?? DEFAULT_BLOB_LIMIT;
    this.helloCaps = opts.caps ? [...opts.caps] : [...HELLO_CAPS];
    this.identity = loadOrCreateIdentity(this.backend);
    this.key = this.identity.key;
    this.about =
      opts.about ??
      `awp-typescript, key fingerprint sha256:${createHash("sha256").update(this.identity.publicKey).digest("hex").slice(0, 16)}`;
    for (const k of opts.trust ?? []) this.trusted.add(parseKey(k).toString("hex"));
    this.issued = new GrantList(this.backend, "grants_issued.json");
    this.held = new GrantList(this.backend, "grants_held.json");
    for (const fp of this.backend.listDirs("peers"))
      if (fp !== PENDING) this.peers.set(fp, new PeerState(this.backend, fp, this.outgoingDir));
    this.pending = new PeerState(this.backend, PENDING, this.outgoingDir);
    for (const ps of this.allPeerStates()) if (ps.outbox.maxId) this.ids.observe(ps.outbox.maxId);
    const dp = this.backend.readJson("default_peer.json", null) as { fp?: string } | null;
    if (dp?.fp && this.peers.has(dp.fp)) this.defaultFp = dp.fp;
    this.cleanupOutgoing();
    this.logf(`identity ${this.key}, state ${this.dir}`);
    for (const ps of this.peers.values()) {
      for (const ref of ps.inbox.toFinish) this.finishBlob(ps, ref);
      ps.inbox.toFinish = [];
    }
  }

  log(line: string): void {
    this.logf(line);
  }

  // -- lifecycle -------------------------------------------------------------

  /** Stops listening and dialing and drops every connection without a bye: peers resume next time. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const d of this.dialers.values()) d.stop();
    this.wake();
    for (const s of this.servers) s.server.close();
    for (const c of [...this.allConns]) c.close("closing");
    await Promise.all([...this.allConns].map((c) => Promise.race([c.done, delay(2000)])));
    await Promise.all([...this.dialers.values()].map((d) => Promise.race([d.done, delay(2000)])));
    this.tailcat?.close();
    this.tailcat = null;
    for (const w of this.waiters.splice(0)) w.reject(new AwpError("peer closed"));
    if (this.ephemeral) rmSync(this.dir, { recursive: true, force: true });
  }

  /** The addresses this Peer listens on, the tailcat one first. */
  get addresses(): string[] {
    const out = this.tailcat ? [`tailcat:${this.tailcat.address}`] : [];
    return out.concat(this.servers.map((s) => s.shown).filter((s): s is string => !!s));
  }

  /**
   * Accepts connections on tcp:HOST:PORT, unix:/path, or "tailcat": a WireGuard tunnel through the
   * tailcat CLI, reachable from anywhere. Returns the address to share, with the port that was bound.
   */
  async listen(addr = "tailcat"): Promise<string> {
    if (addr === "tailcat" || addr === "tailcat:") {
      const { server } = await listen({ kind: "tcp", host: "127.0.0.1", port: 0 }, (s) => this.accept(s));
      const a = server.address();
      const port = typeof a === "object" && a ? a.port : 0;
      this.servers.push({ server, shown: null });
      this.tailcat = await TailcatListener.start(this.tailcatBin, port, this.logf);
      const shown = `tailcat:${this.tailcat.address}`;
      this.logf(`listening on ${shown} (tailcat serve 1:127.0.0.1:${port})`);
      return shown;
    }
    const t = parseAddr(addr);
    if (t.kind === "tailcat") throw new AwpError('listen takes "tailcat", not an address');
    if (t.kind === "tcp" && !isLoopback(t.host))
      this.logf(
        "warning: plaintext TCP on a non-loopback address has no transport encryption (spec 4.2); trusted networks only",
      );
    const { server, shown } = await listen(t, (s) => this.accept(s));
    this.servers.push({ server, shown });
    this.logf(`listening on ${shown}`);
    return shown;
  }

  private accept(sock: Socket): void {
    sock.setNoDelay(true);
    this.connCounter++;
    const where = sock.remoteAddress ? `${sock.remoteAddress}:${sock.remotePort}` : "unix peer";
    const conn = new Connection(this, sock, `conn#${this.connCounter} from ${where}`);
    conn.run().catch((e) => this.logf(`${conn.label}: crashed: ${(e as Error).stack ?? e}`));
  }

  /**
   * Dials an address shared out of band and resolves with the peer's key once the handshake is done.
   * The Peer keeps dialing with backoff, capped at a minute, whenever there are unacked messages or
   * open threads with that peer.
   */
  connect(addr: string, timeoutMs: number | null = 30_000): Promise<string> {
    const t = parseAddr(addr);
    if (t.kind === "tcp" && !isLoopback(t.host))
      this.logf("warning: plaintext TCP to a non-loopback address; trusted networks only");
    for (const ps of this.peers.values()) {
      if (ps.meta.dialed === addr && this.connections.has(ps.fp) && this.dialers.has(addr))
        return Promise.resolve(ps.key);
    }
    return new Promise<string>((resolve, reject) => {
      this.dialWaiters.set(addr, { resolve, reject });
      if (!this.dialers.has(addr)) this.startDialer(addr, t);
      if (timeoutMs !== null) {
        setTimeout(() => {
          const w = this.dialWaiters.get(addr);
          if (w && w.resolve === resolve) {
            this.dialWaiters.delete(addr);
            this.dialers.get(addr)?.stop();
            reject(new AwpError(`no handshake with ${addr} within ${timeoutMs} ms`));
          }
        }, timeoutMs).unref?.();
      }
    });
  }

  private startDialer(addr: string, t: Target): void {
    let stopped = false;
    let wakeUp: (() => void) | null = null;
    const stop = () => {
      stopped = true;
      wakeUp?.();
      this.dialers.delete(addr);
    };
    const done = (async () => {
      let backoff = BACKOFF_INITIAL;
      let ps: PeerState | null = null;
      while (!stopped && !this.closed) {
        if (ps && (this.parked.has(ps.fp) || !(ps.hasWork() || this.pending.hasWork()))) {
          this.logf(`${addr}: idle; waiting for new work`);
          await new Promise<void>((r) => {
            wakeUp = r;
            this.wakeResolvers.push(r);
          });
          wakeUp = null;
          continue;
        }
        let stream;
        try {
          stream = await openStream(t, this.tailcatBin);
        } catch (e) {
          const d = backoff * (0.9 + Math.random() * 0.2);
          this.logf(`connect ${addr} failed: ${(e as Error).message}; retrying in ${(d / 1000).toFixed(2)}s`);
          await delay(d);
          backoff = Math.min(backoff * 2, BACKOFF_CAP);
          continue;
        }
        this.connCounter++;
        const conn = new Connection(this, stream.duplex, `conn#${this.connCounter} to ${addr}`);
        conn.outbound = true;
        conn.dialed = addr;
        const established = await conn.run().catch(() => false);
        stream.proc?.kill();
        if (established) {
          ps = conn.ps;
          backoff = BACKOFF_INITIAL;
          continue;
        }
        const d = backoff * (0.9 + Math.random() * 0.2);
        this.logf(`reconnecting to ${addr} in ${(d / 1000).toFixed(2)}s`);
        await delay(d);
        backoff = Math.min(backoff * 2, BACKOFF_CAP);
      }
    })();
    this.dialers.set(addr, { stop, done });
  }

  private wake(): void {
    for (const r of this.wakeResolvers.splice(0)) r();
  }

  // -- what the connections call ---------------------------------------------

  makeHello(): Record<string, unknown> {
    return this.envelope("hello", {
      v: PROTOCOL_VERSION,
      key: this.key,
      name: this.name,
      nonce: b64url(randomBytes(32)),
      caps: [...this.helloCaps],
      about: this.about,
    });
  }

  makeErr(code: string, detail: string, re?: string, ref?: string): Record<string, unknown> {
    return this.envelope("err", { re, code, detail, ref });
  }

  envelope(t: string, fields: Record<string, unknown>): Record<string, unknown> {
    const obj: Record<string, unknown> = { t, id: this.ids.new(), ts: nowTs() };
    for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) obj[k] = v;
    return obj;
  }

  entryLine(e: OutboxEntry): Buffer {
    let obj = e.obj;
    if (obj.t === "chunk" && e.src) {
      const fd = openSync(join(this.outgoingDir, e.src), "r");
      try {
        const buf = Buffer.alloc(e.len!);
        const n = readFileSync(fd, { flag: "r" }).copy(buf, 0, e.off!, e.off! + e.len!);
        if (n !== e.len) throw new AwpError("outgoing blob copy is shorter than expected");
        obj = { ...obj, data: b64std(buf) };
      } finally {
        closeSync(fd);
      }
    }
    return encodeLine(obj);
  }

  private emit(e: ev.Event): void {
    const w = this.waiters.shift();
    if (w) w.resolve(e);
    else this.queue.push(e);
  }

  emitError(detail: string): void {
    this.logf(`error: ${detail}`);
    this.emit({ type: "local-error", peer: "", detail });
  }

  onConnected(conn: Connection, name: string, caps: string[], about: string): void {
    const key = conn.peerKeyStr!;
    if (conn.dialed) {
      conn.ps!.meta.dialed = conn.dialed;
      conn.ps!.saveMeta(key, null);
      const w = this.dialWaiters.get(conn.dialed);
      if (w) {
        this.dialWaiters.delete(conn.dialed);
        w.resolve(key);
      }
    }
    this.parked.delete(conn.ps!.fp);
    this.emit({ type: "connected", peer: key, name, caps, about, outbound: conn.outbound });
  }

  emitRecv(conn: Connection, obj: Record<string, unknown>): void {
    if (this.rawHook) {
      const shown =
        obj.t === "chunk" && "data" in obj
          ? Object.fromEntries(Object.entries(obj).filter(([k]) => k !== "data"))
          : obj;
      this.rawHook(shown);
    }
    const peer = conn.peerKeyStr ?? "";
    const t = obj.t;
    const id = typeof obj.id === "string" ? obj.id : "";
    const th = typeof obj.th === "string" ? obj.th : undefined;
    const str = (k: string) => (typeof obj[k] === "string" ? (obj[k] as string) : undefined);
    if (t === "msg" && th !== undefined) {
      const parts = (
        Array.isArray(obj.parts) ? obj.parts.filter((p) => p && typeof p === "object") : []
      ) as Part[];
      const text = parts
        .filter((p) => p.k === "text")
        .map((p) => (p as { text: string }).text)
        .join("\n");
      this.emit({
        type: "message",
        peer,
        id,
        thread: th,
        parts,
        text,
        subject: str("subject"),
        replyTo: str("re"),
        requests: this.requestsIn(conn.ps!, obj),
      });
    } else if (t === "state" && th !== undefined) {
      this.emit({ type: "state", peer, id, thread: th, state: String(obj.state), note: str("note") });
    } else if (t === "err") {
      this.emit({
        type: "error",
        peer,
        code: String(obj.code),
        detail: str("detail"),
        replyTo: str("re"),
        ref: str("ref"),
      });
    } else if (t === "bye") {
      this.emit({ type: "bye", peer, reason: str("reason") });
    }
  }

  private requestsIn(ps: PeerState, obj: Record<string, unknown>): ev.Request[] {
    const out: ev.Request[] = [];
    if (!Array.isArray(obj.parts)) return out;
    let caps: Set<string> | null = null;
    obj.parts.forEach((p, i) => {
      if (!p || typeof p !== "object" || (p as Part).k !== "data") return;
      const mime = String((p as { mime?: string }).mime ?? "")
        .trim()
        .toLowerCase();
      const cap = REQUEST_MIMES[mime];
      if (!cap) return;
      caps ??= this.honoredCaps(ps);
      out.push({ part: i, mime, cap, allowed: caps.has(cap) });
    });
    return out;
  }

  // -- peers and connections ---------------------------------------------------

  private allPeerStates(): PeerState[] {
    return [...this.peers.values(), this.pending];
  }

  private peerStateFor(raw: Buffer, keyStr: string): PeerState {
    const fp = keyFingerprint(raw);
    let ps = this.peers.get(fp);
    if (!ps) {
      ps = new PeerState(this.backend, fp, this.outgoingDir, raw, keyStr);
      this.peers.set(fp, ps);
    }
    return ps;
  }

  bindPeer(raw: Buffer, keyStr: string, hello: Record<string, unknown>): PeerState {
    const ps = this.peerStateFor(raw, keyStr);
    ps.saveMeta(keyStr, hello);
    if (this.defaultFp === null) ps.adopt(this.pending); // what was queued before any peer was known
    if (this.defaultFp !== ps.fp) {
      this.defaultFp = ps.fp;
      this.backend.writeJson("default_peer.json", { fp: ps.fp, key: formatKey(raw) }, true);
    }
    return ps;
  }

  registerConnection(conn: Connection): void {
    const old = this.connections.get(conn.ps!.fp);
    if (old && old !== conn) {
      this.logf(`${old.label}: superseded by ${conn.label} (same key)`);
      old.close("superseded by a newer connection from the same key");
    }
    this.connections.set(conn.ps!.fp, conn);
  }

  onConnClosed(conn: Connection): void {
    this.allConns.delete(conn);
    if (conn.ps && this.connections.get(conn.ps.fp) === conn) this.connections.delete(conn.ps.fp);
    const reason = conn.closeReason ?? "closed";
    this.logf(`${conn.label}: closed (${reason})`);
    if (conn.established) this.emit({ type: "disconnected", peer: conn.peerKeyStr ?? "", reason });
    if (conn.dialed) {
      const w = this.dialWaiters.get(conn.dialed);
      if (w && !conn.established && this.closed) {
        this.dialWaiters.delete(conn.dialed);
        w.reject(new AwpError("peer closed"));
      }
    }
  }

  onByeExchange(conn: Connection): void {
    if (conn.ps) this.parked.add(conn.ps.fp);
  }

  /** The state for a peer key; null means the default peer, or the pending queue before any connected. */
  private ps(to: string | null): PeerState {
    if (to === null) {
      const d = this.defaultFp ? this.peers.get(this.defaultFp) : undefined;
      return d ?? this.pending;
    }
    return this.peerStateFor(parseKey(to), to);
  }

  private newWork(ps: PeerState): void {
    this.parked.delete(ps.fp);
    this.wake();
  }

  private cleanupOutgoing(): void {
    const used = new Set<string>();
    for (const ps of this.allPeerStates()) for (const s of ps.outbox.srcCount.keys()) used.add(s);
    for (const name of readdirSync(this.outgoingDir))
      if (!used.has(name)) rmSync(join(this.outgoingDir, name), { force: true });
  }

  // -- outbox ------------------------------------------------------------------

  private queueOutbox(ps: PeerState, entries: OutboxEntry[]): void {
    const fresh = ps.outbox.addMany(entries); // durable before sending
    for (const e of fresh) {
      const obj = e.obj;
      if (ACKED_TYPES.has(obj.t as string) && typeof obj.th === "string") ps.threads.touch(obj.th, obj, true);
    }
    const conn = this.connections.get(ps.fp);
    if (conn) for (const e of fresh) conn.queueEntry(e.obj.id as string);
    this.newWork(ps);
  }

  prune(ps: PeerState, id: string, via: string): void {
    const e = ps.outbox.entries.get(id);
    if (!e) return;
    const t = e.obj.t as string;
    if (ACKED_TYPES.has(t)) this.emit({ type: "acked", peer: ps.key, id });
    ps.outbox.remove(id);
    if (t === "msg")
      for (const ref of blobRefs(e.obj))
        for (const cid of [...(ps.outbox.byRef.get(ref) ?? [])]) ps.outbox.remove(cid);
    void via;
  }

  applySeen(ps: PeerState, seen: Record<string, string>): void {
    const usable: Record<string, string> = {};
    for (const [th, sid] of Object.entries(seen)) {
      if (ulidDecode(sid) === null)
        this.logf(
          `warning: the peer's seen id ${sid} for thread ${th} is not one of our ids; replaying the whole thread`,
        );
      else usable[th] = sid.toUpperCase();
    }
    if (Object.keys(usable).length === 0) return;
    for (const id of [...ps.outbox.entries.keys()]) {
      const e = ps.outbox.entries.get(id);
      if (!e) continue;
      const th = e.obj.th;
      if (typeof th === "string" && th in usable && id <= usable[th]!) this.prune(ps, id, "resume seen");
    }
  }

  stopBlob(ps: PeerState, ref: string): void {
    const ids = [...(ps.outbox.byRef.get(ref) ?? [])];
    for (const cid of ids) ps.outbox.remove(cid);
    this.logf(`peer refused blob ${ref}; dropped ${ids.length} queued chunk(s)`);
  }

  refForEntry(ps: PeerState, id: unknown): string | null {
    const e = typeof id === "string" ? ps.outbox.entries.get(id) : undefined;
    if (!e) return null;
    if (e.obj.t === "chunk") return (e.obj.ref as string) ?? null;
    const refs = blobRefs(e.obj);
    return refs.length === 1 ? refs[0]! : null;
  }

  // -- inbound ----------------------------------------------------------------

  onMsgOrState(conn: Connection, obj: Record<string, unknown>, t: string): void {
    const ps = conn.ps!;
    const mid = typeof obj.id === "string" && obj.id ? obj.id : null;
    const th = typeof obj.th === "string" && obj.th ? obj.th : null;
    if (mid !== null && ps.inbox.dedup.has(mid)) {
      if (th !== null) conn.queueAck(th, mid);
      return;
    }
    if (mid === null) this.logf(`${conn.label}: warning: ${t} without an id cannot be acked or deduplicated`);
    else ps.inbox.record({ id: mid, t, th }, true); // persist, then report, then ack
    if (th !== null) ps.threads.touch(th, obj, false);
    else if (mid !== null)
      this.logf(`${conn.label}: warning: ${t} ${mid} has no th; delivered but not acked`);
    this.emitRecv(conn, obj);
    if (t === "msg") this.inspectParts(conn, obj, mid);
    if (mid !== null && th !== null) conn.queueAck(th, mid);
  }

  private inspectParts(conn: Connection, obj: Record<string, unknown>, mid: string | null): void {
    const ps = conn.ps!;
    if (!Array.isArray(obj.parts)) return;
    const needs = new Set<string>();
    for (const p of obj.parts as Record<string, unknown>[]) {
      if (!p || typeof p !== "object") continue;
      if (p.k === "blob") {
        const ref = p.ref;
        const size = p.size;
        if (typeof ref === "string" && typeof size === "number" && Number.isInteger(size)) {
          ps.inbox.declared.set(ref, size);
          this.blobParts.set(`${ps.fp}/${ref}`, {
            name: p.name as string | undefined,
            mime: p.mime as string | undefined,
            th: obj.th as string | undefined,
          });
          if (size > this.blobLimit && !ps.inbox.done.has(ref) && !ps.inbox.refused.has(ref)) {
            this.refuseBlob(
              conn,
              ps,
              ref,
              mid,
              `declared blob size ${size} exceeds the local limit of ${this.blobLimit} bytes`,
            );
          } else if (ps.inbox.done.has(ref)) {
            this.announceBlob(ps, ref); // the data came first
          }
        }
      } else if (p.k === "data") {
        const cap =
          REQUEST_MIMES[
            String(p.mime ?? "")
              .trim()
              .toLowerCase()
          ];
        if (cap) needs.add(cap);
      }
    }
    if (needs.size) {
      const caps = this.honoredCaps(ps);
      const missing = [...needs].filter((c) => !caps.has(c)).sort();
      if (missing.length)
        conn.sendErr(
          "forbidden",
          `request needs capability ${missing.join(", ")} and this peer holds no honored grant for it`,
          mid ?? undefined,
        );
    }
  }

  onChunk(conn: Connection, obj: Record<string, unknown>): void {
    const ps = conn.ps!;
    const inbox = ps.inbox;
    const cid = typeof obj.id === "string" && obj.id ? obj.id : null;
    const th = typeof obj.th === "string" && obj.th ? obj.th : null;
    if (cid !== null && inbox.dedup.has(cid)) return;
    this.emitRecv(conn, obj);
    const ref = obj.ref;
    if (typeof ref !== "string" || !ref) {
      this.logf(`${conn.label}: warning: chunk ${cid} has no ref; ignored`);
      return;
    }
    const base: Record<string, unknown> = { id: cid, t: "chunk", th, ref };
    if (inbox.refused.has(ref) || inbox.done.has(ref)) {
      if (cid) inbox.record({ ...base, stored: false }, false);
      return;
    }
    const st = inbox.partial.get(ref);
    const expected = st ? st.next : 0;
    let n = obj.n;
    if (typeof n !== "number" || !Number.isInteger(n)) n = expected;
    if ((n as number) < expected) {
      if (cid) inbox.record({ ...base, n, stored: false }, false);
      return;
    }
    if ((n as number) > expected) {
      conn.sendErr(
        "internal",
        `blob ${ref}: got chunk ${n} but chunk ${expected} was expected; chunk ignored`,
        cid ?? undefined,
      );
      return;
    }
    let data: Buffer;
    try {
      data = b64decodeAny(obj.data ?? "");
    } catch (e) {
      this.refuseBlob(conn, ps, ref, cid, `chunk data is not valid base64: ${(e as Error).message}`);
      if (cid) inbox.record({ ...base, n, stored: false }, false);
      return;
    }
    const total = (st ? st.size : 0) + data.length;
    if (total > this.blobLimit) {
      this.refuseBlob(
        conn,
        ps,
        ref,
        cid,
        `blob ${ref} exceeds the local size limit of ${this.blobLimit} bytes`,
      );
      if (cid) inbox.record({ ...base, n, stored: false }, false);
      return;
    }
    const last = obj.last === true;
    mkdirSync(inbox.partialDir, { recursive: true });
    const fd = openSync(inbox.partialPath(ref), st ? "a" : "w", 0o600);
    try {
      writeSync(fd, data);
      if (FSYNC) fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    inbox.record({ ...base, n, len: data.length, last, stored: true }, false);
    if (last) this.finishBlob(ps, ref);
  }

  private refuseBlob(conn: Connection, ps: PeerState, ref: string, re: string | null, detail: string): void {
    if (ps.inbox.refused.has(ref)) return;
    conn.sendErr("blob_refused", detail, re ?? undefined, ref);
    ps.inbox.record({ op: "blob_refused", ref }, false);
    rmSync(ps.inbox.partialPath(ref), { force: true });
  }

  private finishBlob(ps: PeerState, ref: string): void {
    const inbox = ps.inbox;
    const src = inbox.partialPath(ref);
    const dst = inbox.finalPath(ref);
    if (existsSync(src)) renameSync(src, dst);
    const data = readFileSync(dst);
    const digest = createHash("sha256").update(data).digest("hex");
    const declared = inbox.declared.get(ref);
    if (declared !== undefined && declared !== data.length)
      this.logf(`warning: blob ${ref} is ${data.length} bytes but its blob part declared ${declared}`);
    this.logf(`blob ${ref} complete: ${data.length} bytes -> ${dst}`);
    inbox.record({ op: "blob_done", ref, path: dst, size: data.length, sha256: digest }, true);
    if (this.blobParts.has(`${ps.fp}/${ref}`)) this.announceBlob(ps, ref);
  }

  /** A blob is reported once its data is complete and the msg naming it has arrived, whichever came last. */
  private announceBlob(ps: PeerState, ref: string): void {
    const k = `${ps.fp}/${ref}`;
    if (this.announced.has(k)) return;
    const rec = ps.inbox.done.get(ref);
    if (!rec) return;
    this.announced.add(k);
    const part = this.blobParts.get(k) ?? {};
    this.emit({
      type: "blob",
      peer: ps.key,
      ref,
      path: rec.path as string,
      size: rec.size as number,
      sha256: rec.sha256 as string,
      thread: part.th,
      name: part.name,
      mime: part.mime,
    });
  }

  // -- grants --------------------------------------------------------------------

  private isRoot(raw: Buffer): boolean {
    return raw.equals(this.identity.publicKey) || this.trusted.has(raw.toString("hex"));
  }

  private grantHonored(g: Record<string, unknown>, ps: PeerState): boolean {
    if (!verifyGrant(g)[0]) return false;
    const iss = parseKey(g.iss);
    if (this.isRoot(iss)) return true;
    const supporting = [...ps.grants.items, ...this.issued.items, ...this.held.items];
    for (const s of supporting) {
      if (s === g || s.sig === g.sig || !verifyGrant(s)[0]) continue;
      try {
        if (
          parseKey(s.sub).equals(iss) &&
          Array.isArray(s.caps) &&
          s.caps.includes("introduce") &&
          this.isRoot(parseKey(s.iss))
        )
          return true;
      } catch {
        continue;
      }
    }
    return false;
  }

  private honoredCaps(ps: PeerState): Set<string> {
    const caps = new Set<string>();
    if (!ps.keyRaw) return caps;
    const raw = ps.keyRaw;
    const matches = (sub: unknown) => {
      try {
        return parseKey(sub).equals(raw);
      } catch {
        return false;
      }
    };
    const cands = [...ps.grants.items, ...this.issued.items.filter((g) => matches(g.sub))];
    for (const g of cands) {
      if (matches(g.sub) && this.grantHonored(g, ps))
        for (const c of (g.caps as unknown[]) ?? []) if (typeof c === "string") caps.add(c);
    }
    return caps;
  }

  receiveGrant(conn: Connection, g: unknown, source: string): void {
    const [ok, why] = verifyGrant(g);
    if (!ok) {
      this.logf(`${conn.label}: ignoring an invalid grant (${source}): ${why}`);
      return;
    }
    const grant = g as Record<string, unknown>;
    const sub = parseKey(grant.sub);
    conn.ps!.grants.add(grant);
    const caps = ((grant.caps as unknown[]) ?? []).filter((c): c is string => typeof c === "string");
    if (sub.equals(this.identity.publicKey)) {
      const fresh = this.held.add(grant);
      this.logf(`${conn.label}: now holding grant [${caps}] from ${grant.iss} (${source})`);
      if (fresh)
        this.emit({
          type: "grant",
          peer: conn.peerKeyStr ?? "",
          issuer: grant.iss as string,
          caps,
          expires: String(grant.exp),
          grant: { ...grant },
        });
    } else if (conn.peerKeyRaw && sub.equals(conn.peerKeyRaw)) {
      this.logf(
        `${conn.label}: the peer presented grant [${caps}] issued by ${grant.iss} (${source}): ${this.grantHonored(grant, conn.ps!) ? "honored" : "not honored (issuer not trusted)"}`,
      );
    } else {
      this.logf(`${conn.label}: stored grant [${caps}] for a third party ${grant.sub} (${source})`);
    }
  }

  onIntroduce(conn: Connection, obj: Record<string, unknown>): void {
    const g = obj.grant;
    if (g !== undefined && g !== null) this.receiveGrant(conn, g, "introduce");
    const p = (obj.peer && typeof obj.peer === "object" ? obj.peer : {}) as Record<string, unknown>;
    if (typeof p.key !== "string") return;
    this.backend.appendLog(
      "introductions.jsonl",
      [{ from: conn.peerKeyStr, at: nowTs(), th: obj.th, peer: p }],
      false,
    );
    this.logf(`${conn.label}: introduced to ${p.key}`);
    this.emit({
      type: "introduced",
      peer: conn.peerKeyStr ?? "",
      key: p.key,
      name: typeof p.name === "string" ? p.name : undefined,
      address: typeof p.address === "string" ? p.address : undefined,
      thread: typeof obj.th === "string" ? obj.th : undefined,
      grant: g && typeof g === "object" ? { ...(g as Record<string, unknown>) } : undefined,
    });
  }

  // -- the API -------------------------------------------------------------------

  /**
   * Queues a msg to the peer `to` (its key; null for the default peer). `text` becomes the first part;
   * `parts` adds code or data parts; each of `files` travels as a blob in chunks ahead of the message.
   * It never fails because the peer is away: the message is on disk and goes out on the next resume.
   */
  send(to: string | null, text?: string | null, opts: SendOptions = {}): Sent {
    const ps = this.ps(to);
    const parts: Part[] = [];
    if (text !== undefined && text !== null) parts.push({ k: "text", text });
    for (const p of opts.parts ?? []) {
      if (!p || typeof p !== "object" || typeof (p as Part).k !== "string")
        throw new AwpError("parts must be objects with a k");
      if ((p as Part).k === "blob") throw new AwpError("blob parts are made from files");
      parts.push({ ...p });
    }
    const entries: OutboxEntry[] = [];
    const newThread = opts.thread === undefined || !(opts.thread in ps.threads.data);
    const th = opts.thread ?? `thr_${this.ids.new().toLowerCase().slice(-10)}`;
    for (const path of opts.files ?? []) {
      const [part, chunkEntries] = this.chunkFile(path, th);
      entries.push(...chunkEntries);
      parts.push(part);
    }
    if (parts.length === 0) throw new AwpError("empty message: give text, parts or files");
    let subject = opts.subject;
    if (newThread && subject === undefined) subject = deriveSubject(parts);
    const obj = this.envelope("msg", { th, re: opts.replyTo, subject, parts });
    if (encodeLine(obj).length > MAX_LINE)
      throw new AwpError("the message would exceed the 1 MiB line limit; send it as a file");
    entries.push({ obj });
    this.queueOutbox(ps, entries);
    return { id: obj.id as string, thread: th, to: ps.key || to || "", newThread };
  }

  private chunkFile(path: string, th: string): [Part, OutboxEntry[]] {
    let st;
    try {
      st = statSync(path);
    } catch (e) {
      throw new AwpError(`cannot read ${path}: ${(e as Error).message}`);
    }
    if (!st.isFile()) throw new AwpError(`${path} is not a regular file`);
    if (st.size > this.blobLimit)
      throw new AwpError(`${path} is ${st.size} bytes; the blob limit is ${this.blobLimit}`);
    const ref = `blob_${this.ids.new().toLowerCase()}`;
    const src = safeName(ref);
    const dst = join(this.outgoingDir, src);
    copyFileSync(path, dst); // an immutable copy: the chunks read from it
    if (FSYNC) {
      const fd = openSync(dst, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    const size = statSync(dst).size;
    const name = basename(path);
    const mime = mimeOf(name);
    const n = Math.max(1, Math.ceil(size / CHUNK_SIZE));
    const entries: OutboxEntry[] = [];
    for (let i = 0; i < n; i++) {
      const off = i * CHUNK_SIZE;
      entries.push({
        obj: this.envelope("chunk", { th, ref, n: i, last: i === n - 1 }),
        src,
        off,
        len: Math.min(CHUNK_SIZE, size - off),
      });
    }
    return [{ k: "blob", ref, name, mime, size }, entries];
  }

  /** Sends this side's state on a thread: working, waiting, done, failed, closed, or any word the agents agree on. */
  setState(to: string | null, thread: string, state: string, note?: string): Sent {
    if (!state) throw new AwpError("state is required");
    const ps = this.ps(to);
    const obj = this.envelope("state", { th: thread, state, note });
    this.queueOutbox(ps, [{ obj }]);
    return { id: obj.id as string, thread, to: ps.key || to || "", newThread: false };
  }

  /** Mints a grant giving the peer the capabilities for `ttl` seconds, remembers it, and sends it. */
  grant(to: string, caps: string[], ttl = DEFAULT_GRANT_TTL): Record<string, unknown> {
    const ps = this.ps(to);
    if (ttl <= 0) throw new AwpError("ttl must be positive");
    const g = mintGrant(this.identity, to, caps, ttl) as unknown as Record<string, unknown>;
    this.issued.add(g);
    const obj = this.envelope("grant", { grant: g });
    ps.sendOnce.add(obj);
    this.connections.get(ps.fp)?.queueOnce(obj.id as string);
    this.newWork(ps);
    this.logf(`minted grant [${caps}] for ${to}, expires ${String(g.exp)}`);
    return g;
  }

  /** The capabilities the peer holds on this Peer, from honored grants. */
  caps(to: string): Set<string> {
    return this.honoredCaps(this.ps(to));
  }

  /** Closes the connection to the peer gracefully and parks it: no reconnection until something new is queued. */
  async bye(to: string, reason = "done"): Promise<void> {
    const ps = this.ps(to);
    this.parked.add(ps.fp);
    const conn = this.connections.get(ps.fp);
    if (!conn || !conn.established || conn.closing)
      throw new AwpError("not connected (the peer is parked all the same)");
    conn.initiateBye(reason);
    await Promise.race([conn.done, delay(6000)]);
  }

  connected(to: string): boolean {
    const ps = this.peers.get(keyFingerprint(parseKey(to)));
    const conn = ps && this.connections.get(ps.fp);
    return !!conn && conn.established && !conn.closing;
  }

  listPeers(): PeerInfo[] {
    const out: PeerInfo[] = [];
    for (const ps of this.peers.values()) {
      if (!ps.keyRaw) continue;
      out.push({
        key: ps.key,
        name: ps.meta.name,
        about: ps.meta.about,
        caps: ps.meta.caps ?? [],
        connected: this.connected(ps.key),
        lastConnected: ps.meta.last_connected,
      });
    }
    return out;
  }

  threads(to?: string): ThreadInfo[] {
    const out: ThreadInfo[] = [];
    const raw = to ? parseKey(to) : null;
    for (const ps of this.peers.values()) {
      if (!ps.keyRaw || (raw && !ps.keyRaw.equals(raw))) continue;
      for (const [id, rec] of Object.entries(ps.threads.data))
        out.push({
          id,
          peer: ps.key,
          subject: rec.subject,
          myState: rec.mine,
          theirState: rec.theirs,
          closed: rec.closed,
        });
    }
    return out;
  }

  /** Resolves once the peer acks the message `id`. */
  async waitAck(id: string, timeoutMs?: number): Promise<void> {
    const deadline = timeoutMs === undefined ? null : Date.now() + timeoutMs;
    for (const ps of this.allPeerStates()) {
      if (!ps.outbox.entries.has(id)) continue;
      while (ps.outbox.entries.has(id)) {
        if (deadline !== null && Date.now() >= deadline)
          throw new AwpError(`no ack for ${id} within ${timeoutMs} ms`);
        await delay(50);
      }
      return;
    }
  }

  /** The next event, or a rejection after `timeoutMs`. */
  nextEvent(timeoutMs?: number): Promise<ev.Event> {
    const e = this.queue.shift();
    if (e) return Promise.resolve(e);
    if (this.closed) return Promise.reject(new AwpError("peer closed"));
    return new Promise<ev.Event>((resolve, reject) => {
      const w: Waiter = { resolve, reject };
      this.waiters.push(w);
      if (timeoutMs !== undefined) {
        setTimeout(() => {
          const i = this.waiters.indexOf(w);
          if (i >= 0) {
            this.waiters.splice(i, 1);
            reject(new AwpError(`no event within ${timeoutMs} ms`));
          }
        }, timeoutMs).unref?.();
      }
    });
  }

  /** Every event from now on, in order, until the Peer is closed. */
  async *events(): AsyncGenerator<ev.Event> {
    while (!this.closed) {
      try {
        yield await this.nextEvent();
      } catch {
        return;
      }
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function deriveSubject(parts: Part[]): string | undefined {
  for (const p of parts) {
    if (p.k === "text" && p.text.trim()) {
      const s = p.text.trim().split("\n", 1)[0]!;
      return s.length <= 80 ? s : s.slice(0, 77) + "...";
    }
  }
  for (const p of parts) if (p.k === "blob" && p.name) return p.name;
  return undefined;
}

const MIMES: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".log": "text/plain",
  ".json": "application/json",
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".ts": "text/typescript",
  ".py": "text/x-python",
  ".go": "text/x-go",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
  ".csv": "text/csv",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
};

function mimeOf(name: string): string {
  return MIMES[extname(name).toLowerCase()] ?? "application/octet-stream";
}
