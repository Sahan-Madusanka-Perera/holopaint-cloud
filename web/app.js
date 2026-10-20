// HoloPaint demo: photo -> presigned S3 upload -> poll the job -> colouring page.
(() => {
  "use strict";

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
  const downloadBtn = $("download");
  const slugJob = $("slug-job");
  const status = $("status");
  const patches = [...document.querySelectorAll(".patch")];
  const plates = document.querySelector(".plates");

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

      const img = showImage(outlineMedia, done.result_url, "Colouring page traced from your photo");
      await img.decode().catch(() => {});
      if (token !== run) return;
      const total = stopClock();
      img.classList.add("registering");
      setStage("ready");
      progress.hidden = true;
      actions.hidden = false;
      result = { jobId: job.job_id, url: done.result_url };
      slugJob.replaceChildren(...[
        `Job ${job.job_id.slice(0, 8)}`,
        `${done.width}×${done.height}`,
        `Traced in ${seconds(done.duration_ms)} s`,
        `Total ${seconds(total)} s`,
      ].flatMap((text, i) => [i ? " " : "", Object.assign(document.createElement("span"), { textContent: text })]));
      announce("Your colouring page is ready.");
      downloadBtn.focus({ preventScroll: true });
    } catch (error) {
      fail(error instanceof UserError ? error.message : "Something went wrong. Try again.", token);
    }
  }

  async function download() {
    if (!result) return;
    downloadBtn.disabled = true;
    try {
      let response = await fetch(result.url).catch(() => null);
      if (!response || !response.ok) {
        // The signed link lasts 15 minutes; ask for a fresh one.
        const job = await api(`/jobs/${result.jobId}`);
        if (!job.result_url) throw new UserError("This colouring page has expired. Make a new one.");
        result.url = job.result_url;
        response = await fetch(result.url);
      }
      const href = URL.createObjectURL(await response.blob());
      const link = Object.assign(document.createElement("a"), {
        href, download: `holopaint-${result.jobId.slice(0, 8)}.png`,
      });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(href), 10_000);
    } catch (error) {
      announce(error instanceof UserError ? error.message : "The download didn't start. Try again.");
    } finally {
      downloadBtn.disabled = false;
    }
  }

  function reset({ focus = true } = {}) {
    run += 1;
    if (clockTimer) stopClock();
    objectUrls.forEach((url) => URL.revokeObjectURL(url));
    objectUrls = [];
    result = null;
    photoMedia.replaceChildren();
    outlineMedia.replaceChildren();
    plates.style.removeProperty("--ar");
    intake.hidden = false;
    progress.hidden = true;
    coldNote.hidden = true;
    slip.hidden = true;
    actions.hidden = true;
    slugJob.replaceChildren();
    clock.textContent = "0.0";
    fileInput.value = "";
    setStage("idle");
    if (focus) chooseBtn.focus({ preventScroll: true });
  }

  // Wiring

  chooseBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => start(fileInput.files[0]));
  downloadBtn.addEventListener("click", download);
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
    chooseBtn.disabled = true;
    slipText.textContent = "This page isn't connected to the API. Set window.HOLOPAINT_API in config.js.";
    slip.querySelector("button").hidden = true;
    slip.hidden = false;
  }
})();
