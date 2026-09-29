# Agent Wire Protocol: TypeScript SDK

The TypeScript SDK for the [Agent Wire Protocol](https://agentwireprotocol.com) (AWP), the peer-to-peer messaging protocol for coding agents. A `Peer` listens and connects, sends messages in threads, and delivers what arrives as typed events, with everything the protocol asks for inside: resume with an outbox on disk, acks, dedup by id, blobs in chunks, grants and introductions, ping/pong, reconnection with backoff.

Node 20 or later, or Bun. No runtime dependencies: Ed25519 comes from `node:crypto`.

```sh
npm install @agentwireprotocol/sdk
```

## A peer in a few lines

```ts
import { Peer } from "@agentwireprotocol/sdk";

const peer = new Peer({ dir: "~/.mybot", name: "mybot@builder" });
const address = await peer.listen("tailcat"); // or "tcp:127.0.0.1:7000", "unix:/tmp/awp.sock"
console.log("share this:", address);

const key = await peer.connect("tc..."); // an address shared out of band
const sent = peer.send(key, "Please run make test at a1b2c3.", { subject: "Run the suite" });

for await (const event of peer.events()) {
  switch (event.type) {
    case "message":
      console.log(`${event.peer}: ${event.text}`);
      break;
    case "state":
      console.log(`${event.peer} is ${event.state} in ${event.thread}`);
      break;
    case "blob":
      console.log(`file ${event.name} at ${event.path}`);
      break;
  }
}
```

## What a Peer does

- **`new Peer({ dir, name })`** loads or creates the Ed25519 identity under `dir`, along with the outbox, received ids, threads, grants and blobs. Without `dir` it is ephemeral: a fresh identity, state in memory, removed on close.
- **`listen(addr)`** accepts connections on `tcp:HOST:PORT`, `unix:/path`, or `"tailcat"`: a WireGuard tunnel through the [tailcat CLI](https://github.com/tailscale/tailcat) with an address any peer can reach, through NAT, with no account. It returns the address to share.
- **`connect(addr)`** dials an address and resolves with the peer's key once the handshake is done. The Peer keeps dialing with exponential backoff, capped at a minute, whenever there are unacked messages or open threads with that peer. Sleeping sandboxes wake on connect.
- **`send(to, text, { thread, subject, replyTo, parts, files })`** queues a message. It never fails because the peer is away: the message is on disk and goes out on the next resume. Files travel as blobs in 256 KiB chunks ahead of the message. **`waitAck(id)`** waits for the peer's ack; `acked` events carry it too.
- **`setState(to, thread, state, note)`** sets this side's state on a thread: `working`, `waiting`, `done`, `failed`, `closed`, or any word the two agents agree on.
- **`events()`** and **`nextEvent(timeout)`**: `connected`, `disconnected`, `message`, `state`, `acked`, `blob`, `grant`, `introduced`, `error` (an err the peer sent), `bye`, `local-error`. Messages are stored and acked before they are reported.
- **`grant(to, caps, ttl)`**, **`caps(to)`**: capabilities beyond the defaults (`exec`, `fs:read`, `fs:write`, `introduce`, `admin`, or your own strings) as signed grants. Grants issued by this Peer and by keys in `trust` are honored, plus one level of delegation through `introduce`. A request in a message (a data part of a `vnd.awp` type) arrives in `message.requests`, marked allowed or not; denied ones are answered with `err forbidden` already.
- **`bye(to)`** closes gracefully and parks the peer. **`listPeers()`**, **`threads()`**, **`connected(to)`**: what the Peer knows.

The wire types (`Hello`, `Msg`, `Part`, `Grant`, ...) are generated from the protocol's [JSON Schema](https://agentwireprotocol.com/schema/v0/awp.schema.json), vendored in `schema/`, and exported as `wire`.

## A peer driven over stdin and stdout

`awp-peer --state DIR listen tcp:127.0.0.1:7000` runs a peer that reads JSON commands on stdin and writes JSON events on stdout, for tests and for other languages, with the same contract as the Python SDK's `python -m awp`.

## Conformance

`bun test` runs the wire primitives, a two-peer conversation with states, a reply, a multi-chunk blob, grants and bye, queued delivery across a restart, and, when `AWP_BIN` points at an `awp` binary, the protocol's conformance suite ([`awp conform`](https://docs.agentwireprotocol.com/reference/conformance)) against a `Peer`, both listening and dialing. CI does all of it.

## Status

v0.1. The API may change before v1; the wire protocol is v0 and stable.

## License

Apache-2.0.
