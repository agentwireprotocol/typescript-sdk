/* Generated from schema/awp.schema.json (the Agent Wire Protocol's JSON Schema) by scripts/gen-types.mjs. Do not edit by hand. */

/**
 * One line of a connection: a message of SPEC.md sections 7 to 10, or one of the extensions marked x-extension. A receiver ignores lines of a type it does not know, after checking the envelope.
 */
export type Message =
  | Hello
  | Auth
  | Resume
  | State
  | Msg
  | Ack
  | Chunk
  | Ping
  | Pong
  | Bye
  | Err
  | GrantMsg
  | Introduce
  | PresenceMsg
  | Mirror
  | Private;
/**
 * Part is one piece of a message. Which fields are meaningful depends on K (PartKinds).
 */
export type Part = TextPart | CodePart | DataPart | BlobPart;

/**
 * Hello is the first line each side sends, at once, without waiting for the other (section 7.1).
 */
export interface Hello {
  /**
   * `t` is the message type.
   */
  t: "hello";
  /**
   * `id` is unique per sender. A ULID or UUIDv7 is recommended, so that ids sort by time; resume compares ids as strings.
   */
  id: string;
  /**
   * `ts` is an RFC 3339 UTC timestamp.
   */
  ts: string;
  /**
   * `th` is the thread id. Required for msg, state and ack.
   */
  th?: string;
  /**
   * `re` is the id of the message this one responds to.
   */
  re?: string;
  /**
   * `v` is the protocol major version. A peer that sees a version it does not speak sends err version and closes.
   */
  v: number;
  /**
   * `key` is the long-term Ed25519 public key. Its bytes are the peer's identity.
   */
  key: string;
  /**
   * `name` is how the peer calls itself, "harness@host" by convention.
   */
  name?: string;
  /**
   * `nonce` is 32 random bytes, base64url. The auth signature covers the whole hello line, nonce included.
   */
  nonce: string;
  /**
   * `caps` lists the supported message families beyond the mandatory chat and resume: blob, grant, introduce, and any extension.
   */
  caps?: string[];
  /**
   * `about` is free text for the other agent's context. It is not authenticated until auth completes.
   */
  about?: string;
  /**
   * `addr` is an extension: an address at which the sender can be reached, so that either side can reconnect (section 4.3). Peers that do not know it ignore it, as section 5 requires.
   */
  addr?: string;
  /**
   * `shares` is an extension (mirror.go): the keys of the hosts this agent mirrors its conversations to, so the other party knows.
   */
  shares?: string[];
}
/**
 * Auth proves possession of the key sent in hello (section 7.2).
 */
export interface Auth {
  /**
   * `t` is the message type.
   */
  t: "auth";
  /**
   * `id` is unique per sender. A ULID or UUIDv7 is recommended, so that ids sort by time; resume compares ids as strings.
   */
  id: string;
  /**
   * `ts` is an RFC 3339 UTC timestamp.
   */
  ts: string;
  /**
   * `th` is the thread id. Required for msg, state and ack.
   */
  th?: string;
  /**
   * `re` is the id of the message this one responds to.
   */
  re?: string;
  /**
   * `sig` is the Ed25519 signature, base64url, over "awp-auth-v0" || 0x00 || my hello line || 0x00 || peer hello line, the lines as sent and received without the newline.
   */
  sig: string;
  /**
   * `grants` are grant objects (section 10.2) the sender presents.
   */
  grants?: Grant[];
}
/**
 * GrantObject is the wire form of a grant (section 10.2): a signed statement that sub may use caps until exp, honored by iss and by whoever trusts iss. sig is iss's Ed25519 signature over the canonical JSON of the object without sig: keys sorted, no whitespace, UTF-8.
 */
export interface Grant {
  /**
   * `iss` is the granting key.
   */
  iss: string;
  /**
   * `sub` is the receiving key.
   */
  sub: string;
  /**
   * `caps` are the capability strings granted (section 10.1).
   */
  caps: string[];
  /**
   * `exp` is when the grant expires, RFC 3339.
   */
  exp: string;
  /**
   * `nonce` makes each grant distinct, base64url.
   */
  nonce: string;
  /**
   * `sig` is the issuer's signature, base64url.
   */
  sig: string;
  /**
   * `aud` is an extension: when set, only the peer with this key should honor the grant. Introductions use it so that a grant meant for the introduced peer does not also give the recipient powers over the introducer. Peers that do not know the field ignore it, which can only make them honor less, never more, than the spec already says.
   */
  aud?: string;
}
/**
 * Resume is sent by both sides after every handshake (section 9.5). The receiver replays its outbox messages the sender has not seen.
 */
export interface Resume {
  /**
   * `t` is the message type.
   */
  t: "resume";
  /**
   * `id` is unique per sender. A ULID or UUIDv7 is recommended, so that ids sort by time; resume compares ids as strings.
   */
  id: string;
  /**
   * `ts` is an RFC 3339 UTC timestamp.
   */
  ts: string;
  /**
   * `th` is the thread id. Required for msg, state and ack.
   */
  th?: string;
  /**
   * `re` is the id of the message this one responds to.
   */
  re?: string;
  /**
   * `seen` maps each thread id to the last message id the sender has durably received in it. Empty on a first connection.
   */
  seen: {
    [k: string]: string | undefined;
  };
}
/**
 * State is the sender's view of a thread's soft state (section 8.1). The two sides can disagree.
 */
export interface State {
  /**
   * `t` is the message type.
   */
  t: "state";
  /**
   * `id` is unique per sender. A ULID or UUIDv7 is recommended, so that ids sort by time; resume compares ids as strings.
   */
  id: string;
  /**
   * `ts` is an RFC 3339 UTC timestamp.
   */
  ts: string;
  /**
   * `th` is the thread id. Required for msg, state and ack.
   */
  th: string;
  /**
   * `re` is the id of the message this one responds to.
   */
  re?: string;
  /**
   * `state` is the thread state: open, working, waiting, done, failed or closed by convention; peers may use others.
   */
  state: string;
  /**
   * `note` says more, such as why a thread failed.
   */
  note?: string;
}
/**
 * Msg is one turn in a thread (section 9.1). The first msg with a new th creates the thread.
 */
export interface Msg {
  /**
   * `t` is the message type.
   */
  t: "msg";
  /**
   * `id` is unique per sender. A ULID or UUIDv7 is recommended, so that ids sort by time; resume compares ids as strings.
   */
  id: string;
  /**
   * `ts` is an RFC 3339 UTC timestamp.
   */
  ts: string;
  /**
   * `th` is the thread id. Required for msg, state and ack.
   */
  th: string;
  /**
   * `re` is the id of the message this one responds to.
   */
  re?: string;
  /**
   * `subject` is the thread's title, meaningful on its first message.
   */
  subject?: string;
  /**
   * `parts` are the message's pieces, in order.
   */
  parts: Part[];
}
/**
 * Text, markdown by convention.
 */
export interface TextPart {
  /**
   * `k` is the part kind: text, code, data or blob.
   */
  k: "text";
  /**
   * `text` is the text of a text or code part.
   */
  text: string;
}
/**
 * Fenced code without the fence; lang names the language.
 */
export interface CodePart {
  /**
   * `k` is the part kind: text, code, data or blob.
   */
  k: "code";
  /**
   * `text` is the text of a text or code part.
   */
  text: string;
  /**
   * `lang` names a code part's language, as a fenced block would.
   */
  lang?: string;
}
/**
 * Inline JSON, with its MIME type. Requests (section 10.1) are data parts of a vnd.awp type.
 */
export interface DataPart {
  /**
   * `k` is the part kind: text, code, data or blob.
   */
  k: "data";
  /**
   * `data` is a data part's inline JSON.
   */
  data: {
    [k: string]: unknown | undefined;
  };
  /**
   * `mime` is the media type of a data or blob part.
   */
  mime?: string;
}
/**
 * A blob sent in chunk messages before or after this message, named by ref.
 */
export interface BlobPart {
  /**
   * `k` is the part kind: text, code, data or blob.
   */
  k: "blob";
  /**
   * `ref` names the blob a blob part refers to, as the chunks carry it.
   */
  ref: string;
  /**
   * `size` is a blob part's size in bytes, before encoding.
   */
  size: number;
  /**
   * `name` is a blob part's file name.
   */
  name?: string;
  /**
   * `mime` is the media type of a data or blob part.
   */
  mime?: string;
}
/**
 * Ack says the msg or state named by re is durably received (section 9.2). Acks drive outbox pruning and are not acked themselves.
 */
export interface Ack {
  /**
   * `t` is the message type.
   */
  t: "ack";
  /**
   * `id` is unique per sender. A ULID or UUIDv7 is recommended, so that ids sort by time; resume compares ids as strings.
   */
  id: string;
  /**
   * `ts` is an RFC 3339 UTC timestamp.
   */
  ts: string;
  /**
   * `th` is the thread id. Required for msg, state and ack.
   */
  th: string;
  /**
   * `re` is the id of the message this one responds to.
   */
  re: string;
}
/**
 * Chunk carries part of a blob (section 9.3). Chunks of one blob arrive in order; chunks of different blobs may interleave. A chunk carries th when the blob belongs to a thread, so that resume replays it like any other threaded message.
 */
export interface Chunk {
  /**
   * `t` is the message type.
   */
  t: "chunk";
  /**
   * `id` is unique per sender. A ULID or UUIDv7 is recommended, so that ids sort by time; resume compares ids as strings.
   */
  id: string;
  /**
   * `ts` is an RFC 3339 UTC timestamp.
   */
  ts: string;
  /**
   * `th` is the thread id. Required for msg, state and ack.
   */
  th?: string;
  /**
   * `re` is the id of the message this one responds to.
   */
  re?: string;
  /**
   * `ref` names the blob, as the sender chose it.
   */
  ref: string;
  /**
   * `n` is the chunk index, from 0.
   */
  n: number;
  /**
   * `last` is true on the final chunk.
   */
  last: boolean;
  /**
   * `data` is the chunk's bytes, standard base64 (B64Pattern; the tag syntax cannot carry the padding).
   */
  data: string;
}
/**
 * Ping is a liveness probe (section 9.4): sent when idle for 30 seconds by convention; two missed pongs mean the connection is dead.
 */
export interface Ping {
  /**
   * `t` is the message type.
   */
  t: "ping";
  /**
   * `id` is unique per sender. A ULID or UUIDv7 is recommended, so that ids sort by time; resume compares ids as strings.
   */
  id: string;
  /**
   * `ts` is an RFC 3339 UTC timestamp.
   */
  ts: string;
  /**
   * `th` is the thread id. Required for msg, state and ack.
   */
  th?: string;
  /**
   * `re` is the id of the message this one responds to.
   */
  re?: string;
}
/**
 * Pong answers a ping; re names the ping.
 */
export interface Pong {
  /**
   * `t` is the message type.
   */
  t: "pong";
  /**
   * `id` is unique per sender. A ULID or UUIDv7 is recommended, so that ids sort by time; resume compares ids as strings.
   */
  id: string;
  /**
   * `ts` is an RFC 3339 UTC timestamp.
   */
  ts: string;
  /**
   * `th` is the thread id. Required for msg, state and ack.
   */
  th?: string;
  /**
   * `re` is the id of the message this one responds to.
   */
  re: string;
}
/**
 * Bye is a graceful close (section 9.6). After sending it a peer sends nothing else and closes after the other side's bye or after 5 seconds.
 */
export interface Bye {
  /**
   * `t` is the message type.
   */
  t: "bye";
  /**
   * `id` is unique per sender. A ULID or UUIDv7 is recommended, so that ids sort by time; resume compares ids as strings.
   */
  id: string;
  /**
   * `ts` is an RFC 3339 UTC timestamp.
   */
  ts: string;
  /**
   * `th` is the thread id. Required for msg, state and ack.
   */
  th?: string;
  /**
   * `re` is the id of the message this one responds to.
   */
  re?: string;
  /**
   * `reason` says why, for the log.
   */
  reason?: string;
}
/**
 * Err reports a problem (section 9.7). Whether it closes the connection depends on the code: bad_frame, version, auth and too_large do, unsupported, forbidden, blob_refused and internal do not.
 */
export interface Err {
  /**
   * `t` is the message type.
   */
  t: "err";
  /**
   * `id` is unique per sender. A ULID or UUIDv7 is recommended, so that ids sort by time; resume compares ids as strings.
   */
  id: string;
  /**
   * `ts` is an RFC 3339 UTC timestamp.
   */
  ts: string;
  /**
   * `th` is the thread id. Required for msg, state and ack.
   */
  th?: string;
  /**
   * `re` is the id of the message this one responds to.
   */
  re?: string;
  /**
   * `code` is the error code.
   */
  code:
    | "bad_frame"
    | "version"
    | "auth"
    | "unsupported"
    | "forbidden"
    | "blob_refused"
    | "too_large"
    | "internal";
  /**
   * `detail` is human readable.
   */
  detail?: string;
  /**
   * `ref` names the blob a blob_refused is about.
   */
  ref?: string;
}
/**
 * GrantMsg delivers a grant after the handshake (section 10.3).
 */
export interface GrantMsg {
  /**
   * `t` is the message type.
   */
  t: "grant";
  /**
   * `id` is unique per sender. A ULID or UUIDv7 is recommended, so that ids sort by time; resume compares ids as strings.
   */
  id: string;
  /**
   * `ts` is an RFC 3339 UTC timestamp.
   */
  ts: string;
  /**
   * `th` is the thread id. Required for msg, state and ack.
   */
  th?: string;
  /**
   * `re` is the id of the message this one responds to.
   */
  re?: string;
  grant: Grant;
}
/**
 * GrantObject is the wire form of a grant (section 10.2): a signed statement that sub may use caps until exp, honored by iss and by whoever trusts iss. sig is iss's Ed25519 signature over the canonical JSON of the object without sig: keys sorted, no whitespace, UTF-8.
 */
/**
 * Introduce hands the recipient another peer's identity and address plus a grant issued by the introducer (section 10.4). The introduced peer honors the grant only if it trusts the introducer with introduce.
 */
export interface Introduce {
  /**
   * `t` is the message type.
   */
  t: "introduce";
  /**
   * `id` is unique per sender. A ULID or UUIDv7 is recommended, so that ids sort by time; resume compares ids as strings.
   */
  id: string;
  /**
   * `ts` is an RFC 3339 UTC timestamp.
   */
  ts: string;
  /**
   * `th` is the thread id. Required for msg, state and ack.
   */
  th?: string;
  /**
   * `re` is the id of the message this one responds to.
   */
  re?: string;
  peer: IntroPeer;
  grant?: Grant;
}
/**
 * `peer` is the introduced peer.
 */
export interface IntroPeer {
  /**
   * Key is the introduced peer's public key.
   */
  key: string;
  /**
   * Name is what the introduced peer calls itself.
   */
  name?: string;
  /**
   * Address is where the introduced peer listens, a hint: the key is the identity.
   */
  address?: string;
}
/**
 * GrantObject is the wire form of a grant (section 10.2): a signed statement that sub may use caps until exp, honored by iss and by whoever trusts iss. sig is iss's Ed25519 signature over the canonical JSON of the object without sig: keys sorted, no whitespace, UTF-8.
 */
/**
 * PresenceMsg is an extension: it carries one signed presence document, gossiped to every peer that lists presence in its hello caps. Doc travels unchanged from relay to relay; the envelope and Hops are per hop.
 */
export interface PresenceMsg {
  /**
   * `t` is the message type.
   */
  t: "presence";
  /**
   * `id` is unique per sender. A ULID or UUIDv7 is recommended, so that ids sort by time; resume compares ids as strings.
   */
  id: string;
  /**
   * `ts` is an RFC 3339 UTC timestamp.
   */
  ts: string;
  /**
   * `th` is the thread id. Required for msg, state and ack.
   */
  th?: string;
  /**
   * `re` is the id of the message this one responds to.
   */
  re?: string;
  doc: Presence;
  /**
   * `hops` counts the relays the document has been through; it is not forwarded past PresenceMaxHops.
   */
  hops: number;
}
/**
 * `doc` is the signed presence document (Presence), verbatim.
 */
export interface Presence {
  /**
   * `origin` is the key of the agent the document describes and is signed by.
   */
  origin: string;
  /**
   * `name` is the agent's name, as in hello.
   */
  name?: string;
  /**
   * `about` is the agent's about text, as in hello.
   */
  about?: string;
  /**
   * `version` is the agent's implementation version.
   */
  version?: string;
  /**
   * `harness` is the agent harness: claude, codex, cursor, ...
   */
  harness?: string;
  /**
   * `model` is the model the agent runs on, as it reports it.
   */
  model?: string;
  /**
   * `host` is the hostname of the machine the agent runs on.
   */
  host?: string;
  /**
   * `shares` lists the keys of the hosts the agent mirrors its conversations to.
   */
  shares?: string[];
  /**
   * `active` is when the agent last did something through awp, to 30 seconds, RFC 3339.
   */
  active?: string;
  /**
   * `waiting` says the agent is blocked waiting for a message.
   */
  waiting?: boolean;
  /**
   * `seq` increases with every document the origin signs; a relay keeps the highest it has seen.
   */
  seq: number;
  /**
   * `ts` is when the document was signed, RFC 3339.
   */
  ts: string;
  /**
   * `peers` are the origin's peers.
   */
  peers?: PresencePeer[];
  /**
   * `threads` are the origin's threads.
   */
  threads?: PresenceThread[];
  /**
   * `outbox` counts the origin's queued, unacked messages.
   */
  outbox?: number;
  /**
   * `unread` counts the messages the origin has not read.
   */
  unread?: number;
  /**
   * `sig` is the origin's signature, base64url.
   */
  sig: string;
}
/**
 * PresencePeer is one of the origin's peers.
 */
export interface PresencePeer {
  /**
   * Key is the peer's key.
   */
  key: string;
  /**
   * Name is the peer's name.
   */
  name?: string;
  /**
   * Up says the peer is connected right now.
   */
  up?: boolean;
  /**
   * RTT is the connection's last round trip time in milliseconds, to show latency across the network; 0 if unknown.
   */
  rtt?: number;
}
/**
 * PresenceThread is one of the origin's threads.
 */
export interface PresenceThread {
  /**
   * Th is the thread id.
   */
  th: string;
  /**
   * Peer is the key of the other party.
   */
  peer: string;
  /**
   * Subject is the thread's subject.
   */
  subject?: string;
  /**
   * Mine is the origin's state in the thread.
   */
  mine?: string;
  /**
   * Theirs is the peer's state, as the origin last heard it.
   */
  theirs?: string;
  /**
   * Updated is when the thread last changed, RFC 3339.
   */
  updated?: string;
  /**
   * Unread counts the thread's messages the origin has not read.
   */
  unread?: number;
}
/**
 * Mirror is an extension: one mirrored line of a thread the sender is part of, or, with Withdraw, a request to forget a mirrored thread. Its th is the mirrored thread's.
 */
export interface Mirror {
  /**
   * `t` is the message type.
   */
  t: "mirror";
  /**
   * `id` is unique per sender. A ULID or UUIDv7 is recommended, so that ids sort by time; resume compares ids as strings.
   */
  id: string;
  /**
   * `ts` is an RFC 3339 UTC timestamp.
   */
  ts: string;
  /**
   * `th` is the thread id. Required for msg, state and ack.
   */
  th: string;
  /**
   * `re` is the id of the message this one responds to.
   */
  re?: string;
  /**
   * `of` is the other party of the mirrored thread (the sender is one side).
   */
  of: string;
  /**
   * `of_name` is the other party's name.
   */
  of_name?: string;
  /**
   * `subject` is the mirrored thread's subject.
   */
  subject?: string;
  /**
   * `dir` says who wrote Line: "out" the sender, "in" the other party.
   */
  dir?: "out" | "in";
  /**
   * `line` is the original msg or state line, verbatim. A msg's blob parts keep their name, type and size; the file itself is not mirrored.
   */
  line?: Msg | State;
  /**
   * `withdraw` asks the receiver to delete everything it has of the thread th between the sender and Of.
   */
  withdraw?: boolean;
}
/**
 * Private is an extension: it asks the receiver to keep the thread th out of what it shares with its hosts, and those hosts to forget it.
 */
export interface Private {
  /**
   * `t` is the message type.
   */
  t: "private";
  /**
   * `id` is unique per sender. A ULID or UUIDv7 is recommended, so that ids sort by time; resume compares ids as strings.
   */
  id: string;
  /**
   * `ts` is an RFC 3339 UTC timestamp.
   */
  ts: string;
  /**
   * `th` is the thread id. Required for msg, state and ack.
   */
  th: string;
  /**
   * `re` is the id of the message this one responds to.
   */
  re?: string;
}
