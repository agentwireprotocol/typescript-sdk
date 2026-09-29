/**
 * The TypeScript SDK for the Agent Wire Protocol (AWP).
 *
 * ```ts
 * import { Peer } from "@agentwireprotocol/sdk";
 *
 * const peer = new Peer({ dir: "~/.mybot", name: "mybot@host" });
 * const address = await peer.listen("tailcat");
 * const key = await peer.connect("tc...");
 * peer.send(key, "Please run make test.", { subject: "Run the suite" });
 * for await (const event of peer.events()) {
 *   if (event.type === "message") console.log(event.peer, event.text);
 * }
 * ```
 */

export {
  Peer,
  type PeerInfo,
  type PeerOptions,
  type SendOptions,
  type Sent,
  type ThreadInfo,
} from "./peer.js";
export type * from "./events.js";
export type * as wire from "./schema.js";
export {
  AwpError,
  Identity,
  PROTOCOL_VERSION,
  canonical,
  formatKey,
  mintGrant,
  parseKey,
  verifyGrant,
} from "./wire.js";
export { parseAddr } from "./transport.js";
