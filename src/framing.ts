/** NDJSON framing: one line per message, at most MAX_LINE bytes before the newline (spec section 5). */

import { MAX_LINE } from "./wire.js";

export class LineTooLongError extends Error {
  constructor() {
    super("line exceeds 1 MiB");
    this.name = "LineTooLongError";
  }
}

/** Splits a byte stream into lines, without the newline. */
export class LineSplitter {
  private buf: Buffer[] = [];
  private size = 0;

  /** Feed bytes; returns the complete lines they finish. Throws LineTooLongError over the limit. */
  push(chunk: Buffer): Buffer[] {
    const out: Buffer[] = [];
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf(10, start);
      if (nl < 0) {
        const rest = chunk.subarray(start);
        if (rest.length > 0) {
          this.buf.push(rest);
          this.size += rest.length;
          if (this.size > MAX_LINE) throw new LineTooLongError();
        }
        return out;
      }
      const piece = chunk.subarray(start, nl);
      let line: Buffer;
      if (this.buf.length > 0) {
        this.buf.push(piece);
        line = Buffer.concat(this.buf);
        this.buf = [];
        this.size = 0;
      } else {
        line = piece;
      }
      if (line.length > MAX_LINE) throw new LineTooLongError();
      out.push(line);
      start = nl + 1;
    }
  }
}
