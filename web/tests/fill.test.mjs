import { test } from "node:test";
import assert from "node:assert/strict";
import { fillRegion, wallsFrom } from "../fill.js";

// A 20x20 page with a square outline from (5,5) to (14,14), one pixel wide.
const W = 20, H = 20;
function outline() {
  const data = new Uint8ClampedArray(W * H * 4).fill(255);
  for (let i = 5; i <= 14; i++) {
    for (const [x, y] of [[i, 5], [i, 14], [5, i], [14, i]]) data.fill(0, (y * W + x) * 4, (y * W + x) * 4 + 3);
  }
  return wallsFrom({ data, width: W, height: H });
}
const blank = () => new Uint8ClampedArray(W * H * 4);
const at = (mask, x, y) => mask[y * W + x];

test("fills inside the outline and nothing outside", () => {
  const walls = outline();
  const { mask } = fillRegion({ walls, paint: blank(), width: W, height: H, x: 9, y: 9, bleed: 0 });
  assert.equal(at(mask, 9, 9), 1);
  assert.equal(at(mask, 6, 6), 1);
  assert.equal(at(mask, 5, 9), 0, "the line itself");
  assert.equal(at(mask, 2, 2), 0, "outside");
  assert.equal(mask.reduce((a, b) => a + b, 0), 8 * 8);
});

test("bleeds under the line so no white halo is left", () => {
  const walls = outline();
  const { mask } = fillRegion({ walls, paint: blank(), width: W, height: H, x: 9, y: 9, bleed: 2 });
  assert.equal(at(mask, 5, 9), 1, "under the line");
  assert.equal(at(mask, 4, 9), 0, "never past it");
});

test("a fill aimed at a line lands in the nearest region", () => {
  const walls = outline();
  const outside = fillRegion({ walls, paint: blank(), width: W, height: H, x: 5, y: 2, bleed: 0 });
  assert.equal(at(outside.mask, 2, 2), 1);
  assert.equal(at(outside.mask, 9, 9), 0);
});

test("stops at paint of another colour, so a stroke can split a region", () => {
  const walls = outline();
  const paint = blank();
  for (let y = 6; y <= 13; y++) paint.set([30, 90, 200, 255], (y * W + 9) * 4);  // a blue stroke at x = 9
  const { mask } = fillRegion({ walls, paint, width: W, height: H, x: 7, y: 9, bleed: 0 });
  assert.equal(at(mask, 7, 9), 1);
  assert.equal(at(mask, 9, 9), 0, "the stroke");
  assert.equal(at(mask, 11, 9), 0, "beyond the stroke");
});

test("nothing to fill off the page", () => {
  assert.equal(fillRegion({ walls: outline(), paint: blank(), width: W, height: H, x: -1, y: 3 }), null);
});
