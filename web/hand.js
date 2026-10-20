// Camera and hand tracking, all on this device: MediaPipe's hand landmarker runs in
// the browser (WebAssembly, GPU when available) and no frame leaves the page.

import { REACH } from "./gestures.js";

const VISION = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1";
const MODEL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const CONFIDENCE = 0.7;  // HoloDraw's detection and tracking confidence

// Pairs of landmark indices that draw the hand.
const BONES = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
];

let loading = null;

function loadLandmarker() {
  loading ??= (async () => {
    const { FilesetResolver, HandLandmarker } = await import(`${VISION}/vision_bundle.mjs`);
    const files = await FilesetResolver.forVisionTasks(`${VISION}/wasm`);
    const create = (delegate) => HandLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: MODEL, delegate },
      runningMode: "VIDEO",
      numHands: 1,
      minHandDetectionConfidence: CONFIDENCE,
      minHandPresenceConfidence: CONFIDENCE,
      minTrackingConfidence: CONFIDENCE,
    });
    try {
      return { landmarker: await create("GPU"), delegate: "GPU" };
    } catch {
      return { landmarker: await create("CPU"), delegate: "CPU" };
    }
  })();
  loading.catch(() => { loading = null; });  // a failed download can be retried
  return loading;
}

export class CameraError extends Error {
  constructor(kind) {
    super(kind);
    this.kind = kind;  // "blocked" | "missing" | "unsupported" | "failed"
  }
}

export class HandCamera {
  constructor({ video, overlay, onFrame, onState }) {
    Object.assign(this, { video, overlay, onFrame, onState });
    this.stream = null;
    this.session = 0;
    this.running = false;
    this.lastTime = -1;
    this.lastStamp = 0;
    this.delegate = "";
    this.fps = 0;
  }

  // Resolves true once tracking is live, false if stop() was called on the way.
  async start() {
    if (this.running) return true;
    if (!navigator.mediaDevices?.getUserMedia) throw new CameraError("unsupported");
    const session = ++this.session;
    this.onState("starting");
    const tracker = loadLandmarker();  // download while the permission prompt is up
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
    } catch (error) {
      if (session !== this.session) return false;
      if (error.name === "NotAllowedError" || error.name === "SecurityError") throw new CameraError("blocked");
      if (error.name === "NotFoundError" || error.name === "OverconstrainedError") throw new CameraError("missing");
      throw new CameraError("failed");
    }
    if (session !== this.session) {
      stream.getTracks().forEach((track) => track.stop());
      return false;
    }
    this.stream = stream;
    this.video.srcObject = stream;
    await this.video.play().catch(() => {});

    this.onState("loading");
    try {
      ({ landmarker: this.landmarker, delegate: this.delegate } = await tracker);
    } catch {
      if (session !== this.session) return false;
      this.stop();
      throw new CameraError("failed");
    }
    if (session !== this.session) return false;
    this.running = true;
    this.frames = [];
    this.onState("live");
    this.schedule();
    return true;
  }

  stop() {
    this.session += 1;
    this.running = false;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.lastTime = -1;
    const ctx = this.overlay.getContext("2d");
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
  }

  get aspect() {
    return this.video.videoWidth / this.video.videoHeight || 4 / 3;
  }

  schedule() {
    if (!this.running) return;
    if (this.video.requestVideoFrameCallback) this.video.requestVideoFrameCallback(() => this.tick());
    else requestAnimationFrame(() => this.tick());
  }

  tick() {
    if (!this.running) return;
    const { video } = this;
    if (video.readyState >= 2 && video.currentTime !== this.lastTime) {
      this.lastTime = video.currentTime;
      const now = Math.max(performance.now(), this.lastStamp + 1);  // timestamps must increase
      this.lastStamp = now;
      let hand = null;
      try {
        hand = this.landmarker.detectForVideo(video, now).landmarks[0] ?? null;
      } catch {
        this.stop();
        this.onState("failed");
        return;
      }
      this.measure(now);
      this.draw(hand);
      this.onFrame(hand, now);
    }
    this.schedule();
  }

  measure(now) {
    this.frames.push(now);
    while (this.frames.length && now - this.frames[0] > 1000) this.frames.shift();
    this.fps = this.frames.length;
  }

  // The camera plate shows the reach (the part of the frame mapped onto the page) as
  // crop marks, and the tracked hand as a hairline skeleton.
  draw(hand) {
    const canvas = this.overlay;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const [l, r, t, b] = [REACH.left * w, REACH.right * w, REACH.top * h, REACH.bottom * h];
    const arm = Math.min(18, w * 0.05);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (const [x, y, dx, dy] of [[l, t, 1, 1], [r, t, -1, 1], [l, b, 1, -1], [r, b, -1, -1]]) {
      ctx.moveTo(x + dx * arm, y);
      ctx.lineTo(x, y);
      ctx.lineTo(x, y + dy * arm);
    }
    ctx.stroke();

    if (!hand) return;
    const at = (i) => [(1 - hand[i].x) * w, hand[i].y * h];  // the video is mirrored
    ctx.strokeStyle = "#009fe3";
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (const [a, c] of BONES) {
      ctx.moveTo(...at(a));
      ctx.lineTo(...at(c));
    }
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    for (let i = 0; i < hand.length; i++) {
      const [x, y] = at(i);
      ctx.beginPath();
      ctx.arc(x, y, i === 8 ? 4.5 : 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
