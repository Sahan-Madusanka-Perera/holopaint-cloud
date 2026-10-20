import { test } from "node:test";
import assert from "node:assert/strict";
import { View, MAX_ZOOM } from "../view.js";

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);

test("zooming about a point keeps that point still", () => {
  const v = new View(400, 300);
  const before = v.toPage(100, 80);
  v.zoomAt(2.5, 100, 80);
  const after = v.toPage(100, 80);
  near(after.x, before.x, "x");
  near(after.y, before.y, "y");
  assert.equal(v.zoom, 2.5);
});

test("zoom stays between fit and 5x", () => {
  const v = new View(400, 300);
  v.zoomAt(50);
  assert.equal(v.zoom, MAX_ZOOM);
  v.zoomAt(0.1);
  assert.equal(v.zoom, 1);
  assert.equal(v.zoomed, false);
  assert.deepEqual([v.x, v.y], [0, 0]);
});

test("the page always covers the frame", () => {
  const v = new View(400, 300);
  v.zoomAt(2, 0, 0);
  v.panBy(10_000, 10_000);
  assert.deepEqual([v.x, v.y], [0, 0]);
  v.panBy(-10_000, -10_000);
  assert.deepEqual([v.x, v.y], [-400, -300]);  // the bottom-right corner reaches the frame's
  const w = v.window;
  near(w.left + w.width, 1, "window ends at the right edge");
  near(w.top + w.height, 1, "window ends at the bottom edge");
});

test("a grab moves the page with the hand", () => {
  const v = new View(400, 300);
  v.zoomAt(3);
  const held = v.toPage(200, 150);
  v.pin(held, 230, 140);
  const now = v.toPage(230, 140);
  near(now.x, held.x, "x");
  near(now.y, held.y, "y");
});

test("resizing the frame keeps the same part of the page in view", () => {
  const v = new View(400, 300);
  v.zoomAt(2, 300, 200);
  const { left, top } = v.window;
  v.resize(800, 600);
  near(v.window.left, left, "left");
  near(v.window.top, top, "top");
});
