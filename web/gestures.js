// Hand gestures from MediaPipe's 21 hand landmarks, ported from HoloDraw's
// gesture_recognizer.py. HoloDraw compares fingertip and knuckle heights, which
// misreads a sideways hand (a thumbs-up reads as two raised fingers). These rules
// compare distances from the wrist instead, so they hold at any hand rotation.
// Points are isotropic: x is scaled by the frame's aspect ratio before classifying.

export const Gesture = Object.freeze({
  IDLE: "idle",
  DRAW: "draw",          // index finger only
  NAVIGATE: "navigate",  // index and middle fingers
  SELECT: "select",      // pinch
  UNDO: "undo",          // fist
  REDO: "redo",          // thumb only
});

const WRIST = 0, THUMB_IP = 3, THUMB_TIP = 4, INDEX_MCP = 5, INDEX_PIP = 6, INDEX_TIP = 8;
const MIDDLE_MCP = 9, PINKY_MCP = 17;
const FINGERS = [[8, 6], [12, 10], [16, 14], [20, 18]];  // [tip, PIP] for index to pinky

// Thresholds, measured on MediaPipe's own test photos (web/tests/fixtures/hands.json).
const EXTENDED = 1.05;       // tip vs PIP distance from the wrist: curled <= 0.76, straight >= 1.32
const THUMB_OUT = 1.05;      // thumb tip vs IP distance from the pinky knuckle: tucked <= 0.71, out 1.18
const THUMB_CLEAR = 0.5;     // thumb tip to index knuckle, in palm lengths: tucked <= 0.42, out 0.84
const PINCH_ON = 0.3;        // thumb tip to index tip, in palm lengths
const PINCH_OFF = 0.42;      // a pinch ends only once the tips clearly part
const INDEX_FORWARD = 0.85;  // a pinching index reaches out; in a fist it folds back (0.68)

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// MediaPipe landmarks -> isotropic points in the mirrored (selfie) view.
export function toPoints(landmarks, aspect) {
  return landmarks.map((lm) => ({ x: (1 - lm.x) * aspect, y: lm.y }));
}

// [thumb, index, middle, ring, pinky], true when extended.
export function fingerStates(p) {
  const palm = dist(p[WRIST], p[MIDDLE_MCP]);
  const thumb = dist(p[THUMB_TIP], p[PINKY_MCP]) > THUMB_OUT * dist(p[THUMB_IP], p[PINKY_MCP])
    && dist(p[THUMB_TIP], p[INDEX_MCP]) > THUMB_CLEAR * palm;
  return [thumb, ...FINGERS.map(([tip, pip]) => dist(p[WRIST], p[tip]) > EXTENDED * dist(p[WRIST], p[pip]))];
}

export function isPinch(p, wasPinching = false) {
  const palm = dist(p[WRIST], p[MIDDLE_MCP]);
  const forward = dist(p[WRIST], p[INDEX_TIP]) > INDEX_FORWARD * dist(p[WRIST], p[INDEX_PIP]);
  return forward && dist(p[THUMB_TIP], p[INDEX_TIP]) < (wasPinching ? PINCH_OFF : PINCH_ON) * palm;
}

export function classify(p, wasPinching = false) {
  // Pinch first: in a fist the tips also meet, but the index is folded back.
  if (isPinch(p, wasPinching)) return Gesture.SELECT;
  const [thumb, index, middle, ring, pinky] = fingerStates(p);
  if (!thumb && !index && !middle && !ring && !pinky) return Gesture.UNDO;
  if (thumb && !index && !middle && !ring && !pinky) return Gesture.REDO;
  // The thumb is ignored while pointing; it sits anywhere when people point.
  if (index && !middle && !ring && !pinky) return Gesture.DRAW;
  if (index && middle && !ring && !pinky) return Gesture.NAVIGATE;
  return Gesture.IDLE;
}

// A gesture must hold steady before it counts, and undo and redo hold longer:
// a hand passing through a fist on its way somewhere shouldn't undo.
const HOLD_MS = { [Gesture.UNDO]: 220, [Gesture.REDO]: 220 };
const DEFAULT_HOLD_MS = 30;

export class GestureFilter {
  constructor() { this.reset(); }

  reset() {
    this.current = Gesture.IDLE;
    this.candidate = Gesture.IDLE;
    this.since = 0;
    this.frames = 0;
  }

  // Returns the accepted gesture, and whether this frame is the one it was entered on.
  update(raw, now) {
    if (raw !== this.candidate) {
      this.candidate = raw;
      this.since = now;
      this.frames = 0;
    }
    this.frames += 1;
    const hold = HOLD_MS[raw] ?? DEFAULT_HOLD_MS;
    if (raw !== this.current && this.frames >= 2 && now - this.since >= hold) {
      this.current = raw;
      return { gesture: raw, entered: true };
    }
    return { gesture: this.current, entered: false };
  }
}

// One Euro filter (Casiez et al., 2012): smooth when the hand is slow, responsive
// when it moves fast. Replaces HoloDraw's fixed EMA, which lags on quick strokes.
export class OneEuro {
  constructor({ minCutoff = 1.0, beta = 0.007, dCutoff = 1.0 } = {}) {
    Object.assign(this, { minCutoff, beta, dCutoff });
    this.reset();
  }

  reset() { this.x = null; }

  filter(value, t) {  // t in seconds
    if (this.x === null) {
      this.x = value;
      this.dx = 0;
      this.t = t;
      return value;
    }
    const dt = Math.max(t - this.t, 1e-3);
    this.t = t;
    const alpha = (cutoff) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
    this.dx += alpha(this.dCutoff) * ((value - this.x) / dt - this.dx);
    this.x += alpha(this.minCutoff + this.beta * Math.abs(this.dx)) * (value - this.x);
    return this.x;
  }
}

// The part of the camera frame that maps onto the page. Tracking fails where the hand
// leaves the frame, so the page's edges sit well inside it. Normalized, mirrored.
export const REACH = Object.freeze({ left: 0.15, right: 0.85, top: 0.12, bottom: 0.78 });

export function toRect(nx, ny, rect) {
  const u = clamp((nx - REACH.left) / (REACH.right - REACH.left), 0, 1);
  const v = clamp((ny - REACH.top) / (REACH.bottom - REACH.top), 0, 1);
  return { x: rect.left + u * rect.width, y: rect.top + v * rect.height };
}
