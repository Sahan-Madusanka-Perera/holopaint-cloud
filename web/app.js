// HoloPaint demo: photo -> presigned S3 upload -> poll the job -> colouring page,
// then paint it by hand: hand tracking in the browser drives HoloDraw's tools.
import { Painter, isShape } from "./paint.js";
import { HandCamera, CameraError } from "./hand.js";
import { Gesture, GestureFilter, OneEuro, classify, palmSize, pushZoom, toPoints, toRect } from "./gestures.js";
import { View } from "./view.js";

const API = (window.HOLOPAINT_API || "").replace(/\/+$/, "");
const MAX_SIDE = 1600;                  // the worker caps at this too
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_INPUT_BYTES = 40 * 1024 * 1024;
const MIN_SIDE = 32;
const POLL_MS = 900;
const TIMEOUT_MS = 150_000;
const COLD_NOTE_MS = 8_000;
const PICSUM = "https://picsum.photos";  // Lorem Picsum, as in HoloDraw's image_fetcher.py
const BLANK = { width: 1600, height: 1200 };

const STEPS = ["upload", "queue", "trace", "ready"];
const STEP_TEXT = { upload: "Uploading", queue: "In the queue", trace: "Tracing", ready: "Ready" };

// HoloDraw's twenty colours, in its order: two rows of ten.
const INKS = [
  ["Black", "#141414"], ["Graphite", "#4b4b4e"], ["Grey", "#8e8e92"], ["Silver", "#c9c9cc"], ["White", "#ffffff"],
  ["Vermilion", "#e8442e"], ["Crimson", "#9b1c24"], ["Orange", "#f5921e"], ["Yellow", "#ffd23f"], ["Leaf", "#8cc63f"],
  ["Green", "#1e9e58"], ["Forest", "#135c35"], ["Sky", "#4cb3ea"], ["Teal", "#11807c"], ["Blue", "#2f5fd0"],
  ["Navy", "#1b2a6b"], ["Violet", "#7d4fc4"], ["Fuchsia", "#d43f9c"], ["Rose", "#f283b6"], ["Umber", "#8a5634"],
];
const SIZES = [["Small brush", 5, 5], ["Medium brush", 12, 10], ["Large brush", 26, 16]];  // brush and dot, px
const TAP_SLOP = 6;           // px a press may wander and still count as a tap (fill)
const PINCH_GRACE = 250;      // ms; a stroke this young when a second finger lands was the start of a pinch
const PINCH_LOOKBACK = 120;   // ms; closing a pinch drags the fingertip, so fill where it pointed just before
const LOST_HAND_TIP = 1000;   // ms without a hand before suggesting one
const ZOOM_STEP = 1.25;       // per key press
const PAN_STEP = 0.1;         // of the frame, per arrow key press

const CAMERA_TEXT = {
  starting: "Starting camera",
  loading: "Loading hand tracking",
  off: "Camera off",
  blocked: "Camera access is blocked. Allow it in the address bar, or paint with a mouse or finger.",
  missing: "No camera found. You can still paint with a mouse or finger.",
  unsupported: "This browser can't open the camera here. You can still paint with a mouse or finger.",
  failed: "Hand tracking didn't start. Check your connection and try again.",
};

// What pointing, pinching and two fingers do with each tool.
const KEY_TEXT = {
  draw: { brush: "Brush", eraser: "Erase", fill: "Aim", shape: "Draw the shape" },
  select: { eraser: "Erase an area, or pick from the tray", other: "Fill, or pick from the tray" },
  navigate: { shape: "Place the shape", other: "Move" },
};

const $ = (id) => document.getElementById(id);
const sheet = $("sheet");
const fileInput = $("file");
const chooseBtn = $("choose");
const randomBtn = $("random");
const blankBtn = $("blank");
const photoPlate = $("photo-plate");
const credit = $("credit");
const dropzone = $("dropzone");
const intake = $("intake");
const photoMedia = $("photo-media");
const outlineLabel = $("outline-label");
const outlineMedia = $("outline-media");
const detailEl = $("detail");
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
const filledBtn = $("filled");
const undoBtn = $("undo");
const redoBtn = $("redo");
const clearBtn = $("clear");
const cursor = $("hand-cursor");

class UserError extends Error {}

let run = 0;            // bumped on every reset; stale async work checks it and stops
let stage = "idle";
let clockTimer = null;
let startedAt = 0;
let objectUrls = [];
let result = null;      // { jobId, name, url } for the page on screen
let details = null;     // { urls, level, loads } when the job traced several detail levels
let source = null;      // "photo" or "blank"

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const busy = () => ["upload", "queue", "trace"].includes(stage);
const seconds = (ms) => (ms / 1000).toFixed(1);
const el = (tag, className) => Object.assign(document.createElement(tag), { className });

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
  if (clockTimer) stopClock();
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

async function start(file, { photoCredit = null } = {}) {
  if (!file || busy()) return;
  reset({ focus: false });
  const token = run;
  source = "photo";

  let blob;
  try {
    let width, height;
    ({ blob, width, height } = await prepare(file));
    setAspect(width, height);
  } catch (error) {
    return fail(error instanceof UserError ? error.message : "That photo couldn't be prepared. Try another.", token);
  }
  if (token !== run) return;

  intake.hidden = true;
  showImage(photoMedia, track(URL.createObjectURL(blob)), "Your photo");
  showCredit(photoCredit);
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

    result = { jobId: job.job_id, name: `holopaint-${job.job_id.slice(0, 8)}`, url: done.result_url };
    details = done.detail_urls?.length ? { urls: done.detail_urls, level: done.detail ?? done.detail_urls.length - 1, loads: [] } : null;
    if (details) result.url = details.urls[details.level];
    const { img, paintable } = details ? await detailImage(details.level) : await loadOutline(result.url);
    if (token !== run) return;
    mountPage(img);
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
    showDetails();
    spans(slugJob, [
      `Job ${job.job_id.slice(0, 8)}`,
      `${done.width}×${done.height}`,
      `Traced in ${seconds(done.duration_ms)} s`,
      `Total ${seconds(total)} s`,
    ]);
    announce("Your colouring page is ready.");
    (canPaint ? paintBtn : downloadBtn).focus({ preventScroll: true });
    details?.urls.forEach((_, level) => detailImage(level));  // the rest arrive while the reader looks
  } catch (error) {
    fail(error instanceof UserError ? error.message : "Something went wrong. Try again.", token);
  }
}

function setAspect(width, height) {
  plates.style.setProperty("--ar", `${width} / ${height}`);  // both plates hug the photo
  plates.style.setProperty("--arn", width / height);
}

// HoloDraw's random image: a photo from Lorem Picsum, credited to its photographer.
async function randomPhoto() {
  if (busy()) return;
  const token = run;
  setIntakeBusy(true);
  try {
    const response = await fetch(`${PICSUM}/960/720`, { cache: "no-store" });
    if (!response.ok) throw new Error(`picsum ${response.status}`);
    const blob = await response.blob();
    const id = response.headers.get("Picsum-Id");
    const photoCredit = id ? await picsumCredit(id) : null;
    if (token !== run) return;
    setIntakeBusy(false);
    await start(new File([blob], `picsum-${id}.jpg`, { type: blob.type || "image/jpeg" }), { photoCredit });
  } catch {
    fail("Couldn't get a random photo. Check your connection and try again.", token);
  } finally {
    setIntakeBusy(false);
  }
}

async function picsumCredit(id) {
  try {
    const info = await (await fetch(`${PICSUM}/id/${encodeURIComponent(id)}/info`)).json();
    if (typeof info.author !== "string" || !String(info.url).startsWith("https://unsplash.com/")) return null;
    return { author: info.author, url: info.url };
  } catch {
    return null;
  }
}

function setIntakeBusy(on) {
  for (const button of [chooseBtn, randomBtn, blankBtn]) button.disabled = on || !API && button !== blankBtn;
  randomBtn.textContent = on ? "Finding a photo" : "Random photo";
}

function showCredit(photoCredit) {
  credit.hidden = !photoCredit;
  if (!photoCredit) return credit.removeAttribute("href");
  credit.textContent = `${photoCredit.author}, Unsplash`;
  credit.href = photoCredit.url;
}

// HoloDraw's drawing mode: a blank page, no photo and no job.
function startBlank() {
  if (busy()) return;
  reset({ focus: false });
  source = "blank";
  sheet.dataset.source = "blank";
  setAspect(BLANK.width, BLANK.height);
  intake.hidden = true;
  outlineLabel.textContent = "Blank page";
  painter.loadBlank(BLANK.width, BLANK.height);
  mountPage(null);
  setStage("blank");
  actions.hidden = false;
  result = { name: "holopaint-drawing" };
  spans(slugJob, ["Blank page", `${BLANK.width}×${BLANK.height}`]);
  enterPaint();
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
  if (!result || downloadBtn.disabled) return;
  downloadBtn.disabled = true;
  try {
    if (painter.painted || source === "blank") {
      const blob = await painter.toBlob();
      if (!blob) throw new Error("export failed");
      save(blob, source === "blank" ? `${result.name}.png` : `${result.name}-painted.png`);
      return;
    }
    let response = await fetch(result.url).catch(() => null);
    if (!response || !response.ok) {
      // The signed links last 15 minutes; ask for fresh ones.
      await refreshLinks();
      response = await fetch(result.url);
    }
    save(await response.blob(), `${result.name}.png`);
  } catch (error) {
    announce(error instanceof UserError ? error.message : "The download didn't start. Try again.");
  } finally {
    downloadBtn.disabled = false;
  }
}

async function refreshLinks() {
  const job = await api(`/jobs/${result.jobId}`);
  if (!job.result_url) throw new UserError("This colouring page has expired. Make a new one.");
  if (details && job.detail_urls) details.urls = job.detail_urls;
  result.url = details ? details.urls[details.level] : job.result_url;
}

function reset({ focus = true } = {}) {
  run += 1;
  exitPaint({ focus: false });
  if (clockTimer) stopClock();
  objectUrls.forEach((url) => URL.revokeObjectURL(url));
  objectUrls = [];
  result = null;
  details = null;
  source = null;
  delete sheet.dataset.source;
  painter.clear();
  outline?.remove();  // the page frame is reused, so take the old outline off it
  outline = null;
  photoMedia.replaceChildren();
  outlineMedia.replaceChildren();
  outlineLabel.textContent = "Colouring page";
  showCredit(null);
  detailEl.hidden = true;
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

// Detail: the worker traces the photo at several thresholds, least detail first, as
// HoloDraw's +/- threshold control would. Switching keeps the paint.

function detailImage(level) {
  const job = details;
  job.loads[level] ??= (async () => {
    let loaded = await loadOutline(job.urls[level]);
    if (!loaded.img.naturalWidth && job === details) {  // the signed link expired
      await refreshLinks().catch(() => {});
      loaded = await loadOutline(job.urls[level]);
    }
    if (!loaded.img.naturalWidth) job.loads[level] = undefined;  // try again next time
    return loaded;
  })();
  return job.loads[level];
}

function showDetails() {
  detailEl.querySelectorAll("button").forEach((b) => b.remove());
  detailEl.hidden = !details;
  if (!details) return;
  const n = details.urls.length;
  details.urls.forEach((_, level) => {
    const button = Object.assign(document.createElement("button"), { type: "button", className: "detail-step" });
    button.setAttribute("role", "radio");
    button.setAttribute("aria-label", `${level + 1} of ${n}`);
    button.title = level === 0 ? "Least detail ([)" : level === n - 1 ? "Most detail (])" : `Detail ${level + 1} of ${n}`;
    button.style.setProperty("--tint", `${Math.round(15 + (85 * level) / (n - 1))}%`);
    button.addEventListener("click", () => setDetail(level));
    detailEl.append(button);
  });
  pressDetail();
}

function pressDetail(focus = false) {
  detailEl.querySelectorAll("button").forEach((button, level) => {
    const on = level === details.level;
    button.setAttribute("aria-checked", String(on));
    button.tabIndex = on ? 0 : -1;
    if (on && focus) button.focus();
  });
}

async function setDetail(level, { focus = false } = {}) {
  if (!details || level < 0 || level >= details.urls.length || level === details.level) return;
  const token = run;
  const was = details.level;
  details.level = level;
  pressDetail(focus);
  const { img, paintable } = await detailImage(level);
  if (token !== run || details?.level !== level) return;
  if (!img.naturalWidth) {
    details.level = was;
    pressDetail(focus);
    return announce("That detail level didn't load. Try again.");
  }
  result.url = details.urls[level];
  outline?.replaceWith(img);
  outline = img;
  if (paintable && painter.ready) painter.setOutline(img);
  img.classList.remove("registering");
  void img.offsetWidth;  // restart the snap
  img.classList.add("registering");
  scheduleLoupe();
  announce(`Detail ${level + 1} of ${details.urls.length}`);
}

detailEl.addEventListener("keydown", (event) => {
  if (!details) return;
  const steps = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 };
  let level = null;
  if (event.key in steps) level = details.level + steps[event.key];
  else if (event.key === "Home") level = 0;
  else if (event.key === "End") level = details.urls.length - 1;
  if (level === null) return;
  event.preventDefault();
  setDetail(Math.max(0, Math.min(details.urls.length - 1, level)), { focus: true });
});

// The page: paint, the shape preview and the outline, in a frame that zooms and pans.

const paintCanvas = el("canvas", "page-paint");
const previewCanvas = el("canvas", "page-preview");
const pageSheet = el("div", "page-sheet");
const pageFrame = el("div", "page");
const loupe = el("div", "loupe");
loupe.hidden = true;
loupe.innerHTML = `<div class="loupe-map"><canvas></canvas><span class="loupe-window"></span></div>
  <p class="loupe-foot"><span class="loupe-zoom"></span><button class="text-btn" type="button">Fit</button></p>`;
const loupeMap = loupe.querySelector(".loupe-map");
const loupeCanvas = loupe.querySelector("canvas");
const loupeWindow = loupe.querySelector(".loupe-window");
const loupeZoom = loupe.querySelector(".loupe-zoom");
pageSheet.append(paintCanvas, previewCanvas);
pageFrame.append(pageSheet, loupe);
let outline = null;  // the outline image on the page

function mountPage(img) {
  pageSheet.querySelectorAll("img").forEach((node) => node.remove());  // one outline, ever
  outline = img;
  if (img) pageSheet.append(img);
  outlineMedia.replaceChildren(pageFrame);
  fit();
}

const painter = new Painter(paintCanvas, previewCanvas, {
  onChange: () => {
    undoBtn.disabled = !painter.canUndo;
    redoBtn.disabled = !painter.canRedo;
    clearBtn.disabled = !painter.canUndo;
    scheduleLoupe();
  },
});

let painting = false;
let previousTool = "brush";  // F toggles the fill tool on and back off, as HoloPaint's fill mode does

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

$("inks").append(...INKS.map(([name, hex]) => chip(name, "", { ink: hex }, { "--chip": hex })));
$("sizes").append(...SIZES.map(([label, size, dot], i) => {
  const button = chip(`${label} (${i + 1})`, "chip-size", { size }, { "--dot": `${dot}px` });
  button.setAttribute("aria-label", label);
  button.setAttribute("aria-keyshortcuts", String(i + 1));
  return button;
}));

function press(selector, match) {
  tray.querySelectorAll(selector).forEach((b) => b.setAttribute("aria-pressed", String(match(b))));
}

// The loaded ink, as the tray's size dots and the cursor's tip show it.
function showTip() {
  const paper = painter.erasing;
  const pale = !paper && luminance(painter.ink) > 0.9;
  for (const node of [tray, cursor]) {
    node.style.setProperty("--tip", paper ? "var(--stock)" : painter.ink);
    node.style.setProperty("--tip-edge", paper || pale ? "0.5" : "0");
  }
}

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}

function setInk(ink) {
  painter.endStroke();
  painter.ink = ink;
  press("[data-ink]", (b) => b.dataset.ink === ink);
  if (painter.shaping) painter.drawPreview();
  showTip();
}

function setSize(size) {
  painter.endStroke();
  painter.size = size;
  press("[data-size]", (b) => Number(b.dataset.size) === size);
  cursor.style.setProperty("--brush", `${size}px`);
}

function setTool(tool) {
  if (tool !== painter.tool) {
    liftHand();
    if (pointer?.mode) endPointer();
    if (tool === "fill") previousTool = painter.tool;
    painter.tool = tool;
  }
  press("[data-tool]", (b) => b.dataset.tool === tool);
  cursor.dataset.tool = tool;
  pageFrame.dataset.tool = tool;
  const kind = isShape(tool) ? "shape" : tool;
  $("key-draw").textContent = KEY_TEXT.draw[kind];
  $("key-select").textContent = KEY_TEXT.select[tool] ?? KEY_TEXT.select.other;
  $("key-navigate").textContent = KEY_TEXT.navigate[kind] ?? KEY_TEXT.navigate.other;
  showTip();
}

function setFilled(on) {
  painter.filled = on;
  filledBtn.setAttribute("aria-pressed", String(on));
  if (painter.shaping) painter.drawPreview();
}

setInk(INKS[5][1]);
setSize(SIZES[1][1]);
setTool("brush");

tray.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (button?.dataset.ink) setInk(button.dataset.ink);
  else if (button?.dataset.size) setSize(Number(button.dataset.size));
  else if (button?.dataset.tool) setTool(button.dataset.tool);
});
filledBtn.addEventListener("click", () => setFilled(!painter.filled));
undoBtn.addEventListener("click", () => painter.undo());
redoBtn.addEventListener("click", () => painter.redo());
clearBtn.addEventListener("click", clearPaint);

function clearPaint() {
  if (painter.clearAll()) announce("Paint cleared. Undo brings it back.");
}

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
  announce("Painting. Point to draw, pinch to fill.");
  // The hand reaches the tray and the page, so bring both into view if they aren't.
  requestAnimationFrame(() => {
    const r = reach();
    const below = r.top + r.height - window.innerHeight;
    if (below > 0) window.scrollBy({ top: Math.min(r.top - 12, below + 12), behavior: "instant" });
  });
  startCamera();
}

function exitPaint({ focus = true } = {}) {
  if (!painting) return;
  painting = false;
  endPointer();
  liftHand();
  stopCamera();
  fit();
  delete sheet.dataset.mode;
  photoPlate.hidden = false;
  cameraPlate.hidden = true;
  tray.hidden = true;
  newPhotoBtn.hidden = false;
  paintBtn.hidden = false;
  doneBtn.hidden = true;
  if (focus) paintBtn.focus({ preventScroll: true });
}

// Zoom and pan, up to 5x as in HoloDraw, with a loupe showing where the view is.

const view = new View();

function applyView() {
  pageSheet.style.transform = view.zoomed ? view.transform : "";
  pageFrame.classList.toggle("is-zoomed", view.zoomed);
  loupe.hidden = !view.zoomed;
  if (!view.zoomed) return;
  const w = view.window;
  Object.assign(loupeWindow.style, {
    left: `${w.left * 100}%`, top: `${w.top * 100}%`, width: `${w.width * 100}%`, height: `${w.height * 100}%`,
  });
  loupeZoom.textContent = `${Math.round(view.zoom * 100)}%`;
  scheduleLoupe();
}

function frameRect() {
  return pageFrame.getBoundingClientRect();
}

function inFrame(x, y) {
  const r = frameRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

function zoomBy(factor, clientX, clientY) {
  if (!painting) return;
  const r = frameRect();
  view.zoomAt(view.zoom * factor, clientX === undefined ? r.width / 2 : clientX - r.left, clientY === undefined ? r.height / 2 : clientY - r.top);
  applyView();
}

function panBy(dx, dy) {
  view.panBy(dx, dy);
  applyView();
}

function fit() {
  view.reset();
  applyView();
}

new ResizeObserver(() => {
  view.resize(pageFrame.clientWidth, pageFrame.clientHeight);
  applyView();
}).observe(pageFrame);

let loupeQueued = false;

function scheduleLoupe() {
  if (!view.zoomed || loupeQueued) return;
  loupeQueued = true;
  requestAnimationFrame(drawLoupe);
}

function drawLoupe() {
  loupeQueued = false;
  if (!view.zoomed || !paintCanvas.width) return;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(loupeCanvas.clientWidth * dpr), h = Math.round(loupeCanvas.clientHeight * dpr);
  if (!w || !h) return;
  if (loupeCanvas.width !== w || loupeCanvas.height !== h) Object.assign(loupeCanvas, { width: w, height: h });
  const ctx = loupeCanvas.getContext("2d");
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(paintCanvas, 0, 0, w, h);
  if (outline?.naturalWidth) {
    ctx.globalCompositeOperation = "multiply";
    ctx.drawImage(outline, 0, 0, w, h);
  }
}

// Press or drag on the loupe to move the view there.
let loupeDrag = null;
loupeMap.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  loupeMap.setPointerCapture(event.pointerId);
  loupeDrag = event.pointerId;
  lookAt(event);
});
loupeMap.addEventListener("pointermove", (event) => {
  if (event.pointerId === loupeDrag) lookAt(event);
});
loupeMap.addEventListener("pointerup", () => { loupeDrag = null; });
loupeMap.addEventListener("pointercancel", () => { loupeDrag = null; });
loupe.querySelector("button").addEventListener("click", fit);

function lookAt(event) {
  const r = loupeMap.getBoundingClientRect();
  const u = (event.clientX - r.left) / r.width, v = (event.clientY - r.top) / r.height;
  view.pin({ x: u * view.width, y: v * view.height }, view.width / 2, view.height / 2);
  applyView();
}

// Trackpad pinch (and Ctrl or Cmd with the wheel) zooms; the wheel pans once zoomed in.
pageFrame.addEventListener("wheel", (event) => {
  if (!painting) return;
  if (event.ctrlKey || event.metaKey) {
    event.preventDefault();
    const delta = Math.max(-60, Math.min(60, event.deltaY * (event.deltaMode === 1 ? 16 : 1)));
    zoomBy(Math.exp(-delta * 0.01), event.clientX, event.clientY);
  } else if (view.zoomed) {
    event.preventDefault();
    panBy(-event.deltaX, -event.deltaY);
  }
}, { passive: false });

// Safari reports trackpad pinches as gesture events instead.
let gestureStart = 1;
pageFrame.addEventListener("gesturestart", (event) => {
  if (!painting) return;
  event.preventDefault();
  gestureStart = view.zoom;
});
pageFrame.addEventListener("gesturechange", (event) => {
  if (!painting) return;
  event.preventDefault();
  const r = frameRect();
  view.zoomAt(gestureStart * event.scale, event.clientX - r.left, event.clientY - r.top);
  applyView();
});

// Mouse, touch and pen: a tap fills; a drag brushes, erases or draws the shape, and
// pans with the fill tool or the middle button; two fingers pinch to zoom and pan.

const pointers = new Map();
let pointer = null;  // the one-pointer action: { id, x, y, t, mode: null | "stroke" | "shape" | "pan" }
let pinch = null;

paintCanvas.addEventListener("pointerdown", (event) => {
  if (!painting || event.button > 1) return;
  event.preventDefault();
  paintCanvas.setPointerCapture(event.pointerId);
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  liftHand();
  if (pointers.size === 2) return startPinch(event.timeStamp);
  if (pointers.size > 2 || pinch) return;
  pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, t: event.timeStamp, mode: event.button === 1 ? "pan" : null };
});

paintCanvas.addEventListener("mousedown", (event) => {
  if (event.button === 1) event.preventDefault();  // pan, not the browser's autoscroll
});

paintCanvas.addEventListener("pointermove", (event) => {
  if (!pointers.has(event.pointerId)) return;
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (pinch) return movePinch();
  if (!pointer || event.pointerId !== pointer.id) return;
  if (!pointer.mode) {
    if (Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) < TAP_SLOP) return;
    const at = painter.toLayer(pointer.x, pointer.y, { clamp: true });
    if (isShape(painter.tool)) {
      pointer.mode = "shape";
      painter.beginShape(at);
    } else if (painter.tool === "fill") {
      pointer.mode = "pan";
    } else {
      pointer.mode = "stroke";
      painter.beginStroke(at);
    }
  }
  if (pointer.mode === "pan") {
    panBy(event.clientX - pointer.x, event.clientY - pointer.y);
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    pageFrame.classList.add("is-panning");
  } else if (pointer.mode === "shape") {
    painter.extendShape(painter.toLayer(event.clientX, event.clientY, { clamp: true }));
  } else {
    // Coalesced events keep fast strokes smooth; some browsers return none for a move.
    const coalesced = event.getCoalescedEvents?.() ?? [];
    for (const e of coalesced.length ? coalesced : [event]) {
      painter.extendStroke(painter.toLayer(e.clientX, e.clientY, { clamp: true }));
    }
    scheduleLoupe();
  }
});

paintCanvas.addEventListener("pointerup", (event) => {
  if (!pointers.delete(event.pointerId)) return;
  if (pinch) {
    if (pointers.size < 2) pinch = null;  // the other finger rests until it lifts
    return;
  }
  if (!pointer || event.pointerId !== pointer.id) return;
  if (!pointer.mode) painter.fillAt(painter.toLayer(pointer.x, pointer.y, { clamp: true }));
  endPointer();
});

paintCanvas.addEventListener("pointercancel", (event) => {
  pointers.delete(event.pointerId);
  if (pointers.size < 2) pinch = null;
  if (pointer?.mode === "shape") painter.cancelShape();
  if (pointer?.id === event.pointerId) endPointer();
});

function endPointer() {
  if (pointer?.mode === "stroke") painter.endStroke();
  else if (pointer?.mode === "shape") painter.commitShape();
  pageFrame.classList.remove("is-panning");
  pointer = null;
}

function startPinch(now) {
  if (pointer?.mode === "stroke" && now - pointer.t < PINCH_GRACE) painter.cancelStroke();
  else if (pointer?.mode === "shape") painter.cancelShape();
  endPointer();
  const [a, b] = [...pointers.values()];
  const r = frameRect();
  pinch = {
    page: view.toPage((a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top),
    distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
    zoom: view.zoom,
  };
}

function movePinch() {
  const [a, b] = [...pointers.values()];
  const r = frameRect();
  const zoom = pinch.zoom * Math.hypot(a.x - b.x, a.y - b.y) / pinch.distance;
  view.pin(pinch.page, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top, zoom);
  applyView();
}

// Hands: the camera frame maps onto the tray and the page together, so a pinch
// picks from the tray as well as fills.

const filter = new GestureFilter();
const smoothX = new OneEuro({ minCutoff: 1.2, beta: 0.012 });
const smoothY = new OneEuro({ minCutoff: 1.2, beta: 0.012 });
const smoothPalm = new OneEuro({ minCutoff: 0.8, beta: 0 });
let trail = [];
let handStroke = null;  // the stroke the hand is drawing; only the hand may end it
let handShape = false;  // the hand is sizing a shape; two fingers place it
let grab = null;        // three fingers hold the page: { page, palm, zoom }
let aimed = null;
let lastSeen = 0;
let liveTimer = null;
let handAt = null;      // the cursor, for Space to fill at

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

// The tray and the page's frame together, in viewport pixels.
function reach() {
  const a = tray.getBoundingClientRect();
  const b = frameRect();
  const left = Math.min(a.left, b.left);
  return { left, top: a.top, width: Math.max(a.right, b.right) - left, height: b.bottom - a.top };
}

function onHand(hand, now) {
  lastSeen = now;
  cameraTip.hidden = true;
  const points = toPoints(hand, camera.aspect);
  const raw = classify(points, filter.current === Gesture.SELECT);
  const { gesture, entered } = filter.update(raw, now);

  const target = toRect(1 - hand[8].x, hand[8].y, reach());  // index fingertip, mirrored
  const x = smoothX.filter(target.x, now / 1000);
  const y = smoothY.filter(target.y, now / 1000);
  trail.push({ t: now, x, y });
  while (trail.length && now - trail[0].t > 400) trail.shift();
  handAt = { x, y };

  cursor.hidden = false;
  cursor.dataset.gesture = gesture;
  cursor.style.transform = `translate(${x}px, ${y}px)`;
  aim(document.elementFromPoint(x, y)?.closest(".tray button") ?? null);
  keyRows.forEach((row) => row.classList.toggle("is-active", row.dataset.gesture === gesture));

  // A press on the page (mouse, finger or pen) has the brush until it lifts.
  if (pointer || pinch) return liftHand();

  if (gesture === Gesture.ZOOM) return holdPage(points, x, y, now);
  if (grab) {
    grab = null;
    smoothPalm.reset();
  }

  if (gesture === Gesture.DRAW) return point(x, y);
  // HoloDraw places a shape when the pointing hand opens to two fingers.
  if (gesture === Gesture.NAVIGATE && handShape) {
    painter.commitShape();
    handShape = false;
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

// Pointing: the brush and eraser paint, a shape stretches from where pointing began,
// and the fill tool only aims.
function point(x, y) {
  const at = inFrame(x, y) ? painter.toLayer(x, y) : null;
  if (isShape(painter.tool)) {
    if (!at) return;  // the shape stays anchored while the hand strays over the tray
    if (handShape && painter.shaping) {
      painter.extendShape(at);
    } else {
      painter.beginShape(at);
      handShape = painter.shaping;
    }
    return;
  }
  if (painter.tool === "fill" || !at) return liftHand();
  if (handStroke && painter.stroke === handStroke) {
    painter.extendStroke(at);
  } else {
    painter.beginStroke(at);
    handStroke = painter.stroke;
  }
  scheduleLoupe();
}

// Three fingers hold the page where they touch it: moving the hand pans, and pushing
// it toward the camera zooms in, the way a page comes closer to the eye.
function holdPage(points, x, y, now) {
  liftHand();
  const palm = smoothPalm.filter(palmSize(points), now / 1000);
  const r = frameRect();
  const fx = x - r.left, fy = y - r.top;
  if (!grab) {
    grab = { page: view.toPage(fx, fy), palm, zoom: view.zoom };
    return;
  }
  view.pin(grab.page, fx, fy, grab.zoom * pushZoom(palm / grab.palm));
  applyView();
}

function liftHand() {
  if (handStroke && painter.stroke === handStroke) painter.endStroke();
  handStroke = null;
  if (handShape) painter.cancelShape();  // HoloDraw drops a shape that wasn't placed
  handShape = false;
}

function onNoHand(now) {
  if (!cursor.hidden) {
    liftHand();
    filter.reset();
    smoothX.reset();
    smoothY.reset();
    smoothPalm.reset();
    grab = null;
    trail = [];
    handAt = null;
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
  if (!inFrame(x, y)) return;
  const at = painter.toLayer(x, y);
  if (at) painter.fillAt(at);
}

// Keyboard, following HoloDraw's keys where the browser allows.

const KEYS = {
  z: () => painter.undo(),
  y: () => painter.redo(),
  c: clearPaint,
  s: download,
  n: () => reset(),
  f: () => setTool(painter.tool === "fill" ? previousTool : "fill"),
  F: () => setFilled(!painter.filled),
  1: () => setSize(SIZES[0][1]),
  2: () => setSize(SIZES[1][1]),
  3: () => setSize(SIZES[2][1]),
  i: () => zoomBy(ZOOM_STEP), "+": () => zoomBy(ZOOM_STEP), "=": () => zoomBy(ZOOM_STEP),
  o: () => zoomBy(1 / ZOOM_STEP), "-": () => zoomBy(1 / ZOOM_STEP), _: () => zoomBy(1 / ZOOM_STEP),
  0: fit,
  Escape: () => exitPaint(),
};
const PAN_KEYS = { ArrowLeft: [1, 0], ArrowRight: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };

document.addEventListener("keydown", (event) => {
  if (event.altKey || event.defaultPrevented) return;
  const key = event.key.length === 1 && !event.shiftKey ? event.key.toLowerCase() : event.key;
  if (event.metaKey || event.ctrlKey) {
    if (!painting || !["z", "y", "Z", "Y"].includes(key)) return;
    event.preventDefault();
    if (key.toLowerCase() === "y" || event.shiftKey) painter.redo();
    else painter.undo();
    return;
  }
  // Detail steps with [ and ], as HoloDraw's threshold did with + and -.
  if ((key === "[" || key === "]") && details) {
    event.preventDefault();
    return setDetail(details.level + (key === "]" ? 1 : -1));
  }
  if (!painting) return;
  if (key === " " && !event.target.closest?.("button, a") && handAt) {
    event.preventDefault();
    return tap(handAt.x, handAt.y);  // HoloPaint: Space fills where the hand points
  }
  if (PAN_KEYS[key] && view.zoomed && !event.target.closest?.("[role=radiogroup]")) {
    event.preventDefault();
    const [dx, dy] = PAN_KEYS[key];
    return panBy(dx * PAN_STEP * view.width, dy * PAN_STEP * view.height);
  }
  if (KEYS[key]) {
    event.preventDefault();
    KEYS[key]();
  }
});
window.addEventListener("pagehide", () => camera.stop());

// Wiring

chooseBtn.addEventListener("click", () => fileInput.click());
randomBtn.addEventListener("click", randomPhoto);
blankBtn.addEventListener("click", startBlank);
fileInput.addEventListener("change", () => start(fileInput.files[0]));
downloadBtn.addEventListener("click", download);
paintBtn.addEventListener("click", enterPaint);
doneBtn.addEventListener("click", () => exitPaint());
cameraOn.addEventListener("click", startCamera);
cameraOff.addEventListener("click", stopCamera);
document.querySelectorAll('[data-action="reset"]').forEach((btn) => btn.addEventListener("click", () => reset()));

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
  setIntakeBusy(false);
  slipText.textContent = "This page isn't connected to the API. Set window.HOLOPAINT_API in config.js.";
  slip.querySelector("button").hidden = true;
  slip.hidden = false;
}
