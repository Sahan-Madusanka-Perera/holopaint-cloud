// Flood fill for the colouring page. Walls are the outline's black pixels, which the
// worker guarantees close into regions. The fill also stops where the paint changes
// colour, so a brush stroke can close a gap or split a region.

const WALL_BELOW = 128;  // outline luminance; the worker writes pure 0 / 255
const SNAP_RADIUS = 6;   // a fill aimed at a line lands in the nearest open pixel

export function wallsFrom({ data, width, height }) {
  const walls = new Uint8Array(width * height);
  for (let i = 0; i < walls.length; i++) {
    const o = i * 4;
    walls[i] = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2] < WALL_BELOW ? 1 : 0;
  }
  return walls;
}

function nearestOpen(walls, width, height, x, y) {
  if (!walls[y * width + x]) return [x, y];
  let best = null;
  let bestD = Infinity;
  for (let dy = -SNAP_RADIUS; dy <= SNAP_RADIUS; dy++) {
    for (let dx = -SNAP_RADIUS; dx <= SNAP_RADIUS; dx++) {
      const nx = x + dx, ny = y + dy, d = dx * dx + dy * dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height || d >= bestD || d > SNAP_RADIUS ** 2) continue;
      if (!walls[ny * width + nx]) { best = [nx, ny]; bestD = d; }
    }
  }
  return best;
}

// Paint is RGBA (not premultiplied); unpainted pixels are transparent, so read it over white.
function composite(paint, i, out) {
  const o = i * 4, a = paint[o + 3] / 255;
  out[0] = paint[o] * a + 255 * (1 - a);
  out[1] = paint[o + 1] * a + 255 * (1 - a);
  out[2] = paint[o + 2] * a + 255 * (1 - a);
}

// Returns the region as a mask with its bounding box, or null when there is nothing to fill.
// `bleed` grows the region that many pixels under the adjacent lines, so no white
// halo is left between the paint and the line drawn over it.
export function fillRegion({ walls, paint, width, height, x, y, tolerance = 40, bleed = 2 }) {
  x = Math.round(x);
  y = Math.round(y);
  if (x < 0 || y < 0 || x >= width || y >= height) return null;
  const seed = nearestOpen(walls, width, height, x, y);
  if (!seed) return null;

  const target = [0, 0, 0];
  const px = [0, 0, 0];
  composite(paint, seed[1] * width + seed[0], target);
  const mask = new Uint8Array(width * height);
  const open = (i) => {
    if (walls[i] || mask[i]) return false;
    composite(paint, i, px);
    return Math.abs(px[0] - target[0]) <= tolerance
      && Math.abs(px[1] - target[1]) <= tolerance
      && Math.abs(px[2] - target[2]) <= tolerance;
  };

  let x0 = seed[0], x1 = seed[0], y0 = seed[1], y1 = seed[1];
  const stack = [seed];
  while (stack.length) {
    const [sx, sy] = stack.pop();
    const row = sy * width;
    if (!open(row + sx)) continue;
    let left = sx, right = sx;
    while (left > 0 && open(row + left - 1)) left--;
    while (right < width - 1 && open(row + right + 1)) right++;
    for (let i = left; i <= right; i++) mask[row + i] = 1;
    if (left < x0) x0 = left;
    if (right > x1) x1 = right;
    if (sy < y0) y0 = sy;
    if (sy > y1) y1 = sy;
    for (const ny of [sy - 1, sy + 1]) {
      if (ny < 0 || ny >= height) continue;
      let inSpan = false;
      for (let i = left; i <= right; i++) {
        const fits = open(ny * width + i);
        if (fits && !inSpan) stack.push([i, ny]);
        inSpan = fits;
      }
    }
  }

  for (let pass = 0; pass < bleed; pass++) {
    const grow = [];
    const gx0 = Math.max(0, x0 - 1), gx1 = Math.min(width - 1, x1 + 1);
    const gy0 = Math.max(0, y0 - 1), gy1 = Math.min(height - 1, y1 + 1);
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const i = gy * width + gx;
        if (mask[i] || !walls[i]) continue;
        if ((gx > 0 && mask[i - 1] === 1) || (gx < width - 1 && mask[i + 1] === 1)
          || (gy > 0 && mask[i - width] === 1) || (gy < height - 1 && mask[i + width] === 1)) grow.push(i);
      }
    }
    for (const i of grow) mask[i] = 1;
    [x0, x1, y0, y1] = [gx0, gx1, gy0, gy1];
  }

  return { mask, x0, y0, x1, y1 };
}
