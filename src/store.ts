/**
 * Durable state: per peer, an append-only outbox log of unacked messages, an inbox log of received ids
 * and blob progress, the threads and the grants. A FileBackend keeps it on disk so kill -9 loses
 * nothing; a MemoryBackend keeps it in memory for tests and short-lived tools.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import {
  AwpError,
  SEEN_TYPES,
  b64decodeAny,
  b64url,
  formatKey,
  keyFingerprint,
  nowTs,
  parseKey,
  parseRfc3339,
  Identity,
} from "./wire.js";

export const FSYNC = process.env.AWP_FSYNC !== "0";
export const PENDING = "_pending";

/** Where a store keeps its files: a directory, or memory. */
export interface Backend {
  readonly dir: string;
  readJson(name: string, fallback: unknown): unknown;
  writeJson(name: string, value: unknown, durable?: boolean): void;
  readLog(name: string): Record<string, unknown>[];
  appendLog(name: string, records: Record<string, unknown>[], durable?: boolean): void;
  rewriteLog(name: string, records: Record<string, unknown>[]): void;
  listDirs(name: string): string[];
  ensureDir(name: string): void;
  /** The file at `name`, for blob data; memory backends give a temporary directory. */
  path(name: string): string;
}

export class FileBackend implements Backend {
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  path(name: string): string {
    return join(this.dir, name);
  }

  ensureDir(name: string): void {
    mkdirSync(this.path(name), { recursive: true });
  }

  listDirs(name: string): string[] {
    const p = this.path(name);
    if (!existsSync(p)) return [];
    return readdirSync(p, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  }

  readJson(name: string, fallback: unknown): unknown {
    try {
      return JSON.parse(readFileSync(this.path(name), "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback;
      return fallback;
    }
  }

  writeJson(name: string, value: unknown, durable = false): void {
    const p = this.path(name);
    mkdirSync(join(p, ".."), { recursive: true });
    const tmp = `${p}.tmp${process.pid}`;
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, JSON.stringify(value));
      if (durable && FSYNC) fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, p);
  }

  readLog(name: string): Record<string, unknown>[] {
    const p = this.path(name);
    let data: Buffer;
    try {
      data = readFileSync(p);
    } catch {
      return [];
    }
    const end = data.lastIndexOf(10) + 1;
    if (end < data.length) truncateSync(p, end); // a torn final record
    const out: Record<string, unknown>[] = [];
    for (const line of data.subarray(0, end).toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (rec && typeof rec === "object") out.push(rec);
      } catch {
        // a corrupt record is skipped
      }
    }
    return out;
  }

  appendLog(name: string, records: Record<string, unknown>[], durable = true): void {
    const p = this.path(name);
    mkdirSync(join(p, ".."), { recursive: true });
    const fd = openSync(p, "a", 0o600);
    try {
      writeSync(fd, records.map((r) => JSON.stringify(r) + "\n").join(""));
      if (durable && FSYNC) fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  rewriteLog(name: string, records: Record<string, unknown>[]): void {
    const p = this.path(name);
    const tmp = `${p}.compact`;
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, records.map((r) => JSON.stringify(r) + "\n").join(""));
      if (FSYNC) fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, p);
  }
}

export class MemoryBackend implements Backend {
  private json = new Map<string, string>();
  private logs = new Map<string, Record<string, unknown>[]>();
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  path(name: string): string {
    return join(this.dir, name);
  }
  ensureDir(name: string): void {
    mkdirSync(this.path(name), { recursive: true });
  }
  listDirs(): string[] {
    return [];
  }
  readJson(name: string, fallback: unknown): unknown {
    const s = this.json.get(name);
    return s === undefined ? fallback : JSON.parse(s);
  }
  writeJson(name: string, value: unknown): void {
    this.json.set(name, JSON.stringify(value));
  }
  readLog(name: string): Record<string, unknown>[] {
    return [...(this.logs.get(name) ?? [])];
  }
  appendLog(name: string, records: Record<string, unknown>[]): void {
    const l = this.logs.get(name) ?? [];
    l.push(...records);
    this.logs.set(name, l);
  }
  rewriteLog(name: string, records: Record<string, unknown>[]): void {
    this.logs.set(name, [...records]);
  }
  destroy(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- identity

export function loadOrCreateIdentity(backend: Backend): Identity {
  const rec = backend.readJson("identity.json", null) as { seed?: string } | null;
  if (rec && typeof rec.seed === "string") {
    const seed = b64decodeAny(rec.seed);
    if (seed.length !== 32) throw new AwpError("identity.json: seed must be 32 bytes");
    return new Identity(seed);
  }
  const id = Identity.generate();
  backend.writeJson(
    "identity.json",
    { alg: "ed25519", seed: b64url(id.seed), key: id.key, created: nowTs() },
    true,
  );
  return id;
}

// ---------------------------------------------------------------- outbox

export interface OutboxEntry {
  obj: Record<string, unknown>;
  /** For chunks: the file in outgoing/, and the slice of it. */
  src?: string;
  off?: number;
  len?: number;
}

/** Unacked outbound msg/state/chunk entries, in send order. */
export class Outbox {
  entries = new Map<string, OutboxEntry>();
  byRef = new Map<string, Set<string>>();
  srcCount = new Map<string, number>();
  maxId: string | null = null;
  private dels = 0;

  constructor(
    private backend: Backend,
    private name: string,
    private outgoingDir: string,
  ) {
    for (const rec of backend.readLog(name)) {
      if (rec.op === "add") {
        const e = rec.e as OutboxEntry;
        if (Outbox.valid(e) && !this.entries.has(e.obj.id as string)) this.memAdd(e);
      } else if (rec.op === "del") {
        if (this.memDel(rec.id) !== null) this.dels++;
      } else if (rec.op === "mark") {
        this.noteId(rec.id);
      }
    }
    if (this.dels) this.compact();
  }

  private static valid(e: unknown): e is OutboxEntry {
    const o = e as OutboxEntry | null;
    return (
      !!o &&
      !!o.obj &&
      typeof o.obj === "object" &&
      typeof o.obj.id === "string" &&
      typeof o.obj.t === "string"
    );
  }

  private noteId(id: unknown): void {
    if (typeof id === "string" && (this.maxId === null || id > this.maxId)) this.maxId = id;
  }

  private memAdd(e: OutboxEntry): void {
    const id = e.obj.id as string;
    this.entries.set(id, e);
    this.noteId(id);
    if (e.obj.t === "chunk") {
      const ref = e.obj.ref as string;
      if (!this.byRef.has(ref)) this.byRef.set(ref, new Set());
      this.byRef.get(ref)!.add(id);
      if (e.src) this.srcCount.set(e.src, (this.srcCount.get(e.src) ?? 0) + 1);
    }
  }

  private memDel(id: unknown): OutboxEntry | null {
    if (typeof id !== "string") return null;
    const e = this.entries.get(id);
    if (!e) return null;
    this.entries.delete(id);
    if (e.obj.t === "chunk") {
      const ref = e.obj.ref as string;
      const ids = this.byRef.get(ref);
      if (ids) {
        ids.delete(id);
        if (ids.size === 0) this.byRef.delete(ref);
      }
      if (e.src) {
        const n = (this.srcCount.get(e.src) ?? 0) - 1;
        if (n <= 0) this.srcCount.delete(e.src);
        else this.srcCount.set(e.src, n);
      }
    }
    return e;
  }

  /** Adds entries durably; returns the ones that were new. */
  addMany(entries: OutboxEntry[]): OutboxEntry[] {
    const fresh = entries.filter((e) => !this.entries.has(e.obj.id as string));
    if (fresh.length) {
      this.backend.appendLog(
        this.name,
        fresh.map((e) => ({ op: "add", e })),
        true,
      );
      for (const e of fresh) this.memAdd(e);
    }
    return fresh;
  }

  remove(id: string): OutboxEntry | null {
    const e = this.memDel(id);
    if (!e) return null;
    this.backend.appendLog(this.name, [{ op: "del", id }], false);
    this.dels++;
    if (e.src && !this.srcCount.has(e.src)) {
      try {
        rmSync(join(this.outgoingDir, e.src));
      } catch {
        // gone already
      }
    }
    if (this.dels > 512 && this.dels > 4 * this.entries.size) this.compact();
    return e;
  }

  compact(): void {
    const recs: Record<string, unknown>[] = [];
    if (this.maxId) recs.push({ op: "mark", id: this.maxId });
    for (const e of this.entries.values()) recs.push({ op: "add", e });
    this.backend.rewriteLog(this.name, recs);
    this.dels = 0;
  }

  reset(): void {
    this.entries.clear();
    this.byRef.clear();
    this.srcCount.clear();
    this.compact();
  }
}

// ---------------------------------------------------------------- inbox

interface Partial {
  next: number;
  size: number;
  last: boolean;
}

/** What we durably received from one peer: the dedup set, per-thread seen ids, blob progress. */
export class Inbox {
  dedup = new Set<string>();
  seen: Record<string, string> = {};
  partial = new Map<string, Partial>();
  done = new Map<string, Record<string, unknown>>();
  refused = new Set<string>();
  declared = new Map<string, number>();
  toFinish: string[] = [];
  readonly blobDir: string;
  readonly partialDir: string;

  constructor(
    private backend: Backend,
    private name: string,
    blobDirName: string,
  ) {
    this.blobDir = backend.path(blobDirName);
    this.partialDir = join(this.blobDir, ".partial");
    for (const rec of backend.readLog(name)) this.apply(rec);
    this.reconcile();
  }

  partialPath(ref: string): string {
    return join(this.partialDir, safeRef(ref));
  }
  finalPath(ref: string): string {
    return join(this.blobDir, safeRef(ref));
  }

  private apply(rec: Record<string, unknown>): void {
    const ref = rec.ref as string;
    if (rec.op === "blob_done") {
      this.done.set(ref, rec);
      this.partial.delete(ref);
      return;
    }
    if (rec.op === "blob_refused") {
      this.refused.add(ref);
      this.partial.delete(ref);
      return;
    }
    const { id, t, th } = rec;
    if (typeof id === "string") {
      this.dedup.add(id);
      if (typeof th === "string" && SEEN_TYPES.has(t as string)) this.seen[th] = id;
    }
    if (t === "chunk" && rec.stored) {
      let st = this.partial.get(ref);
      if (!st) {
        st = { next: 0, size: 0, last: false };
        this.partial.set(ref, st);
      }
      st.next = Number(rec.n ?? 0) + 1;
      st.size += Number(rec.len ?? 0);
      st.last = !!rec.last;
    }
  }

  record(rec: Record<string, unknown>, durable = true): void {
    this.backend.appendLog(this.name, [rec], durable);
    this.apply(rec);
  }

  private reconcile(): void {
    for (const [ref, st] of [...this.partial]) {
      const p = this.partialPath(ref);
      const final = this.finalPath(ref);
      if (!existsSync(p)) {
        if (st.last && existsSync(final) && statSync(final).size === st.size) this.toFinish.push(ref);
        else this.partial.delete(ref);
        continue;
      }
      const size = statSync(p).size;
      if (size > st.size) truncateSync(p, st.size);
      else if (size < st.size) {
        this.partial.delete(ref);
        rmSync(p, { force: true });
        continue;
      }
      if (st.last) this.toFinish.push(ref);
    }
  }
}

function safeRef(s: string): string {
  let name = s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  if (name === "" || name.startsWith(".")) name = "b_" + name;
  return name;
}

// ---------------------------------------------------------------- threads, one-shot messages, grants

export interface ThreadRecord {
  subject?: string;
  mine?: string;
  theirs?: string;
  closed: boolean;
}

export class Threads {
  data: Record<string, ThreadRecord>;

  constructor(
    private backend: Backend,
    private name: string,
  ) {
    const d = backend.readJson(name, {});
    this.data = d && typeof d === "object" ? (d as Record<string, ThreadRecord>) : {};
  }

  touch(th: string, obj: Record<string, unknown>, outgoing: boolean): void {
    let rec = this.data[th];
    let changed = false;
    if (!rec) {
      rec = this.data[th] = { closed: false };
      if (typeof obj.subject === "string") rec.subject = obj.subject;
      changed = true;
    }
    let closed = false;
    if (obj.t === "state") {
      const st = obj.state as string;
      closed = st === "closed";
      const side = outgoing ? "mine" : "theirs";
      if (rec[side] !== st) {
        rec[side] = st;
        changed = true;
      }
    }
    if (rec.closed !== closed) {
      rec.closed = closed;
      changed = true;
    }
    if (changed) this.save();
  }

  anyOpen(): boolean {
    return Object.values(this.data).some((r) => !r.closed);
  }

  merge(other: Threads): void {
    for (const [th, rec] of Object.entries(other.data)) if (!(th in this.data)) this.data[th] = rec;
    this.save();
  }

  clear(): void {
    this.data = {};
    this.save();
  }

  save(): void {
    this.backend.writeJson(this.name, this.data);
  }
}

/** Messages sent once and not acked (grants). */
export class SendOnce {
  items = new Map<string, Record<string, unknown>>();

  constructor(
    private backend: Backend,
    private name: string,
  ) {
    const l = backend.readJson(name, []);
    if (Array.isArray(l)) for (const o of l) if (o && typeof o.id === "string") this.items.set(o.id, o);
  }

  add(obj: Record<string, unknown>): void {
    this.items.set(obj.id as string, obj);
    this.save();
  }
  remove(id: string): void {
    if (this.items.delete(id)) this.save();
  }
  clear(): void {
    this.items.clear();
    this.save();
  }
  save(): void {
    this.backend.writeJson(this.name, [...this.items.values()], true);
  }
}

export class GrantList {
  items: Record<string, unknown>[] = [];

  constructor(
    private backend: Backend,
    private name: string,
  ) {
    const l = backend.readJson(name, []);
    if (Array.isArray(l)) this.items = l.filter((g) => g && typeof g === "object");
    this.prune();
  }

  prune(): void {
    const now = Date.now() / 1000;
    const keep = this.items.filter((g) => parseRfc3339(g.exp) > now);
    if (keep.length !== this.items.length) {
      this.items = keep;
      this.save();
    }
  }

  add(g: Record<string, unknown>): boolean {
    if (this.items.some((x) => x.sig === g.sig)) return false;
    this.items.push(g);
    this.save();
    return true;
  }

  valid(): Record<string, unknown>[] {
    this.prune();
    return [...this.items];
  }

  remove(sig: unknown): boolean {
    const keep = this.items.filter((g) => g.sig !== sig);
    if (keep.length === this.items.length) return false;
    this.items = keep;
    this.save();
    return true;
  }

  save(): void {
    this.backend.writeJson(this.name, this.items);
  }
}

// ---------------------------------------------------------------- per peer

export interface PeerMeta {
  key?: string;
  key_as_sent?: string;
  name?: string;
  about?: string;
  caps?: string[];
  last_connected?: string;
  dialed?: string;
  addr?: string;
}

/** All durable state about one remote key (or the pending queue). */
export class PeerState {
  readonly dir: string;
  meta: PeerMeta;
  keyRaw: Buffer | null;
  keyStr: string | null;
  outbox: Outbox;
  inbox: Inbox;
  threads: Threads;
  sendOnce: SendOnce;
  grants: GrantList;

  constructor(
    readonly backend: Backend,
    readonly fp: string,
    outgoingDir: string,
    keyRaw: Buffer | null = null,
    keyStr: string | null = null,
  ) {
    this.dir = `peers/${fp}`;
    backend.ensureDir(this.dir);
    const meta = backend.readJson(`${this.dir}/peer.json`, {});
    this.meta = meta && typeof meta === "object" ? (meta as PeerMeta) : {};
    if (keyRaw === null && fp !== PENDING && this.meta.key) {
      try {
        keyRaw = parseKey(this.meta.key);
        keyStr = this.meta.key_as_sent ?? this.meta.key;
      } catch {
        keyRaw = null;
      }
    }
    this.keyRaw = keyRaw;
    this.keyStr = keyStr;
    this.outbox = new Outbox(backend, `${this.dir}/outbox.log`, outgoingDir);
    this.inbox = new Inbox(backend, `${this.dir}/inbox.log`, `blobs/${fp}`);
    this.threads = new Threads(backend, `${this.dir}/threads.json`);
    this.sendOnce = new SendOnce(backend, `${this.dir}/sendonce.json`);
    this.grants = new GrantList(backend, `${this.dir}/grants.json`);
    if (keyRaw && !this.meta.key) this.saveMeta(keyStr ?? formatKey(keyRaw), null);
  }

  get key(): string {
    return this.keyStr ?? (this.keyRaw ? formatKey(this.keyRaw) : "");
  }

  saveMeta(keyStr: string, hello: Record<string, unknown> | null): void {
    this.keyStr = keyStr;
    if (this.keyRaw) this.meta.key = formatKey(this.keyRaw);
    this.meta.key_as_sent = keyStr;
    if (hello) {
      if (typeof hello.name === "string") this.meta.name = hello.name;
      if (typeof hello.about === "string") this.meta.about = hello.about;
      if (Array.isArray(hello.caps))
        this.meta.caps = hello.caps.filter((c): c is string => typeof c === "string");
      this.meta.last_connected = nowTs();
    }
    this.backend.writeJson(`${this.dir}/peer.json`, this.meta);
  }

  hasQueued(): boolean {
    return (
      this.outbox.entries.size > 0 ||
      this.sendOnce.items.size > 0 ||
      Object.keys(this.threads.data).length > 0
    );
  }

  hasWork(): boolean {
    return this.outbox.entries.size > 0 || this.sendOnce.items.size > 0 || this.threads.anyOpen();
  }

  /** Takes over what another state (the pending queue) holds. */
  adopt(other: PeerState): void {
    if (!other.hasQueued()) return;
    this.outbox.addMany([...other.outbox.entries.values()]);
    for (const obj of other.sendOnce.items.values()) this.sendOnce.add(obj);
    this.threads.merge(other.threads);
    other.outbox.reset();
    other.sendOnce.clear();
    other.threads.clear();
  }
}

export function fingerprintOf(raw: Uint8Array): string {
  return keyFingerprint(raw);
}
