// The paint layer under the colouring page. Paint sits below the outline, which is
// multiplied over it, so a brush can never cover a line. Undo keeps only the
// rectangle each action changed, not a copy of the whole page.
//
// Tools follow HoloDraw: brush, eraser, fill, and line, rectangle, circle and ellipse,
// drawn filled or as outlines. A shape is previewed on its own layer until placed.

import { wallsFrom, fillRegion } from "./fill.js";
import { SHAPES, shapeGeometry, shapeBounds, canFill } from "./shapes.js";

const HISTORY_BYTES = 160 * 1024 * 1024;
const MIN_STEP = 2;    // display pixels between brush samples
const MIN_SHAPE = 3;   // display pixels a shape must span to be placed

export const TOOLS = ["brush", "eraser", "fill", ...SHAPES];
export const isShape = (tool) => SHAPES.includes(tool);

export class Painter {
  constructor(canvas, preview, { onChange = () => {} } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { willReadFrequently: true });
    this.preview = preview;
    this.previewCtx = preview.getContext("2d");
    this.onChange = onChange;
    this.tool = "brush";
    this.ink = "#141414";
    this.size = 12;        // brush and line width in display pixels
    this.filled = false;   // shapes: filled, or outlines
    this.walls = null;
    this.outline = null;
    this.stroke = null;
    this.shape = null;
    this.done = [];
    this.undone = [];
  }

  // Size the layer to the outline's own pixels and read its walls once.
  load(outline) {
    this.resize(outline.naturalWidth, outline.naturalHeight);
    this.outline = outline;
    this.walls = this.readWalls(outline);
    this.onChange();
  }

  // HoloDraw's drawing mode: a blank page with no outline, so nothing stops a fill
  // but the paint itself.
  loadBlank(width, height) {
    this.resize(width, height);
    this.outline = null;
    this.walls = new Uint8Array(width * height);
    this.onChange();
  }

  // The same page traced at another detail level. Same size, so paint and history stay.
  setOutline(outline) {
    if (outline.naturalWidth !== this.canvas.width || outline.naturalHeight !== this.canvas.height) return false;
    this.endStroke();
    this.cancelShape();
    this.outline = outline;
    this.walls = this.readWalls(outline);
    return true;
  }

  resize(width, height) {
    this.canvas.width = this.preview.width = width;
    this.canvas.height = this.preview.height = height;
    this.done = [];
    this.undone = [];
    this.stroke = null;
    this.shape = null;
  }

  readWalls(outline) {
    const { width, height } = this.canvas;
    const scratch = new OffscreenCanvas(width, height).getContext("2d", { willReadFrequently: true });
    scratch.drawImage(outline, 0, 0, width, height);
    return wallsFrom(scratch.getImageData(0, 0, width, height));
  }

  get ready() { return this.walls !== null; }
  get painted() { return this.done.length > 0; }
  get canUndo() { return this.done.length > 0; }
  get canRedo() { return this.undone.length > 0; }
  get erasing() { return this.tool === "eraser"; }

  // Viewport point -> layer pixel. Outside the page: null, or the nearest edge with `clamp`.
  toLayer(clientX, clientY, { clamp = false } = {}) {
    const rect = this.canvas.getBoundingClientRect();
    if (clamp) {
      clientX = Math.min(rect.right, Math.max(rect.left, clientX));
      clientY = Math.min(rect.bottom, Math.max(rect.top, clientY));
    }
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return null;
    return {
      x: ((clientX - rect.left) / rect.width) * this.canvas.width,
      y: ((clientY - rect.top) / rect.height) * this.canvas.height,
    };
  }

  // Layer pixels per display pixel. Zooming in shrinks it, so the brush keeps its
  // size on screen and draws finer on the page.
  scale() {
    return this.canvas.width / this.canvas.getBoundingClientRect().width;
  }

  // Brush and eraser

  beginStroke(point) {
    if (!this.ready) return;
    this.endStroke();
    const before = new OffscreenCanvas(this.canvas.width, this.canvas.height);
    before.getContext("2d").drawImage(this.canvas, 0, 0);
    const width = this.size * this.scale();
    this.stroke = { before, width, last: point, mid: point, box: [point.x, point.y, point.x, point.y] };
    const ctx = this.pen(this.ctx, width);
    ctx.beginPath();
    ctx.arc(point.x, point.y, width / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  extendStroke(point) {
    const s = this.stroke;
    if (!s || Math.hypot(point.x - s.last.x, point.y - s.last.y) < MIN_STEP * this.scale()) return;
    // Quadratic segments through the midpoints keep a jittery hand smooth.
    const mid = { x: (s.last.x + point.x) / 2, y: (s.last.y + point.y) / 2 };
    const ctx = this.pen(this.ctx, s.width);
    ctx.beginPath();
    ctx.moveTo(s.mid.x, s.mid.y);
    ctx.quadraticCurveTo(s.last.x, s.last.y, mid.x, mid.y);
    ctx.stroke();
    ctx.restore();
    s.last = point;
    s.mid = mid;
    s.box = [Math.min(s.box[0], point.x), Math.min(s.box[1], point.y), Math.max(s.box[2], point.x), Math.max(s.box[3], point.y)];
  }

  endStroke() {
    const s = this.stroke;
    if (!s) return;
    this.stroke = null;
    if (s.last !== s.mid) {  // the curves stop at the last midpoint; finish the line
      const ctx = this.pen(this.ctx, s.width);
      ctx.beginPath();
      ctx.moveTo(s.mid.x, s.mid.y);
      ctx.lineTo(s.last.x, s.last.y);
      ctx.stroke();
      ctx.restore();
    }
    const rect = this.padded(s.box, s.width / 2 + 2);
    if (!rect) return;
    const before = s.before.getContext("2d").getImageData(rect.x, rect.y, rect.w, rect.h);
    this.record({ x: rect.x, y: rect.y, before, after: this.ctx.getImageData(rect.x, rect.y, rect.w, rect.h) });
  }

  // A second finger landed: the first one was starting a pinch, not a stroke.
  cancelStroke() {
    const s = this.stroke;
    if (!s) return;
    this.stroke = null;
    this.ctx.save();
    this.ctx.globalCompositeOperation = "copy";
    this.ctx.drawImage(s.before, 0, 0);
    this.ctx.restore();
  }

  // Shapes

  beginShape(point) {
    if (!this.ready || !isShape(this.tool)) return;
    this.endStroke();
    this.shape = { tool: this.tool, from: point, to: point, width: this.size * this.scale() };
    this.drawPreview();
  }

  extendShape(point) {
    if (!this.shape) return;
    this.shape.to = point;
    this.drawPreview();
  }

  // Place the previewed shape on the page. False if it was too small to mean anything.
  commitShape() {
    const s = this.shape;
    if (!s) return false;
    this.cancelShape();
    if (Math.hypot(s.to.x - s.from.x, s.to.y - s.from.y) < MIN_SHAPE * this.scale()) return false;
    const rect = this.padded(shapeBounds(shapeGeometry(s.tool, s.from, s.to)), s.width / 2 + 2);
    if (!rect) return false;
    const before = this.ctx.getImageData(rect.x, rect.y, rect.w, rect.h);
    this.drawShape(this.ctx, s);
    this.record({ x: rect.x, y: rect.y, before, after: this.ctx.getImageData(rect.x, rect.y, rect.w, rect.h) });
    return true;
  }

  cancelShape() {
    if (!this.shape) return;
    this.shape = null;
    this.previewCtx.clearRect(0, 0, this.preview.width, this.preview.height);
  }

  get shaping() { return this.shape !== null; }

  // The preview uses the same ink and width as the placed shape, under the outline.
  drawPreview() {
    this.previewCtx.clearRect(0, 0, this.preview.width, this.preview.height);
    this.drawShape(this.previewCtx, this.shape);
  }

  drawShape(target, s) {
    const g = shapeGeometry(s.tool, s.from, s.to);
    const ctx = this.pen(target, s.width, { erase: false });
    ctx.beginPath();
    if (g.kind === "line") {
      ctx.moveTo(g.x1, g.y1);
      ctx.lineTo(g.x2, g.y2);
    } else if (g.kind === "rect") {
      ctx.rect(g.x, g.y, g.w, g.h);
    } else {
      ctx.ellipse(g.cx, g.cy, g.rx, g.ry, 0, 0, Math.PI * 2);
    }
    if (this.filled && canFill(s.tool)) ctx.fill();
    else ctx.stroke();
    ctx.restore();
  }

  // Ink and line settings for a brush, eraser or shape. The caller restores.
  pen(ctx, width, { erase = this.erasing } = {}) {
    ctx.save();
    ctx.lineWidth = width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (erase) {
      ctx.globalCompositeOperation = "destination-out";
      ctx.strokeStyle = ctx.fillStyle = "#000";
    } else {
      ctx.strokeStyle = ctx.fillStyle = this.ink;
    }
    return ctx;
  }

  // Fill. With the eraser it clears the area back to paper instead.

  fillAt(point) {
    if (!this.ready) return false;
    this.endStroke();
    this.cancelShape();
    const { width, height } = this.canvas;
    const paint = this.ctx.getImageData(0, 0, width, height);
    const region = fillRegion({ walls: this.walls, paint: paint.data, width, height, x: point.x, y: point.y });
    if (!region) return false;

    const { mask, x0, y0, x1, y1 } = region;
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    const before = this.ctx.getImageData(x0, y0, w, h);
    const after = new ImageData(new Uint8ClampedArray(before.data), w, h);
    const [r, g, b] = this.erasing ? [0, 0, 0] : hexToRgb(this.ink);
    const a = this.erasing ? 0 : 255;
    let changed = false;
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        if (!mask[(y0 + yy) * width + x0 + xx]) continue;
        const o = (yy * w + xx) * 4;
        const d = after.data;
        if (d[o] === r && d[o + 1] === g && d[o + 2] === b && d[o + 3] === a) continue;
        d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = a;
        changed = true;
      }
    }
    if (!changed) return false;
    this.ctx.putImageData(after, x0, y0);
    this.record({ x: x0, y: y0, before, after });
    return true;
  }

  // Wipe all the paint, as one step that undo brings back.
  clearAll() {
    if (!this.ready) return false;
    this.endStroke();
    this.cancelShape();
    const { width, height } = this.canvas;
    const before = this.ctx.getImageData(0, 0, width, height);
    let any = false;
    for (let i = 3; i < before.data.length && !any; i += 4) any = before.data[i] !== 0;
    if (!any) return false;
    this.ctx.clearRect(0, 0, width, height);
    this.record({ x: 0, y: 0, before, after: new ImageData(width, height) });
    return true;
  }

  // History

  record(step) {
    this.done.push(step);
    this.undone = [];
    let bytes = this.done.reduce((sum, s) => sum + s.before.data.length * 2, 0);
    while (bytes > HISTORY_BYTES && this.done.length > 1) bytes -= this.done.shift().before.data.length * 2;
    this.onChange();
  }

  undo() {
    this.endStroke();
    this.cancelShape();
    const step = this.done.pop();
    if (!step) return false;
    this.ctx.putImageData(step.before, step.x, step.y);
    this.undone.push(step);
    this.onChange();
    return true;
  }

  redo() {
    this.endStroke();
    this.cancelShape();
    const step = this.undone.pop();
    if (!step) return false;
    this.ctx.putImageData(step.after, step.x, step.y);
    this.done.push(step);
    this.onChange();
    return true;
  }

  clear() {
    this.stroke = null;
    this.cancelShape();
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.walls = null;
    this.outline = null;
    this.done = [];
    this.undone = [];
    this.onChange();
  }

  // Layer pixels covered by a box grown by `pad`, clipped to the page.
  padded(box, pad) {
    const x = Math.max(0, Math.floor(box[0] - pad));
    const y = Math.max(0, Math.floor(box[1] - pad));
    const w = Math.min(this.canvas.width, Math.ceil(box[2] + pad)) - x;
    const h = Math.min(this.canvas.height, Math.ceil(box[3] + pad)) - y;
    return w > 0 && h > 0 ? { x, y, w, h } : null;
  }

  // The finished page: paper, then paint, then the outline multiplied over both.
  async toBlob() {
    const { width, height } = this.canvas;
    const out = document.createElement("canvas");
    out.width = width;
    out.height = height;
    const ctx = out.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(this.canvas, 0, 0);
    if (this.outline) {
      ctx.globalCompositeOperation = "multiply";
      ctx.drawImage(this.outline, 0, 0, width, height);
    }
    return new Promise((resolve) => out.toBlob(resolve, "image/png"));
  }
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
