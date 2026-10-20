import { test } from "node:test";
import assert from "node:assert/strict";
import { shapeGeometry, shapeBounds, canFill } from "../shapes.js";

const a = { x: 50, y: 40 }, b = { x: 20, y: 100 };

test("shapes follow HoloDraw's shape_tools", () => {
  assert.deepEqual(shapeGeometry("line", a, b), { kind: "line", x1: 50, y1: 40, x2: 20, y2: 100 });
  // Two corners in any order.
  assert.deepEqual(shapeGeometry("rect", a, b), { kind: "rect", x: 20, y: 40, w: 30, h: 60 });
  // A circle is centred on the first point and passes through the second.
  const circle = shapeGeometry("circle", a, b);
  assert.equal(circle.cx, 50);
  assert.equal(circle.rx, Math.hypot(30, 60));
  assert.equal(circle.rx, circle.ry);
  // An ellipse is inscribed in the corners' box.
  assert.deepEqual(shapeGeometry("ellipse", a, b), { kind: "ellipse", cx: 35, cy: 70, rx: 15, ry: 30 });
});

test("bounds cover the whole shape", () => {
  assert.deepEqual(shapeBounds(shapeGeometry("rect", a, b)), [20, 40, 50, 100]);
  const r = Math.hypot(30, 60);
  assert.deepEqual(shapeBounds(shapeGeometry("circle", a, b)), [50 - r, 40 - r, 50 + r, 40 + r]);
  assert.deepEqual(shapeBounds(shapeGeometry("line", a, b)), [20, 40, 50, 100]);
});

test("a click is never a zero-size shape", () => {
  const dot = shapeGeometry("ellipse", a, a);
  assert.ok(dot.rx >= 1 && dot.ry >= 1);
  assert.equal(shapeGeometry("circle", a, a).rx, 1);
});

test("lines take no fill", () => {
  assert.equal(canFill("line"), false);
  for (const tool of ["rect", "circle", "ellipse"]) assert.equal(canFill(tool), true);
});
