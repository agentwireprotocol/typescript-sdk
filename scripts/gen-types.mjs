// Generates src/schema.ts from the vendored JSON Schema.
import { compile } from "json-schema-to-typescript";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const schema = JSON.parse(readFileSync(new URL("../schema/awp.schema.json", import.meta.url), "utf8"));
delete schema.$id; // the resolver would try to fetch it
// The root is a bare $ref to Message, which the generator cannot take: inline it.
const root = schema.$defs.Message;
delete schema.$ref;
Object.assign(schema, { title: "Message", oneOf: root.oneOf, description: root.description });
delete schema.$defs.Message;
// Type names follow the definitions (Hello, GrantMsg, Grant, ...), not the message titles.
for (const [name, def] of Object.entries(schema.$defs)) def.title = name;
// A $ref with a description beside it would become a copy of the target (Grant1, Grant2): keep the ref.
const strip = (node) => {
  if (Array.isArray(node)) return node.forEach(strip);
  if (node && typeof node === "object") {
    if ("$ref" in node)
      for (const k of Object.keys(node))
        if (k !== "$ref") delete node[k];
        else Object.values(node).forEach(strip);
  }
};
strip(schema);
let ts = await compile(schema, "Message", {
  bannerComment:
    "/* Generated from schema/awp.schema.json (the Agent Wire Protocol's JSON Schema) by scripts/gen-types.mjs. Do not edit by hand. */",
  additionalProperties: false,
  strictIndexSignatures: true,
  $refOptions: { resolve: { http: false } },
});
// The generator copies a definition it meets through more than one $ref (Grant1, Grant2): fold the copies.
const blocks = [...ts.matchAll(/export interface (\w+?)(\d*) \{\n([\s\S]*?)\n\}\n/g)];
const bodies = new Map(blocks.filter((m) => m[2] === "").map((m) => [m[1], m[3]]));
for (const m of blocks) {
  if (m[2] !== "" && bodies.get(m[1]) === m[3]) {
    ts = ts.replace(m[0], "");
    ts = ts.replace(new RegExp(`\\b${m[1]}${m[2]}\\b`, "g"), m[1]);
  }
}
const out = new URL("../src/schema.ts", import.meta.url);
writeFileSync(out, ts);
execFileSync(new URL("../node_modules/.bin/prettier", import.meta.url).pathname, ["--write", out.pathname], {
  stdio: "ignore",
});
console.log("wrote src/schema.ts", ts.length, "bytes");
