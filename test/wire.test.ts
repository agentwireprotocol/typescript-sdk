import { describe, expect, test } from "bun:test";
import {
  Identity,
  UlidGen,
  authPayload,
  b64decodeAny,
  canonical,
  ed25519Verify,
  formatKey,
  mintGrant,
  parseKey,
  parseRfc3339,
  ulidDecode,
  verifyGrant,
} from "../src/wire.js";

describe("wire", () => {
  test("keys round-trip and signatures verify", () => {
    const id = Identity.generate();
    expect(id.key).toMatch(/^ed25519:[A-Za-z0-9_-]{43}$/);
    expect(parseKey(id.key).equals(id.publicKey)).toBe(true);
    expect(parseKey(id.key + "=").equals(id.publicKey)).toBe(true);
    expect(() => parseKey("rsa:abc")).toThrow();
    const sig = id.sign(authPayload(Buffer.from("a"), Buffer.from("b")));
    expect(ed25519Verify(id.publicKey, sig, authPayload(Buffer.from("a"), Buffer.from("b")))).toBe(true);
    expect(ed25519Verify(id.publicKey, sig, authPayload(Buffer.from("b"), Buffer.from("a")))).toBe(false);
    expect(formatKey(id.publicKey)).toBe(id.key);
    expect(new Identity(id.seed).key).toBe(id.key);
  });

  test("canonical JSON sorts keys and keeps unicode", () => {
    expect(canonical({ b: 1, a: [true, null, "é"], c: { z: 0, y: "x" } })).toBe(
      '{"a":[true,null,"é"],"b":1,"c":{"y":"x","z":0}}',
    );
  });

  test("the grant example in the spec has a real signature, and minted grants verify", () => {
    // SPEC.md section 10.2. It expired on 2026-09-25, so verification gets as far as the expiry check,
    // which means the signature over the canonical object verified.
    const example = JSON.parse(
      '{"iss": "ed25519:4ypZnypm77nHtEjcuPHYf0KO6L3XClTwNG8t4d3u9iI", "sub": "ed25519:SzOoZZ93chgozsW4_k3Bng7bw8nm9jhE8F_MT7DwsZM", "caps": ["exec", "fs:read"], "exp": "2026-09-25T20:00:00Z", "nonce": "mi7aguVbYbdo0OZSdAyKig", "sig": "KIc8YtMgZ0mjshD6ypfayh4E3QHHeRlpX2yL9HU1cpPHoqgIXYh9Ry00Shafa34OvFif31huoA1v5YbnsmUEDg"}',
    );
    expect(verifyGrant(example)).toEqual([false, "grant has expired"]);
    expect(verifyGrant({ ...example, caps: ["admin"] })[1]).toBe("signature does not verify");
    const a = Identity.generate();
    const b = Identity.generate();
    const g = mintGrant(a, b.key, ["exec", "fs:read"], 60);
    expect(verifyGrant(g)).toEqual([true, "ok"]);
    expect(verifyGrant({ ...g, caps: ["admin"] })[0]).toBe(false);
    expect(verifyGrant(mintGrant(a, b.key, [], -1))[0]).toBe(false);
  });

  test("ULIDs increase and decode", () => {
    const g = new UlidGen();
    let prev = "";
    for (let i = 0; i < 2000; i++) {
      const id = g.new();
      expect(id.length).toBe(26);
      expect(id > prev).toBe(true);
      prev = id;
    }
    expect(ulidDecode(prev)).not.toBeNull();
    expect(ulidDecode("not-a-ulid")).toBeNull();
    const h = new UlidGen();
    h.observe(prev);
    expect(h.new() > prev).toBe(true);
  });

  test("timestamps and liberal base64", () => {
    expect(parseRfc3339("2026-09-25T17:03:11Z")).toBe(Date.parse("2026-09-25T17:03:11Z") / 1000);
    expect(parseRfc3339("2026-09-25T17:03:11.250+02:00")).toBe(Date.parse("2026-09-25T15:03:11.250Z") / 1000);
    expect(Number.isNaN(parseRfc3339("yesterday"))).toBe(true);
    expect(b64decodeAny("aGk=").toString()).toBe("hi");
    expect(b64decodeAny("aGk").toString()).toBe("hi");
    expect(b64decodeAny("-_8").equals(b64decodeAny("+/8"))).toBe(true);
  });
});
