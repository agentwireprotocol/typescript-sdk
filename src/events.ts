/** What a Peer reports. Switch on `type`. `peer` is the key of the peer the event is about. */

import type { Part } from "./schema.js";

export interface Connected {
  type: "connected";
  peer: string;
  name: string;
  about: string;
  caps: string[];
  outbound: boolean;
}

/** The connection ended. The Peer reconnects with backoff while there is unfinished business. */
export interface Disconnected {
  type: "disconnected";
  peer: string;
  reason: string;
}

/** A msg from the peer, durably stored and acked before it is reported. */
export interface Message {
  type: "message";
  peer: string;
  id: string;
  thread: string;
  parts: Part[];
  subject?: string;
  replyTo?: string;
  /**
   * Capability requests found in the data parts (exec, fs:read, fs:write, admin), each marked allowed by
   * the sender's grants or not. A denied request was answered with err forbidden already.
   */
  requests: Request[];
  /** The text parts, joined. */
  text: string;
}

export interface Request {
  part: number;
  mime: string;
  cap: string;
  allowed: boolean;
}

/** The peer set its state on a thread. */
export interface State {
  type: "state";
  peer: string;
  id: string;
  thread: string;
  state: string;
  note?: string;
}

/** The peer acked a msg or state of ours: it is durably delivered. */
export interface Acked {
  type: "acked";
  peer: string;
  id: string;
}

/** A file the peer sent arrived in full, at `path`. */
export interface Blob {
  type: "blob";
  peer: string;
  ref: string;
  path: string;
  size: number;
  sha256: string;
  thread?: string;
  name?: string;
  mime?: string;
}

/** The peer gave us a grant, now held and presented to its issuer on every connection. */
export interface GrantReceived {
  type: "grant";
  peer: string;
  issuer: string;
  caps: string[];
  expires: string;
  grant: Record<string, unknown>;
}

/** The peer handed us another peer's key and address. Connect to `address` to meet it. */
export interface Introduced {
  type: "introduced";
  peer: string;
  key: string;
  name?: string;
  address?: string;
  thread?: string;
  grant?: Record<string, unknown>;
}

/** The peer sent an err line. */
export interface PeerError {
  type: "error";
  peer: string;
  code: string;
  detail?: string;
  replyTo?: string;
  ref?: string;
}

/** The peer closed gracefully. It is parked: no reconnection until something new is queued for it. */
export interface Bye {
  type: "bye";
  peer: string;
  reason?: string;
}

/** Something went wrong locally. `peer` is "" when no peer is involved. */
export interface LocalError {
  type: "local-error";
  peer: string;
  detail: string;
}

export type Event =
  | Connected
  | Disconnected
  | Message
  | State
  | Acked
  | Blob
  | GrantReceived
  | Introduced
  | PeerError
  | Bye
  | LocalError;
