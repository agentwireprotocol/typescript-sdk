/**
 * The wire format: constants, encodings, keys and signatures, canonical JSON, ULIDs, timestamps and
 * signed grants (spec sections 5 to 10).
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import type { Grant } from "./schema.js";

export const PROTOCOL_VERSION = 0;
export const AUTH_CONTEXT = Buffer.from("awp-auth-v0");
/** The largest line a peer accepts, excluding the newline. */
export const MAX_LINE = 1 << 20;
/** The recommended chunk payload size before base64. */
export const CHUNK_SIZE = 256 * 1024;
export const DEFAULT_BLOB_LIMIT = 50 * 1024 * 1024;
export const DEFAULT_PING_INTERVAL = 30_000;
export const HANDSHAKE_TIMEOUT = 20_000;
export const RESUME_TIMEOUT = 10_000;
export const BYE_TIMEOUT = 5_000;
export const BACKOFF_INITIAL = 500;
export const BACKOFF_CAP = 60_000;
export const DEFAULT_GRANT_TTL = 3600;
export const TAILCAT_PORT = 1;
export const KEY_PREFIX = "ed25519:";
export const HELLO_CAPS = ["chat", "blob", "grant", "introduce"];
export const CLOSING_ERR_CODES = new Set(["bad_frame", "version", "auth", "too_large"]);
export const ACKED_TYPES = new Set(["msg", "state"]);
export const SEEN_TYPES = new Set(["msg", "state", "chunk"]);
export const PRE_AUTH_FORBIDDEN = new Set(["msg", "state", "ack", "chunk", "resume", "grant", "introduce"]);
export const REQUEST_MIMES: Record<string, string> = {
  "application/vnd.awp.exec+json": "exec",
  "application/vnd.awp.fs-read+json": "fs:read",
  "application/vnd.awp.fs-write+json": "fs:write",
  "application/vnd.awp.admin+json": "admin",
};

export class AwpError extends Error {
  override name = "AwpError";
}

// ---------------------------------------------------------------- encodings

export function b64url(b: Uint8Array): string {
  return Buffer.from(b).toString("base64url");
}

export function b64std(b: Uint8Array): string {
  return Buffer.from(b).toString("base64");
}

/** Accepts base64url or standard base64, padded or not. */
export function b64decodeAny(s: unknown): Buffer {
  if (typeof s !== "string") throw new AwpError("not a base64 string");
  const t = s.replace(/=+$/, "");
  if (!/^[A-Za-z0-9+/_-]*$/.test(t)) throw new AwpError("not base64");
  return Buffer.from(
    t.includes("+") || t.includes("/") ? t : t.replace(/-/g, "+").replace(/_/g, "/"),
    "base64",
  );
}

// ---------------------------------------------------------------- keys

const ED25519_PUBLIC_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const ED25519_PRIVATE_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** A peer's Ed25519 identity. */
export class Identity {
  readonly seed: Buffer;
  readonly publicKey: Buffer;
  /** "ed25519:" and the public key in unpadded base64url. */
  readonly key: string;
  private readonly priv: KeyObject;

  constructor(seed: Uint8Array) {
    if (seed.length !== 32) throw new AwpError("seed must be 32 bytes");
    this.seed = Buffer.from(seed);
    this.priv = createPrivateKey({
      key: Buffer.concat([ED25519_PRIVATE_PREFIX, this.seed]),
      format: "der",
      type: "pkcs8",
    });
    const spki = createPublicKey(this.priv).export({ format: "der", type: "spki" }) as Buffer;
    this.publicKey = spki.subarray(spki.length - 32);
    this.key = formatKey(this.publicKey);
  }

  static generate(): Identity {
    return new Identity(randomBytes(32));
  }

  sign(msg: Uint8Array): Buffer {
    return sign(null, msg, this.priv);
  }
}

export function formatKey(pub: Uint8Array): string {
  return KEY_PREFIX + b64url(pub);
}

/** The raw public key of an "ed25519:..." string. */
export function parseKey(s: unknown): Buffer {
  if (typeof s !== "string" || !s.startsWith(KEY_PREFIX))
    throw new AwpError(`key ${JSON.stringify(s)}: want an ed25519: prefix`);
  const raw = b64decodeAny(s.slice(KEY_PREFIX.length));
  if (raw.length !== 32) throw new AwpError(`key ${s.slice(0, 24)}…: ${raw.length} bytes, want 32`);
  return raw;
}

export function keyFingerprint(raw: Uint8Array): string {
  return createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

export function shortKey(key: string): string {
  return key.replace(KEY_PREFIX, "").slice(0, 10);
}

export function ed25519Verify(pub: Uint8Array, sig: Uint8Array, msg: Uint8Array): boolean {
  if (pub.length !== 32 || sig.length !== 64) return false;
  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_PUBLIC_PREFIX, Buffer.from(pub)]),
      format: "der",
      type: "spki",
    });
    return verify(null, msg, key, sig);
  } catch {
    return false;
  }
}

/** The byte string auth signs: the context, a zero byte, my hello, a zero byte, the peer's hello. */
export function authPayload(myHello: Uint8Array, peerHello: Uint8Array): Buffer {
  return Buffer.concat([AUTH_CONTEXT, Buffer.from([0]), myHello, Buffer.from([0]), peerHello]);
}

// ---------------------------------------------------------------- lines and canonical JSON

/** One line, without the newline. Throws over MAX_LINE. */
export function encodeLine(obj: unknown): Buffer {
  const b = Buffer.from(JSON.stringify(obj), "utf8");
  if (b.length > MAX_LINE) throw new AwpError(`line is ${b.length} bytes, over the ${MAX_LINE} byte limit`);
  return b;
}

/** Canonical JSON (spec 10.2): keys sorted, no whitespace, UTF-8. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  const keys = Object.keys(v as object).sort();
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + canonical((v as Record<string, unknown>)[k])).join(",") +
    "}"
  );
}

// ---------------------------------------------------------------- timestamps

export function nowTs(): string {
  return new Date().toISOString();
}

/** Seconds since the epoch of an RFC 3339 timestamp, or NaN. */
export function parseRfc3339(s: unknown): number {
  if (typeof s !== "string") return NaN;
  const m = /^(\d{4}-\d{2}-\d{2})[Tt ](\d{2}:\d{2}:\d{2}(?:\.\d+)?)([Zz]|[+-]\d{2}:\d{2})$/.exec(s);
  if (!m) return NaN;
  return Date.parse(`${m[1]}T${m[2]}${m[3]!.toUpperCase()}`) / 1000;
}

// ---------------------------------------------------------------- ULIDs

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** ULIDs that strictly increase, even within a millisecond and if the clock steps back. */
export class UlidGen {
  private last = 0n;

  new(): string {
    let v = (BigInt(Date.now()) << 80n) | BigInt("0x" + randomBytes(10).toString("hex"));
    if (v <= this.last) v = this.last + 1n;
    this.last = v;
    return ulidEncode(v);
  }

  /** An id made earlier, so that new ones stay above it. */
  observe(id: string): void {
    const v = ulidDecode(id);
    if (v !== null && v > this.last) this.last = v;
  }
}

export function ulidEncode(v: bigint): string {
  let out = "";
  for (let i = 0; i < 26; i++) {
    out = CROCKFORD[Number(v & 31n)] + out;
    v >>= 5n;
  }
  return out;
}

export function ulidDecode(s: unknown): bigint | null {
  if (typeof s !== "string" || s.length !== 26) return null;
  let v = 0n;
  for (const ch of s.toUpperCase()) {
    const i = CROCKFORD.indexOf(ch);
    if (i < 0) return null;
    v = (v << 5n) | BigInt(i);
  }
  return v >> 128n === 0n ? v : null;
}

// ---------------------------------------------------------------- grants

/** Signature, shape and expiry check: [ok, reason]. */
export function verifyGrant(g: unknown): [boolean, string] {
  if (g === null || typeof g !== "object" || Array.isArray(g)) return [false, "grant is not an object"];
  const o = g as Record<string, unknown>;
  let iss: Buffer;
  let sig: Buffer;
  try {
    iss = parseKey(o.iss);
    parseKey(o.sub);
    sig = b64decodeAny(o.sig);
  } catch (e) {
    return [false, `malformed grant: ${(e as Error).message}`];
  }
  if (!Array.isArray(o.caps) || !o.caps.every((c) => typeof c === "string"))
    return [false, "caps must be a list of strings"];
  const exp = parseRfc3339(o.exp);
  if (Number.isNaN(exp)) return [false, "exp is not an RFC 3339 timestamp"];
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (k !== "sig") body[k] = v;
  if (!ed25519Verify(iss, sig, Buffer.from(canonical(body), "utf8")))
    return [false, "signature does not verify"];
  if (exp <= Date.now() / 1000) return [false, "grant has expired"];
  return [true, "ok"];
}

/** A grant from `identity` to `sub` for `caps`, valid `ttl` seconds; `aud` binds it to one honoring peer. */
export function mintGrant(identity: Identity, sub: string, caps: string[], ttl: number, aud?: string): Grant {
  parseKey(sub);
  const exp = new Date(Date.now() + ttl * 1000);
  exp.setMilliseconds(0);
  const body: Record<string, unknown> = {
    iss: identity.key,
    sub,
    caps: [...caps],
    exp: exp.toISOString().replace(".000Z", "Z"),
    nonce: b64url(randomBytes(16)),
  };
  if (aud) body.aud = aud;
  const sig = identity.sign(Buffer.from(canonical(body), "utf8"));
  return { ...body, sig: b64url(sig) } as unknown as Grant;
}

/** How a grant is named: the SHA-256 of its canonical form, signature included, shortened. */
export function grantHash(g: Record<string, unknown>): string {
  return createHash("sha256").update(canonical(g), "utf8").digest("hex").slice(0, 32);
}

// ---------------------------------------------------------------- helpers

/** A sender-chosen string as a file name that cannot escape a directory. */
export function safeName(s: string): string {
  let name = s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  if (name === "" || name.startsWith(".")) name = "b_" + name;
  return name;
}

/** The blob refs a msg's parts name. */
export function blobRefs(obj: Record<string, unknown>): string[] {
  const parts = obj.parts;
  if (!Array.isArray(parts)) return [];
  const out: string[] = [];
  for (const p of parts) {
    if (
      p &&
      typeof p === "object" &&
      (p as Record<string, unknown>).k === "blob" &&
      typeof (p as Record<string, unknown>).ref === "string"
    ) {
      out.push((p as Record<string, unknown>).ref as string);
    }
  }
  return out;
}
