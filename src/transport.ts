/** Addresses and byte streams: tcp:HOST:PORT, unix:/path, and tailcat addresses through the tailcat CLI. */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { Duplex } from "node:stream";
import { AwpError, TAILCAT_PORT } from "./wire.js";

export type Target =
  | { kind: "tcp"; host: string; port: number }
  | { kind: "unix"; path: string }
  | { kind: "tailcat"; address: string };

export function looksTailcat(s: string): boolean {
  return s.length >= 40 && s.startsWith("tc") && /^[A-Za-z0-9_-]+$/.test(s);
}

/** tcp:HOST:PORT, unix:/path, tailcat:tc..., or a bare tailcat address. */
export function parseAddr(s: string): Target {
  s = s.trim();
  if (s.startsWith("tailcat:")) {
    const t = s.slice("tailcat:".length).replace(/^\/+/, "");
    if (!looksTailcat(t)) throw new AwpError(`bad tailcat address ${s}`);
    return { kind: "tailcat", address: t };
  }
  if (looksTailcat(s)) return { kind: "tailcat", address: s };
  if (s.startsWith("tcp:")) {
    const rest = s.slice(4).replace(/^\/+/, "");
    const i = rest.lastIndexOf(":");
    const port = Number(rest.slice(i + 1));
    if (i < 0 || !Number.isInteger(port)) throw new AwpError(`bad tcp address ${s}; expected tcp:HOST:PORT`);
    return { kind: "tcp", host: rest.slice(0, i).replace(/^\[|\]$/g, ""), port };
  }
  if (s.startsWith("unix:")) {
    const path = s.slice(5).replace(/^\/\/(?=\/)/, "");
    if (!path) throw new AwpError(`bad unix address ${s}; expected unix:/path`);
    return { kind: "unix", path };
  }
  if (s.includes("/")) return { kind: "unix", path: s };
  throw new AwpError(`unrecognised address ${s}; use tc..., tailcat:tc..., tcp:HOST:PORT or unix:/path`);
}

export function formatTarget(t: Target): string {
  switch (t.kind) {
    case "tcp":
      return `tcp:${t.host.includes(":") ? `[${t.host}]` : t.host}:${t.port}`;
    case "unix":
      return `unix:${t.path}`;
    case "tailcat":
      return `tailcat:${t.address}`;
  }
}

export function isLoopback(host: string): boolean {
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

export interface Stream {
  duplex: Duplex;
  /** The tailcat client, for tailcat addresses. */
  proc?: ChildProcess;
}

/** Opens a byte stream to a target. */
export function openStream(t: Target, tailcatBin = "tailcat", timeoutMs = 15_000): Promise<Stream> {
  return new Promise((resolve, reject) => {
    if (t.kind === "tailcat") {
      const proc = spawn(tailcatBin, [t.address, String(TAILCAT_PORT)], {
        stdio: ["pipe", "pipe", "ignore"],
      });
      proc.once("error", (e) => reject(new AwpError(`${tailcatBin}: ${e.message}`)));
      proc.once("spawn", () => resolve({ duplex: pipeDuplex(proc), proc }));
      return;
    }
    const sock: Socket =
      t.kind === "tcp"
        ? createConnection({ host: t.host, port: t.port })
        : createConnection({ path: t.path });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new AwpError(`connect timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    sock.once("connect", () => {
      clearTimeout(timer);
      sock.setNoDelay(true);
      resolve({ duplex: sock });
    });
    sock.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

/** A duplex over a child's stdin and stdout. */
function pipeDuplex(proc: ChildProcess): Duplex {
  const stdout = proc.stdout!;
  const stdin = proc.stdin!;
  const d = new Duplex({
    read() {
      // pushed from stdout below
    },
    write(chunk, _enc, cb) {
      stdin.write(chunk, cb);
    },
    final(cb) {
      stdin.end(cb);
    },
    destroy(err, cb) {
      proc.kill();
      cb(err);
    },
  });
  stdout.on("data", (c: Buffer) => {
    if (!d.push(c)) stdout.pause();
  });
  d.on("drain", () => stdout.resume());
  stdout.on("end", () => d.push(null));
  proc.on("exit", () => d.push(null));
  stdin.on("error", (e) => d.destroy(e));
  return d;
}

/** Listens on a tcp or unix target; the server's address says which port was bound. */
export function listen(
  t: Exclude<Target, { kind: "tailcat" }>,
  onConnection: (s: Socket) => void,
): Promise<{ server: Server; shown: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer(onConnection);
    server.once("error", reject);
    if (t.kind === "tcp") {
      server.listen(t.port, t.host, () => {
        const a = server.address();
        const port = typeof a === "object" && a ? a.port : t.port;
        resolve({ server, shown: formatTarget({ kind: "tcp", host: t.host, port }) });
      });
    } else {
      prepareUnixPath(t.path);
      server.listen(t.path, () => resolve({ server, shown: formatTarget(t) }));
    }
  });
}

function prepareUnixPath(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    return;
  }
  if (!statSync(path).isSocket()) throw new AwpError(`${path} exists and is not a socket`);
  unlinkSync(path); // a stale socket; a live one fails to bind and says so
}

/** `tailcat serve 1:127.0.0.1:PORT`: the tunnel's port 1, which awp peers dial, proxied to a local listener. */
export class TailcatListener {
  private constructor(
    readonly proc: ChildProcess,
    readonly address: string,
  ) {}

  static start(
    tailcatBin: string,
    port: number,
    log: (s: string) => void,
    timeoutMs = 60_000,
  ): Promise<TailcatListener> {
    return new Promise((resolve, reject) => {
      const proc = spawn(tailcatBin, ["serve", `${TAILCAT_PORT}:127.0.0.1:${port}`], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      let found = false;
      let buf = "";
      const timer = setTimeout(() => {
        if (!found) {
          proc.kill();
          reject(new AwpError("tailcat printed no address in time"));
        }
      }, timeoutMs);
      proc.once("error", (e) => {
        clearTimeout(timer);
        reject(new AwpError(`${tailcatBin}: ${e.message}`));
      });
      proc.stderr!.on("data", (c: Buffer) => {
        buf += c.toString("utf8");
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          log(`tailcat: ${line}`);
          if (!found) {
            const word = line.split(/\s+/).find(looksTailcat);
            if (word) {
              found = true;
              clearTimeout(timer);
              resolve(new TailcatListener(proc, word));
            }
          }
        }
      });
      proc.once("exit", () => {
        if (!found) {
          clearTimeout(timer);
          reject(new AwpError("tailcat exited before printing an address"));
        }
      });
    });
  }

  close(): void {
    this.proc.kill();
  }
}
