// HoloPaint demo: photo -> presigned S3 upload -> poll the job -> colouring page,
// then paint it by hand: hand tracking in the browser drives a brush and a fill.
import { Painter, PAPER } from "./paint.js";
import { HandCamera, CameraError } from "./hand.js";
import { Gesture, GestureFilter, OneEuro, classify, toPoints, toRect } from "./gestures.js";

const API = (window.HOLOPAINT_API || "").replace(/\/+$/, "");
const MAX_SIDE = 1600;                  // the worker caps at this too
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_INPUT_BYTES = 40 * 1024 * 1024;
const MIN_SIDE = 32;
const POLL_MS = 900;
const TIMEOUT_MS = 150_000;
const COLD_NOTE_MS = 8_000;

const STEPS = ["upload", "queue", "trace", "ready"];
const STEP_TEXT = { upload: "Uploading", queue: "In the queue", trace: "Tracing", ready: "Ready" };

const INKS = [
  ["Black", "#141414"], ["Vermilion", "#e8442e"], ["Orange", "#f5921e"], ["Yellow", "#ffd23f"],
  ["Leaf", "#8cc63f"], ["Green", "#1e9e58"], ["Sky", "#4cb3ea"], ["Blue", "#2f5fd0"],
  ["Violet", "#7d4fc4"], ["Rose", "#f283b6"], ["Peach", "#f8c9a0"], ["Umber", "#8a5634"],
];
const SIZES = [["Small brush", 5, 5], ["Medium brush", 12, 10], ["Large brush", 26, 16]];  // brush and dot, px
const TAP_SLOP = 6;           // px a press may wander and still count as a tap (fill)
const PINCH_LOOKBACK = 120;   // ms; closing a pinch drags the fingertip, so fill where it pointed just before
const LOST_HAND_TIP = 1000;   // ms without a hand before suggesting one

const CAMERA_TEXT = {
  starting: "Starting camera",
  loading: "Loading hand tracking",
  off: "Camera off",
  blocked: "Camera access is blocked. Allow it in the address bar, or paint with a mouse or finger.",
  missing: "No camera found. You can still paint with a mouse or finger.",
  unsupported: "This browser can't open the camera here. You can still paint with a mouse or finger.",
  failed: "Hand tracking didn't start. Check your connection and try again.",
};

const $ = (id) => document.getElementById(id);
const sheet = $("sheet");
const fileInput = $("file");
const chooseBtn = $("choose");
const photoPlate = $("photo-plate");
const dropzone = $("dropzone");
const intake = $("intake");
const photoMedia = $("photo-media");
const outlineMedia = $("outline-media");
const progress = $("progress");
const stepText = $("progress-step");
const clock = $("clock");
const coldNote = $("progress-note");
const slip = $("slip");
const slipText = $("slip-text");
const actions = $("actions");
const newPhotoBtn = $("new-photo");
const downloadBtn = $("download");
const paintBtn = $("paint");
const doneBtn = $("done");
const slugJob = $("slug-job");
const slugLive = $("slug-live");
const status = $("status");
const patches = [...document.querySelectorAll(".patch")];
const plates = document.querySelector(".plates");

const cameraPlate = $("camera-plate");
const cameraField = $("camera-field");
const cameraVideo = $("camera-video");
const cameraState = $("camera-state");
const cameraText = $("camera-text");
const cameraOn = $("camera-on");
const cameraOff = $("camera-off");
const cameraTip = $("camera-tip");
const keyRows = [...document.querySelectorAll(".key-row")];
const tray = $("tray");
const undoBtn = $("undo");
const redoBtn = $("redo");
const cursor = $("hand-cursor");

class UserError extends Error {}

let run = 0;            // bumped on every reset; stale async work checks it and stops
let stage = "idle";
let clockTimer = null;
let startedAt = 0;
let objectUrls = [];
let result = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const busy = () => ["upload", "queue", "trace"].includes(stage);
const seconds = (ms) => (ms / 1000).toFixed(1);

function announce(text) {
  status.textContent = "";
  requestAnimationFrame(() => { status.textContent = text; });
}

function setStage(next) {
  stage = next;
  sheet.dataset.stage = next;
  const at = STEPS.indexOf(next);
  patches.forEach((patch, i) => {
    patch.classList.remove("is-void");
    patch.classList.toggle("is-done", at >= 0 && (i < at || next === "ready"));
    patch.classList.toggle("is-current", i === at && next !== "ready");
  });
  if (STEP_TEXT[next] && next !== "ready") {
    stepText.textContent = STEP_TEXT[next];
    announce(STEP_TEXT[next]);
  }
}

function startClock() {
  startedAt = performance.now();
  clock.textContent = "0.0";
  coldNote.hidden = true;
  clockTimer = setInterval(() => {
    const elapsed = performance.now() - startedAt;
    clock.textContent = seconds(elapsed);
    if (elapsed > COLD_NOTE_MS && busy()) coldNote.hidden = false;
  }, 100);
}

function stopClock() {
  clearInterval(clockTimer);
  clockTimer = null;
  return performance.now() - startedAt;
}

function track(url) {
  objectUrls.push(url);
  return url;
}

function showImage(container, src, alt) {
  const img = new Image();
  img.alt = alt;
  img.decoding = "async";
  img.src = src;
  container.replaceChildren(img);
  return img;
}

function spans(container, texts) {
  container.replaceChildren(...texts.flatMap((text, i) => [
    i ? " " : "", Object.assign(document.createElement("span"), { textContent: text }),
  ]));
}

// Decode, apply EXIF orientation, flatten onto white, cap the longer side, re-encode as JPEG.
async function prepare(file) {
  const isImage = file.type.startsWith("image/") || /\.(heic|heif)$/i.test(file.name);
  if (!isImage) throw new UserError("That file isn't a photo. Try a JPEG, PNG or WebP.");
  if (file.size > MAX_INPUT_BYTES) throw new UserError("That photo is over 40 MB. Try a smaller one.");

  const source = URL.createObjectURL(file);
  const img = new Image();
  img.src = source;
  try {
    await img.decode();
  } catch {
    throw new UserError("This browser can't open that file. Try a JPEG or PNG.");
  } finally {
    URL.revokeObjectURL(source);
  }

  const { naturalWidth: w0, naturalHeight: h0 } = img;
  if (Math.min(w0, h0) < MIN_SIDE) {
    throw new UserError(`That photo is too small. Use one at least ${MIN_SIDE} pixels on each side.`);
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(w0, h0));
  const width = Math.round(w0 * scale);
  const height = Math.round(h0 * scale);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);

  const encode = (quality) => new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  let blob = await encode(0.9);
  if (blob && blob.size > MAX_UPLOAD_BYTES) blob = await encode(0.78);
  if (!blob) throw new UserError("This browser can't open that file. Try a JPEG or PNG.");
  return { blob, width, height };
}

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(`${API}${path}`, options);
  } catch {
    throw new UserError("Can't reach the server. Check your connection and try again.");
  }
  if (response.status === 429) throw new UserError("Too many requests right now. Wait a few seconds and try again.");
  if (!response.ok) throw new UserError("The server couldn't take that request. Try again.");
  return response.json();
}

async function upload(target, blob) {
  // S3 presigned POST: policy fields first, then Content-Type, then the file last.
  const form = new FormData();
  for (const [key, value] of Object.entries(target.fields)) form.append(key, value);
  form.append("Content-Type", "image/jpeg");
  form.append("file", blob, "photo.jpg");
  let response;
  try {
    response = await fetch(target.url, { method: "POST", body: form });
  } catch {
    throw new UserError("The upload didn't go through. Check your connection and try again.");
  }
  if (!response.ok) throw new UserError("The upload didn't go through. Try again.");
}

async function poll(jobId, token) {
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    await sleep(POLL_MS);
    if (token !== run) return null;
    let job;
    try {
      job = await api(`/jobs/${jobId}`);
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await sleep(POLL_MS * 2);   // a dropped poll is not a failed job
      continue;
    }
    if (job.status === "PROCESSING" && stage === "queue") setStage("trace");
    if (job.status === "DONE" || job.status === "FAILED") return job;
    if (Date.now() > deadline) throw new UserError("This is taking longer than expected. Try again in a minute.");
  }
}

// Painting reads the outline's pixels back, which needs CORS. On an origin the bucket
// doesn't allow, the page still shows; it just can't be painted.
async function loadOutline(url) {
  const alt = "Colouring page traced from your photo";
  const img = Object.assign(new Image(), { alt, decoding: "async", crossOrigin: "anonymous" });
  img.src = url;
  try {
    await img.decode();
    return { img, paintable: true };
  } catch {
    const plain = Object.assign(new Image(), { alt, decoding: "async" });
    plain.src = url;
    await plain.decode().catch(() => {});
    return { img: plain, paintable: false };
  }
}

function workerMessage(error = "") {
  if (/too small/i.test(error)) return `That photo is too small. Use one at least ${MIN_SIDE} pixels on each side.`;
  if (/format|not a supported|corrupt/i.test(error)) return "That file isn't a photo we can read. Try a JPEG, PNG or WebP.";
  return "Something went wrong while tracing. Try another photo.";
}

function fail(message, token) {
  if (token !== run) return;
  stopClock();
  const failed = patches.find((patch) => patch.classList.contains("is-current"));
  patches.forEach((patch) => patch.classList.remove("is-current"));
  if (failed) failed.classList.add("is-void");
  stage = "failed";
  sheet.dataset.stage = "failed";
  progress.hidden = true;
  slipText.textContent = message;
  slip.hidden = false;
  if (!photoMedia.hasChildNodes()) intake.hidden = false;
  announce(message);
}

async function start(file) {
  if (!file || busy()) return;
  reset({ focus: false });
  const token = run;

  let blob;
  try {
    let width, height;
    ({ blob, width, height } = await prepare(file));
    plates.style.setProperty("--ar", `${width} / ${height}`);  // both plates hug the photo
    plates.style.setProperty("--arn", width / height);
  } catch (error) {
    return fail(error instanceof UserError ? error.message : "That photo couldn't be prepared. Try another.", token);
  }
  if (token !== run) return;

  intake.hidden = true;
  showImage(photoMedia, track(URL.createObjectURL(blob)), "Your photo");
  progress.hidden = false;
  startClock();
  setStage("upload");

  try {
    const job = await api("/jobs", { method: "POST" });
    if (token !== run) return;
    await upload(job.upload, blob);
    if (token !== run) return;
    setStage("queue");

    const done = await poll(job.job_id, token);
    if (!done) return;
    if (done.status === "FAILED") return fail(workerMessage(done.error), token);

    const { img, paintable } = await loadOutline(done.result_url);
    if (token !== run) return;
    const page = Object.assign(document.createElement("div"), { className: "page" });
    page.append(paintCanvas, img);
    outlineMedia.replaceChildren(page);
    let canPaint = paintable;
    try {
      if (canPaint) painter.load(img);
    } catch {
      canPaint = false;
    }
    const total = stopClock();
    img.classList.add("registering");
    setStage("ready");
    progress.hidden = true;
    actions.hidden = false;
    paintBtn.hidden = !canPaint;
    result = { jobId: job.job_id, url: done.result_url };
    spans(slugJob, [
      `Job ${job.job_id.slice(0, 8)}`,
      `${done.width}×${done.height}`,
      `Traced in ${seconds(done.duration_ms)} s`,
      `Total ${seconds(total)} s`,
    ]);
    announce("Your colouring page is ready.");
    (canPaint ? paintBtn : downloadBtn).focus({ preventScroll: true });
  } catch (error) {
    fail(error instanceof UserError ? error.message : "Something went wrong. Try again.", token);
  }
}

function save(blob, name) {
  const href = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement("a"), { href, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

async function download() {
  if (!result) return;
  downloadBtn.disabled = true;
  const name = `holopaint-${result.jobId.slice(0, 8)}`;
  try {
    if (painter.painted) {
      const blob = await painter.toBlob();
      if (!blob) throw new Error("export failed");
      save(blob, `${name}-painted.png`);
      return;
    }
    let response = await fetch(result.url).catch(() => null);
    if (!response || !response.ok) {
      // The signed link lasts 15 minutes; ask for a fresh one.
      const job = await api(`/jobs/${result.jobId}`);
      if (!job.result_url) throw new UserError("This colouring page has expired. Make a new one.");
      result.url = job.result_url;
      response = await fetch(result.url);
    }
    save(await response.blob(), `${name}.png`);
  } catch (error) {
    announce(error instanceof UserError ? error.message : "The download didn't start. Try again.");
  } finally {
    downloadBtn.disabled = false;
  }
}

function reset({ focus = true } = {}) {
  run += 1;
  exitPaint({ focus: false });
  if (clockTimer) stopClock();
  objectUrls.forEach((url) => URL.revokeObjectURL(url));
  objectUrls = [];
  result = null;
  painter.clear();
  photoMedia.replaceChildren();
  outlineMedia.replaceChildren();
  plates.style.removeProperty("--ar");
  plates.style.removeProperty("--arn");
  intake.hidden = false;
  progress.hidden = true;
  coldNote.hidden = true;
  slip.hidden = true;
  actions.hidden = true;
  paintBtn.hidden = true;
  slugJob.replaceChildren();
  clock.textContent = "0.0";
  fileInput.value = "";
  setStage("idle");
  if (focus) chooseBtn.focus({ preventScroll: true });
}

// Painting

const paintCanvas = Object.assign(document.createElement("canvas"), { className: "page-paint" });
const painter = new Painter(paintCanvas, {
  onChange: () => {
    undoBtn.disabled = !painter.canUndo;
    redoBtn.disabled = !painter.canRedo;
  },
});

let painting = false;

function chip(label, className, data, style = {}) {
  const button = Object.assign(document.createElement("button"), {
    type: "button", className: `chip ${className}`.trim(), title: label,
  });
  button.setAttribute("aria-label", label);
  button.setAttribute("aria-pressed", "false");
  Object.assign(button.dataset, data);
  for (const [name, value] of Object.entries(style)) button.style.setProperty(name, value);
  return button;
}

$("inks").append(
  ...INKS.map(([name, hex]) => chip(name, "", { ink: hex }, { "--chip": hex })),
  chip("Eraser", "chip-paper", { ink: PAPER }),
);
$("sizes").append(...SIZES.map(([label, size, dot]) => chip(label, "chip-size", { size }, { "--dot": `${dot}px` })));

function press(selector, match) {
  tray.querySelectorAll(selector).forEach((b) => b.setAttribute("aria-pressed", String(match(b))));
}

function setInk(ink) {
  painter.endStroke();
  painter.ink = ink;
  press("[data-ink]", (b) => b.dataset.ink === ink);
  const paper = ink === PAPER;
  for (const el of [tray, cursor]) {
    el.style.setProperty("--tip", paper ? "var(--stock)" : ink);
    el.style.setProperty("--tip-edge", paper ? "0.5" : "0");
  }
}

function setSize(size) {
  painter.endStroke();
  painter.size = size;
  press("[data-size]", (b) => Number(b.dataset.size) === size);
  cursor.style.setProperty("--brush", `${size}px`);
}

setInk(INKS[1][1]);
setSize(SIZES[1][1]);

tray.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (button?.dataset.ink) setInk(button.dataset.ink);
  else if (button?.dataset.size) setSize(Number(button.dataset.size));
});
undoBtn.addEventListener("click", () => painter.undo());
redoBtn.addEventListener("click", () => painter.redo());

function enterPaint() {
  if (painting || !painter.ready) return;
  painting = true;
  sheet.dataset.mode = "paint";
  photoPlate.hidden = true;
  cameraPlate.hidden = false;
  tray.hidden = false;
  newPhotoBtn.hidden = true;
  paintBtn.hidden = true;
  doneBtn.hidden = false;
  announce("Painting. Point to brush, pinch to fill.");
  startCamera();
}

function exitPaint({ focus = true } = {}) {
  if (!painting) return;
  painting = false;
  stopCamera();
  delete sheet.dataset.mode;
  photoPlate.hidden = false;
  cameraPlate.hidden = true;
  tray.hidden = true;
  newPhotoBtn.hidden = false;
  paintBtn.hidden = false;
  doneBtn.hidden = true;
  if (focus) paintBtn.focus({ preventScroll: true });
}

// Mouse, touch and pen: a tap fills, a drag brushes.

let pointer = null;

paintCanvas.addEventListener("pointerdown", (event) => {
  if (!painting || event.button > 0) return;
  event.preventDefault();
  liftHand();
  paintCanvas.setPointerCapture(event.pointerId);
  pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, stroking: false };
});

paintCanvas.addEventListener("pointermove", (event) => {
  if (!pointer || event.pointerId !== pointer.id) return;
  if (!pointer.stroking) {
    if (Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) < TAP_SLOP) return;
    pointer.stroking = true;
    painter.beginStroke(painter.toLayer(pointer.x, pointer.y, { clamp: true }));
  }
  // Coalesced events keep fast strokes smooth; some browsers return none for a move.
  const coalesced = event.getCoalescedEvents?.() ?? [];
  for (const e of coalesced.length ? coalesced : [event]) {
    painter.extendStroke(painter.toLayer(e.clientX, e.clientY, { clamp: true }));
  }
});

paintCanvas.addEventListener("pointerup", (event) => {
  if (!pointer || event.pointerId !== pointer.id) return;
  if (pointer.stroking) painter.endStroke();
  else painter.fillAt(painter.toLayer(pointer.x, pointer.y, { clamp: true }));
  pointer = null;
});

paintCanvas.addEventListener("pointercancel", () => {
  if (pointer?.stroking) painter.endStroke();
  pointer = null;
});

// Hands: the camera frame maps onto the tray and the page together, so a pinch
// picks an ink as well as fills.

const filter = new GestureFilter();
const smoothX = new OneEuro({ minCutoff: 1.2, beta: 0.012 });
const smoothY = new OneEuro({ minCutoff: 1.2, beta: 0.012 });
let trail = [];
let handStroke = null;  // the stroke the hand is drawing; only the hand may end it
let aimed = null;
let lastSeen = 0;
let liveTimer = null;

const camera = new HandCamera({
  video: cameraVideo,
  overlay: $("camera-overlay"),
  onFrame: (hand, now) => (hand ? onHand(hand, now) : onNoHand(now)),
  onState: showCamera,
});

function showCamera(state) {
  const live = state === "live";
  const waiting = state === "starting" || state === "loading";
  cameraField.classList.toggle("is-live", live);
  cameraState.hidden = live;
  cameraState.classList.toggle("is-waiting", waiting);
  cameraState.classList.toggle("is-problem", !live && !waiting && state !== "off");
  cameraText.textContent = CAMERA_TEXT[state] ?? "";
  cameraOn.hidden = !["off", "blocked", "failed"].includes(state);
  cameraOn.textContent = state === "off" ? "Turn on camera" : "Try again";
  cameraOff.hidden = !live;
  cameraTip.hidden = true;
  clearInterval(liveTimer);
  if (live) {
    const { videoWidth: w, videoHeight: h } = cameraVideo;
    if (w && h) cameraField.style.setProperty("--cam-ar", `${w} / ${h}`);
    lastSeen = performance.now();
    liveTimer = setInterval(() => spans(slugLive, ["Hand tracking on device", camera.delegate, `${camera.fps} fps`]), 500);
  } else {
    slugLive.replaceChildren();
    onNoHand(0);
  }
  if (!waiting) announce(live ? "Camera on. Raise one hand." : CAMERA_TEXT[state]);
}

async function startCamera() {
  try {
    await camera.start();
  } catch (error) {
    if (painting) showCamera(error instanceof CameraError ? error.kind : "failed");
  }
}

function stopCamera() {
  camera.stop();
  showCamera("off");
}

// The tray and the page together, in viewport pixels.
function reach() {
  const a = tray.getBoundingClientRect();
  const b = paintCanvas.getBoundingClientRect();
  const left = Math.min(a.left, b.left);
  return { left, top: a.top, width: Math.max(a.right, b.right) - left, height: b.bottom - a.top };
}

function onHand(hand, now) {
  lastSeen = now;
  cameraTip.hidden = true;
  const raw = classify(toPoints(hand, camera.aspect), filter.current === Gesture.SELECT);
  const { gesture, entered } = filter.update(raw, now);

  const target = toRect(1 - hand[8].x, hand[8].y, reach());  // index fingertip, mirrored
  const x = smoothX.filter(target.x, now / 1000);
  const y = smoothY.filter(target.y, now / 1000);
  trail.push({ t: now, x, y });
  while (trail.length && now - trail[0].t > 400) trail.shift();

  cursor.hidden = false;
  cursor.dataset.gesture = gesture;
  cursor.style.transform = `translate(${x}px, ${y}px)`;
  aim(document.elementFromPoint(x, y)?.closest(".tray button") ?? null);
  keyRows.forEach((row) => row.classList.toggle("is-active", row.dataset.gesture === gesture));

  // A press on the page (mouse, finger or pen) has the brush until it lifts.
  if (pointer) return liftHand();
  if (gesture === Gesture.DRAW) {
    const point = painter.toLayer(x, y);
    if (!point) {
      liftHand();
    } else if (handStroke && painter.stroke === handStroke) {
      painter.extendStroke(point);
    } else {
      painter.beginStroke(point);
      handStroke = painter.stroke;
    }
    return;
  }
  liftHand();  // any other gesture lifts the brush
  if (!entered) return;
  if (gesture === Gesture.SELECT) {
    const at = trail.findLast((p) => p.t <= now - PINCH_LOOKBACK) ?? { x, y };
    tap(at.x, at.y);
  } else if (gesture === Gesture.UNDO) {
    painter.undo();
  } else if (gesture === Gesture.REDO) {
    painter.redo();
  }
}

function liftHand() {
  if (handStroke && painter.stroke === handStroke) painter.endStroke();
  handStroke = null;
}

function onNoHand(now) {
  if (!cursor.hidden) {
    liftHand();
    filter.reset();
    smoothX.reset();
    smoothY.reset();
    trail = [];
    cursor.hidden = true;
    aim(null);
    keyRows.forEach((row) => row.classList.remove("is-active"));
  }
  if (camera.running && now - lastSeen > LOST_HAND_TIP) cameraTip.hidden = false;
}

function aim(button) {
  if (button === aimed) return;
  aimed?.classList.remove("is-aimed");
  button?.classList.add("is-aimed");
  aimed = button;
}

function tap(x, y) {
  const control = document.elementFromPoint(x, y)?.closest(".tray button");
  if (control) {
    if (!control.disabled) control.click();
    return;
  }
  const point = painter.toLayer(x, y);
  if (point) painter.fillAt(point);
}

// Wiring

chooseBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => start(fileInput.files[0]));
downloadBtn.addEventListener("click", download);
paintBtn.addEventListener("click", enterPaint);
doneBtn.addEventListener("click", () => exitPaint());
cameraOn.addEventListener("click", startCamera);
cameraOff.addEventListener("click", stopCamera);
document.querySelectorAll('[data-action="reset"]').forEach((btn) => btn.addEventListener("click", () => reset()));

document.addEventListener("keydown", (event) => {
  if (!painting) return;
  const key = event.key.toLowerCase();
  if ((event.metaKey || event.ctrlKey) && (key === "z" || key === "y")) {
    event.preventDefault();
    if (key === "y" || event.shiftKey) painter.redo();
    else painter.undo();
  } else if (key === "escape") {
    exitPaint();
  }
});
window.addEventListener("pagehide", () => camera.stop());

let dragDepth = 0;
dropzone.addEventListener("dragenter", (event) => {
  if (busy()) return;
  event.preventDefault();
  dragDepth += 1;
  photoPlate.classList.add("is-over");
});
dropzone.addEventListener("dragover", (event) => {
  if (!busy()) event.preventDefault();
});
dropzone.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) photoPlate.classList.remove("is-over");
});
dropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  dragDepth = 0;
  photoPlate.classList.remove("is-over");
  start(event.dataTransfer.files[0]);
});
// A photo dropped beside the plate shouldn't navigate away from the page.
window.addEventListener("dragover", (event) => event.preventDefault());
window.addEventListener("drop", (event) => event.preventDefault());

document.addEventListener("paste", (event) => {
  const item = [...(event.clipboardData?.items || [])].find((entry) => entry.type.startsWith("image/"));
  if (item) start(item.getAsFile());
});

if (!API) {
  chooseBtn.disabled = true;
  slipText.textContent = "This page isn't connected to the API. Set window.HOLOPAINT_API in config.js.";
  slip.querySelector("button").hidden = true;
  slip.hidden = false;
}
