import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Peer } from "../src/peer.js";

/** The awp binary with `conform`, from AWP_BIN or PATH; null if there is none. */
function awpBin(): string | null {
  const bin = process.env.AWP_BIN ?? "awp";
  const r = spawnSync(bin, ["conform", "--list"], { encoding: "utf8" });
  return r.status === 0 ? bin : null;
}

interface Report {
  passed: number;
  failed: number;
  skipped: number;
  results: { name: string; status: string; reason?: string; checks?: { ok: boolean; what: string }[] }[];
}

function conform(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<Report> {
  return new Promise((resolve, reject) => {
    const p = spawn(awpBin()!, ["conform", "--json", "--timeout", "10s", ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (err += c));
    p.on("exit", () => {
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error(`no report: ${err.slice(-2000)}`));
      }
    });
  });
}

const bin = awpBin();

describe.skipIf(bin === null)("conformance (awp conform)", () => {
  test("with the Peer listening: every scenario passes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "awp-ts-conf-"));
    const p = new Peer({ dir, name: "ts@test" });
    try {
      const addr = await p.listen("tcp:127.0.0.1:0");
      const rep = await conform([addr]);
      const failed = rep.results.filter((r) => r.status !== "pass");
      expect(failed).toEqual([]);
      expect(rep.passed).toBe(rep.results.length);
    } finally {
      await p.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  test("with the Peer dialing: the scenarios that share a connection pass", async () => {
    const dir = mkdtempSync(join(tmpdir(), "awp-ts-conf-"));
    try {
      const cli = new URL("../src/cli.ts", import.meta.url).pathname;
      const rep = await conform([
        "--listen",
        "tcp:127.0.0.1:0",
        "--run",
        `bun ${cli} --state ${join(dir, "p")} --name ts@test connect {addr}`,
      ]);
      const failed = rep.results.filter((r) => r.status === "fail");
      expect(failed).toEqual([]);
      expect(rep.passed).toBeGreaterThanOrEqual(10);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
