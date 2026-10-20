// Zoom and pan for the page, up to 5x as in HoloDraw. The page is scaled about its
// frame's top-left corner and then moved; it always covers the frame, so no empty
// stock shows past its edges. Points are in frame pixels.

export const MAX_ZOOM = 5;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export class View {
  constructor(width = 0, height = 0) {
    this.width = width;
    this.height = height;
    this.reset();
  }

  reset() {
    this.zoom = 1;
    this.x = 0;
    this.y = 0;
  }

  get zoomed() { return this.zoom > 1.001; }

  // The frame changed size: keep the same part of the page in view.
  resize(width, height) {
    if (this.width && this.height) {
      this.x *= width / this.width;
      this.y *= height / this.height;
    }
    this.width = width;
    this.height = height;
    this.clamp();
  }

  // Frame point -> the page point under it, in unzoomed frame pixels.
  toPage(fx, fy) {
    return { x: (fx - this.x) / this.zoom, y: (fy - this.y) / this.zoom };
  }

  // Put page point `p` under frame point (fx, fy) at `zoom`: a grab, a pinch, or a
  // zoom about the pointer, which keeps whatever is under it in place.
  pin(p, fx, fy, zoom = this.zoom) {
    this.zoom = clamp(zoom, 1, MAX_ZOOM);
    this.x = fx - p.x * this.zoom;
    this.y = fy - p.y * this.zoom;
    this.clamp();
  }

  zoomAt(zoom, fx = this.width / 2, fy = this.height / 2) {
    this.pin(this.toPage(fx, fy), fx, fy, zoom);
  }

  panBy(dx, dy) {
    this.x += dx;
    this.y += dy;
    this.clamp();
  }

  clamp() {
    this.x = clamp(this.x, this.width * (1 - this.zoom), 0);
    this.y = clamp(this.y, this.height * (1 - this.zoom), 0);
  }

  // The part of the page in view, as fractions of the page.
  get window() {
    const size = 1 / this.zoom;
    return {
      left: this.width ? -this.x / (this.width * this.zoom) : 0,
      top: this.height ? -this.y / (this.height * this.zoom) : 0,
      width: size,
      height: size,
    };
  }

  get transform() {
    return `translate(${this.x}px, ${this.y}px) scale(${this.zoom})`;
  }
}
