// The paint layer under the colouring page. Paint sits below the outline, which is
// multiplied over it, so a brush can never cover a line. Undo keeps only the
// rectangle each action changed, not a copy of the whole page.

import { wallsFrom, fillRegion } from "./fill.js";

const HISTORY_BYTES = 160 * 1024 * 1024;
const MIN_STEP = 2;  // display pixels between brush samples

export const PAPER = "paper";  // the eraser: paint back to bare paper

export class Painter {
  constructor(canvas, { onChange = () => {} } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { willReadFrequently: true });
    this.onChange = onChange;
    this.ink = "#141414";
    this.size = 12;  // brush diameter in display pixels
    this.walls = null;
    this.stroke = null;
    this.done = [];
    this.undone = [];
  }

  // Size the layer to the outline's own pixels and read its walls once.
  load(outline) {
    const { naturalWidth: width, naturalHeight: height } = outline;
    this.canvas.width = width;
    this.canvas.height = height;
    const scratch = new OffscreenCanvas(width, height).getContext("2d", { willReadFrequently: true });
    scratch.drawImage(outline, 0, 0);
    this.walls = wallsFrom(scratch.getImageData(0, 0, width, height));
    this.outline = outline;
    this.done = [];
    this.undone = [];
    this.stroke = null;
    this.onChange();
  }

  get ready() { return this.walls !== null; }
  get painted() { return this.done.length > 0; }
  get canUndo() { return this.done.length > 0; }
  get canRedo() { return this.undone.length > 0; }

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

  scale() {
    return this.canvas.width / this.canvas.getBoundingClientRect().width;
  }

  // Brush

  beginStroke(point) {
    if (!this.ready) return;
    this.endStroke();
    const before = new OffscreenCanvas(this.canvas.width, this.canvas.height);
    before.getContext("2d").drawImage(this.canvas, 0, 0);
    const width = this.size * this.scale();
    this.stroke = { before, width, last: point, mid: point, box: [point.x, point.y, point.x, point.y] };
    const ctx = this.brush(width);
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
    const ctx = this.brush(s.width);
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
      const ctx = this.brush(s.width);
      ctx.beginPath();
      ctx.moveTo(s.mid.x, s.mid.y);
      ctx.lineTo(s.last.x, s.last.y);
      ctx.stroke();
      ctx.restore();
    }
    const pad = s.width / 2 + 2;
    const x = Math.max(0, Math.floor(s.box[0] - pad));
    const y = Math.max(0, Math.floor(s.box[1] - pad));
    const w = Math.min(this.canvas.width, Math.ceil(s.box[2] + pad)) - x;
    const h = Math.min(this.canvas.height, Math.ceil(s.box[3] + pad)) - y;
    if (w <= 0 || h <= 0) return;
    const before = s.before.getContext("2d").getImageData(x, y, w, h);
    this.record({ x, y, before, after: this.ctx.getImageData(x, y, w, h) });
  }

  brush(width) {
    const ctx = this.ctx;
    ctx.save();
    ctx.lineWidth = width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (this.ink === PAPER) {
      ctx.globalCompositeOperation = "destination-out";
      ctx.strokeStyle = ctx.fillStyle = "#000";
    } else {
      ctx.strokeStyle = ctx.fillStyle = this.ink;
    }
    return ctx;
  }

  // Fill

  fillAt(point) {
    if (!this.ready) return false;
    this.endStroke();
    const { width, height } = this.canvas;
    const paint = this.ctx.getImageData(0, 0, width, height);
    const region = fillRegion({ walls: this.walls, paint: paint.data, width, height, x: point.x, y: point.y });
    if (!region) return false;

    const { mask, x0, y0, x1, y1 } = region;
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    const before = this.ctx.getImageData(x0, y0, w, h);
    const after = new ImageData(new Uint8ClampedArray(before.data), w, h);
    const [r, g, b] = this.ink === PAPER ? [0, 0, 0] : hexToRgb(this.ink);
    const a = this.ink === PAPER ? 0 : 255;
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
    const step = this.done.pop();
    if (!step) return false;
    this.ctx.putImageData(step.before, step.x, step.y);
    this.undone.push(step);
    this.onChange();
    return true;
  }

  redo() {
    this.endStroke();
    const step = this.undone.pop();
    if (!step) return false;
    this.ctx.putImageData(step.after, step.x, step.y);
    this.done.push(step);
    this.onChange();
    return true;
  }

  clear() {
    this.stroke = null;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.walls = null;
    this.done = [];
    this.undone = [];
    this.onChange();
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
    ctx.globalCompositeOperation = "multiply";
    ctx.drawImage(this.outline, 0, 0, width, height);
    return new Promise((resolve) => out.toBlob(resolve, "image/png"));
  }
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
