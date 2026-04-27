import { test } from "node:test";
import { strict as assert } from "node:assert";
import { EventQueue } from "../event-queue.ts";

test("push then next returns events in order", async () => {
  const q = new EventQueue<number>();
  q.push(1); q.push(2); q.push(3);
  assert.equal(await q.next(), 1);
  assert.equal(await q.next(), 2);
  assert.equal(await q.next(), 3);
});

test("next blocks until push", async () => {
  const q = new EventQueue<string>();
  const p = q.next();
  setTimeout(() => q.push("hi"), 10);
  assert.equal(await p, "hi");
});

test("multiple consecutive next calls are served FIFO", async () => {
  const q = new EventQueue<number>();
  const a = q.next();
  const b = q.next();
  q.push(1); q.push(2);
  assert.equal(await a, 1);
  assert.equal(await b, 2);
});

test("pushForce always delivers, even after overflow shutdown", () => {
  let overflowed = false;
  const q = new EventQueue<number>({ maxSize: 2, onOverflow: () => { overflowed = true; } });
  q.push(1); q.push(2);
  q.push(3); // overflow
  assert.equal(overflowed, true);
  q.pushForce(99); // still works
});
