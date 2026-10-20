import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Gesture, GestureFilter, OneEuro, REACH, classify, isPinch, palmSize, pushZoom, toPoints, toRect } from "../gestures.js";

const { poses } = JSON.parse(readFileSync(new URL("./fixtures/hands.json", import.meta.url), "utf8"));
const points = (name) => toPoints(poses[name].landmarks.map(([x, y]) => ({ x, y })), poses[name].aspect);

function rotate(p, degrees) {
  const r = (degrees * Math.PI) / 180, [cx, cy] = [p[0].x, p[0].y];
  return p.map(({ x, y }) => ({
    x: cx + (x - cx) * Math.cos(r) - (y - cy) * Math.sin(r),
    y: cy + (x - cx) * Math.sin(r) + (y - cy) * Math.cos(r),
  }));
}

test("classifies MediaPipe's test photos", () => {
  assert.equal(classify(points("pointing_up")), Gesture.DRAW);
  assert.equal(classify(points("victory")), Gesture.NAVIGATE);
  assert.equal(classify(points("fist")), Gesture.UNDO);
  // HoloDraw's height rule reads this sideways hand as two raised fingers.
  assert.equal(classify(points("thumb_up")), Gesture.REDO);
});

// No test photo raises three fingers, so straighten the ring finger of the victory
// hand along its middle finger: each joint keeps the middle finger's offset from its knuckle.
function raise(p, finger, like = 9) {
  const out = p.map((q) => ({ ...q }));
  for (let k = 1; k <= 3; k++) {
    out[finger + k] = { x: p[finger].x + p[like + k].x - p[like].x, y: p[finger].y + p[like + k].y - p[like].y };
  }
  return out;
}

test("three fingers hold the page; four or five do nothing", () => {
  const three = raise(points("victory"), 13);
  assert.equal(classify(three), Gesture.ZOOM);
  for (const degrees of [-45, 90]) assert.equal(classify(rotate(three, degrees)), Gesture.ZOOM, `${degrees}°`);
  assert.equal(classify(raise(three, 17)), Gesture.IDLE);
});

test("pushing the hand toward the camera zooms in, pulling it back zooms out", () => {
  const p = points("pointing_up");
  const grow = (q, k) => q.map(({ x, y }) => ({ x: p[0].x + (x - p[0].x) * k, y: p[0].y + (y - p[0].y) * k }));
  assert.ok(Math.abs(palmSize(grow(p, 1.3)) / palmSize(p) - 1.3) < 1e-9, "palm size scales with the hand");
  assert.equal(pushZoom(1), 1);
  assert.equal(pushZoom(1.04), 1, "a steady hand's wobble does not zoom");
  assert.ok(pushZoom(1.3) > 1.5 && pushZoom(1.3) < 2, `x${pushZoom(1.3).toFixed(2)} for a hand 30% larger`);
  assert.ok(Math.abs(pushZoom(1.3) * pushZoom(1 / 1.3) - 1) < 1e-9, "pulling back undoes pushing in");
});

test("holds at any hand rotation", () => {
  for (const degrees of [-60, 45, 90, 180]) {
    assert.equal(classify(rotate(points("pointing_up"), degrees)), Gesture.DRAW, `${degrees}°`);
    assert.equal(classify(rotate(points("victory"), degrees)), Gesture.NAVIGATE, `${degrees}°`);
    assert.equal(classify(rotate(points("fist"), degrees)), Gesture.UNDO, `${degrees}°`);
  }
});

test("a pinch needs the index reaching out, not folded into a fist", () => {
  const p = points("pointing_up");
  p[4] = { x: p[8].x + 0.01, y: p[8].y + 0.01 };  // thumb tip onto index tip
  assert.equal(classify(p), Gesture.SELECT);
  assert.ok(!isPinch(points("fist")), "fist tips touch but the index is folded");
});

test("a pinch ends only once the tips clearly part", () => {
  const p = points("pointing_up");
  const palm = Math.hypot(p[0].x - p[9].x, p[0].y - p[9].y);
  p[4] = { x: p[8].x + 0.36 * palm, y: p[8].y };  // between PINCH_ON and PINCH_OFF
  assert.equal(isPinch(p, false), false);
  assert.equal(isPinch(p, true), true);
});

test("a gesture counts after two steady frames; undo waits longer", () => {
  const f = new GestureFilter();
  assert.deepEqual(f.update(Gesture.DRAW, 0), { gesture: Gesture.IDLE, entered: false });
  assert.deepEqual(f.update(Gesture.DRAW, 33), { gesture: Gesture.DRAW, entered: true });
  assert.deepEqual(f.update(Gesture.DRAW, 66), { gesture: Gesture.DRAW, entered: false });

  let t = 100;
  const seen = [];
  for (; t <= 400; t += 33) seen.push(f.update(Gesture.UNDO, t));
  const first = seen.findIndex((s) => s.entered);
  assert.ok(first > 0 && 100 + first * 33 >= 320, "undo held at least 220 ms");
  assert.equal(seen.filter((s) => s.entered).length, 1, "a held fist undoes once");
});

test("a passing fist does not undo", () => {
  const f = new GestureFilter();
  f.update(Gesture.DRAW, 0);
  f.update(Gesture.DRAW, 33);
  for (const t of [66, 99, 132]) assert.equal(f.update(Gesture.UNDO, t).gesture, Gesture.DRAW);
  assert.equal(f.update(Gesture.NAVIGATE, 165).entered, false);
});

test("One Euro settles on a still hand and damps jitter", () => {
  const filter = new OneEuro({ minCutoff: 1.2, beta: 0.012 });
  let out = 0, spread = 0;
  for (let i = 0; i < 90; i++) {
    out = filter.filter(100 + (i % 2 ? 3 : -3), i / 30);  // ±3 px jitter at 30 fps
    if (i > 30) spread = Math.max(spread, Math.abs(out - 100));
  }
  assert.ok(spread < 1.5, `jitter ${spread.toFixed(2)} px after smoothing`);
});

test("the reach maps onto the page and clamps beyond it", () => {
  const rect = { left: 10, top: 20, width: 600, height: 400 };
  assert.deepEqual(toRect(REACH.left, REACH.top, rect), { x: 10, y: 20 });
  assert.deepEqual(toRect(REACH.right, REACH.bottom, rect), { x: 610, y: 420 });
  assert.deepEqual(toRect(0, 1, rect), { x: 10, y: 420 });
});
