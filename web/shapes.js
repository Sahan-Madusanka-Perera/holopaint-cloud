// Shape geometry for the shape tools, as in HoloDraw's shape_tools.py: a line between
// the two points, a rectangle on two corners, a circle centred on the first point and
// passing through the second, and an ellipse inscribed in the two corners' box.

export const SHAPES = ["line", "rect", "circle", "ellipse"];

export function shapeGeometry(tool, a, b) {
  switch (tool) {
    case "line":
      return { kind: "line", x1: a.x, y1: a.y, x2: b.x, y2: b.y };
    case "rect":
      return { kind: "rect", x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
    case "circle": {
      const r = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
      return { kind: "ellipse", cx: a.x, cy: a.y, rx: r, ry: r };
    }
    case "ellipse":
      return {
        kind: "ellipse", cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2,
        rx: Math.max(1, Math.abs(b.x - a.x) / 2), ry: Math.max(1, Math.abs(b.y - a.y) / 2),
      };
    default:
      return null;
  }
}

// [left, top, right, bottom] of the geometry, before the stroke width.
export function shapeBounds(g) {
  if (g.kind === "line") return [Math.min(g.x1, g.x2), Math.min(g.y1, g.y2), Math.max(g.x1, g.x2), Math.max(g.y1, g.y2)];
  if (g.kind === "rect") return [g.x, g.y, g.x + g.w, g.y + g.h];
  return [g.cx - g.rx, g.cy - g.ry, g.cx + g.rx, g.cy + g.ry];
}

// Lines take no fill, as in HoloDraw.
export function canFill(tool) {
  return tool !== "line";
}
