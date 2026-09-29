#!/usr/bin/env node
/**
 * A peer driven over stdin and stdout, for tests and other languages: the same contract as the Python
 * SDK's `python -m awp` and the reference implementation's Python peer.
 *
 *   awp-peer --state DIR [--name NAME] listen tcp:127.0.0.1:7000
 *   awp-peer --state DIR [--name NAME] connect tc...
 *
 * Commands (stdin, one JSON object per line): send, state, blob, grant, bye, quit.
 * Events (stdout): identity, listening, connected, recv, blob, sent, acked, disconnected, error.
 */

import { createInterface } from "node:readline";
import type * as ev from "./events.js";
import { Peer } from "./peer.js";
import { AwpError, DEFAULT_BLOB_LIMIT, DEFAULT_GRANT_TTL, DEFAULT_PING_INTERVAL } from "./wire.js";

function emit(d: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(d) + "\n");
}

function toDict(e: ev.Event): Record<string, unknown> | null {
  switch (e.type) {
    case "connected":
      return { event: "connected", key: e.peer, name: e.name, caps: e.caps, about: e.about };
    case "disconnected":
      return { event: "disconnected", reason: e.reason, key: e.peer };
    case "acked":
      return { event: "acked", id: e.id };
    case "blob":
      return { event: "blob", ref: e.ref, path: e.path, size: e.size, sha256: e.sha256 };
    case "local-error":
      return { event: "error", detail: e.detail };
    case "introduced":
      return { event: "introduced", ...e };
    default:
      return null; // messages, states, errs and byes are reported as raw "recv" lines
  }
}

interface Args {
  state: string;
  name?: string;
  about?: string;
  pingInterval: number;
  maxBlob: number;
  trust: string[];
  verbose: boolean;
  mode: "listen" | "connect";
  addr: string;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    state: `${process.env.HOME}/.awp-ts`,
    pingInterval: DEFAULT_PING_INTERVAL / 1000,
    maxBlob: DEFAULT_BLOB_LIMIT,
    trust: [],
    verbose: false,
    mode: "listen",
    addr: "",
  };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new AwpError(`${x} needs a value`);
      return v;
    };
    if (x === "--state") a.state = next();
    else if (x === "--name") a.name = next();
    else if (x === "--about") a.about = next();
    else if (x === "--ping-interval") a.pingInterval = Number(next());
    else if (x === "--max-blob") a.maxBlob = Number(next());
    else if (x === "--trust") a.trust.push(next());
    else if (x === "-v" || x === "--verbose") a.verbose = true;
    else if (x.startsWith("-")) throw new AwpError(`unknown flag ${x}`);
    else rest.push(x);
  }
  if (rest.length !== 2 || (rest[0] !== "listen" && rest[0] !== "connect")) {
    throw new AwpError(
      "usage: awp-peer [--state DIR] [--name NAME] [--ping-interval SECS] [--max-blob BYTES] [--trust KEY] {listen|connect} ADDR",
    );
  }
  a.mode = rest[0] as "listen" | "connect";
  a.addr = rest[1]!;
  return a;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    return 2;
  }
  const log = (line: string) =>
    process.stderr.write(`${new Date().toISOString().slice(11, 19)} [awp] ${line}\n`);
  let peer: Peer;
  try {
    peer = new Peer({
      dir: args.state,
      name: args.name,
      about: args.about,
      trust: args.trust,
      pingInterval: args.pingInterval * 1000,
      blobLimit: args.maxBlob,
      log,
    });
  } catch (e) {
    emit({ event: "error", detail: (e as Error).message });
    return 1;
  }
  peer.rawHook = (obj) => emit({ event: "recv", msg: obj });
  emit({ event: "identity", key: peer.key, name: peer.name });

  const target = (c: Record<string, unknown>): string | null =>
    typeof c.peer === "string" && c.peer ? c.peer : null;
  const command = (c: Record<string, unknown>): void => {
    const cmd = c.cmd;
    const text =
      c.text === undefined ? undefined : typeof c.text === "string" ? c.text : JSON.stringify(c.text);
    if (cmd === "send") {
      const s = peer.send(target(c), text, {
        thread: c.th as string | undefined,
        subject: (c.subject as string) || undefined,
        replyTo: (c.re as string) || undefined,
        parts: Array.isArray(c.parts) ? (c.parts as never) : undefined,
      });
      emit({ event: "sent", id: s.id, t: "msg", th: s.thread });
    } else if (cmd === "state") {
      const s = peer.setState(target(c), String(c.th), String(c.state), (c.note as string) || undefined);
      emit({ event: "sent", id: s.id, t: "state" });
    } else if (cmd === "blob") {
      const s = peer.send(target(c), text, {
        thread: c.th as string | undefined,
        subject: (c.subject as string) || undefined,
        replyTo: (c.re as string) || undefined,
        files: [String(c.path)],
      });
      emit({ event: "sent", id: s.id, t: "msg", th: s.thread });
    } else if (cmd === "grant") {
      let sub = (c.sub as string) || target(c);
      if (!sub) {
        const known = peer.listPeers();
        if (known.length === 0) throw new AwpError("grant: 'sub' is required when no peer is known yet");
        sub = known[known.length - 1]!.key;
      }
      const ttl = c.ttl === undefined ? DEFAULT_GRANT_TTL : Number(c.ttl);
      peer.grant(sub, Array.isArray(c.caps) ? (c.caps as string[]) : [], ttl);
      emit({ event: "sent", t: "grant" });
    } else if (cmd === "bye") {
      const reason = (c.reason as string) || "done";
      const targets = target(c)
        ? [target(c)!]
        : peer
            .listPeers()
            .filter((p) => p.connected)
            .map((p) => p.key);
      if (targets.length === 0) emit({ event: "error", detail: "bye: not connected" });
      for (const t of targets) {
        emit({ event: "sent", t: "bye" });
        peer.bye(t, reason).catch((e) => emit({ event: "error", detail: `bye: ${(e as Error).message}` }));
      }
    } else if (cmd === "quit") {
      process.exit(0);
    } else {
      throw new AwpError(`unknown command ${JSON.stringify(cmd)}`);
    }
  };

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let c: unknown;
    try {
      c = JSON.parse(line);
    } catch (e) {
      emit({ event: "error", detail: `bad command line (not JSON): ${(e as Error).message}` });
      return;
    }
    if (!c || typeof c !== "object" || Array.isArray(c)) {
      emit({ event: "error", detail: "bad command line: not a JSON object" });
      return;
    }
    try {
      command(c as Record<string, unknown>);
    } catch (e) {
      emit({ event: "error", detail: (e as Error).message });
    }
  });
  rl.on("close", () => log("stdin closed; running until killed"));

  try {
    if (args.mode === "listen") {
      const shown = await peer.listen(args.addr);
      emit({ event: "listening", addr: shown, key: peer.key });
    } else {
      peer
        .connect(args.addr, null)
        .catch((e) => emit({ event: "error", detail: `connect ${args.addr}: ${(e as Error).message}` }));
    }
  } catch (e) {
    emit({ event: "error", detail: (e as Error).message });
    return 1;
  }
  for await (const e of peer.events()) {
    const d = toDict(e);
    if (d) emit(d);
  }
  return 0;
}

const invoked = process.argv[1] && /\/(cli\.[jt]s|awp-peer)$/.test(process.argv[1]);
if (invoked) {
  main().then((code) => process.exit(code));
}
