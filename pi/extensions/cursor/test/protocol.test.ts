import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  CONNECT_END_STREAM_FLAG,
  createConnectFrameParser,
  decodeConnectUnaryBody,
  frameConnectMessage,
  parseConnectEndStream,
} from "../protocol.ts";

test("frameConnectMessage prepends 5-byte header (flag + big-endian length)", () => {
  const data = new Uint8Array([1, 2, 3, 4]);
  const framed = frameConnectMessage(data);
  assert.equal(framed[0], 0);
  assert.equal(framed.readUInt32BE(1), 4);
  assert.deepEqual(framed.subarray(5), Buffer.from(data));
});

test("parser delivers messages and end-stream separately", () => {
  const messages: Uint8Array[] = [];
  const ends: Uint8Array[] = [];
  const parse = createConnectFrameParser(
    (b: Uint8Array) => messages.push(b),
    (b: Uint8Array) => ends.push(b),
  );

  const m1 = frameConnectMessage(new Uint8Array([0xaa, 0xbb]));
  const m2 = frameConnectMessage(new Uint8Array([0xcc]));
  const eof = frameConnectMessage(Buffer.from('{"error":null}'), CONNECT_END_STREAM_FLAG);
  parse(Buffer.concat([m1, m2, eof]));

  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0], Buffer.from([0xaa, 0xbb]));
  assert.deepEqual(messages[1], Buffer.from([0xcc]));
  assert.equal(ends.length, 1);
});

test("parser buffers partial frames across calls", () => {
  const messages: Uint8Array[] = [];
  const parse = createConnectFrameParser(
    (b: Uint8Array) => messages.push(b),
    () => {},
  );
  const full = frameConnectMessage(new Uint8Array([1, 2, 3, 4, 5]));
  parse(full.subarray(0, 3));
  assert.equal(messages.length, 0);
  parse(full.subarray(3));
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], Buffer.from([1, 2, 3, 4, 5]));
});

test("oversize frame triggers endStream and resets buffer", () => {
  const ends: Uint8Array[] = [];
  const parse = createConnectFrameParser(
    () => {},
    (b: Uint8Array) => ends.push(b),
  );
  const header = Buffer.alloc(5);
  header[0] = 0;
  header.writeUInt32BE(64 * 1024 * 1024, 1); // 64 MiB > 32 MiB cap
  parse(header);
  assert.equal(ends.length, 1);
  const txt = new TextDecoder().decode(ends[0]!);
  assert.match(txt, /frame_too_large/);
});

test("decodeConnectUnaryBody extracts the data frame", () => {
  const payload = new Uint8Array([9, 9, 9]);
  const framed = frameConnectMessage(payload);
  const decoded = decodeConnectUnaryBody(framed);
  assert.deepEqual(decoded, Buffer.from([9, 9, 9]));
});

test("parseConnectEndStream returns null on success", () => {
  const buf = new TextEncoder().encode("{}");
  assert.equal(parseConnectEndStream(buf), null);
});

test("parseConnectEndStream returns Error with code+message", () => {
  const buf = new TextEncoder().encode(
    JSON.stringify({ error: { code: "resource_exhausted", message: "boom" } }),
  );
  const err = parseConnectEndStream(buf);
  assert.ok(err instanceof Error);
  assert.match(err!.message, /resource_exhausted/);
  assert.match(err!.message, /boom/);
});
