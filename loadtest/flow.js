// Load test: the whole browser flow for each photo, against the deployed API.
//   POST /jobs -> presigned POST of the photo to S3 -> poll GET /jobs/{id} until DONE
//
//   loadtest/fetch_photos.sh
//   k6 run -e API=<api-url> -e SCENARIO=steady   -e RATE=12 loadtest/flow.js
//   k6 run -e API=<api-url> -e SCENARIO=saturate -e VUS=6   loadtest/flow.js
//   k6 run -e API=<api-url> -e SCENARIO=serial   -e ITERATIONS=12 loadtest/flow.js
//
// photo_seconds is what a visitor waits: from creating the job to seeing it DONE,
// polling every POLL seconds as the page does (it polls every 0.9 s). The API is
// throttled at 5 requests/s, so keep in-flight jobs / POLL under that; 429s are
// retried with backoff and counted in throttled_requests.
import http from "k6/http";
import exec from "k6/execution";
import { check, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";

const API = (__ENV.API || "").replace(/\/+$/, "");
const SIZE = __ENV.SIZE || "640x480";
const PHOTOS = ["1025", "237", "851"].map((id) => open(`./photos/${id}-${SIZE}.jpg`, "b"));
const POLL = Number(__ENV.POLL || 1);
const TIMEOUT_MS = 240_000;
const SCENARIO = __ENV.SCENARIO || "steady";

const photoSeconds = new Trend("photo_seconds");    // created -> DONE seen by the client
const workerSeconds = new Trend("worker_seconds");  // processing inside the worker
const waitSeconds = new Trend("wait_seconds");      // the rest: upload, queue, cold start, polling
const jobsDone = new Counter("jobs_done");
const jobFailed = new Rate("job_failed");
const throttled = new Counter("throttled_requests");

const SCENARIOS = {
  steady: {
    executor: "constant-arrival-rate", rate: Number(__ENV.RATE || 12), timeUnit: "1m",
    duration: __ENV.DURATION || "5m", preAllocatedVUs: 10, maxVUs: 40,
  },
  saturate: { executor: "constant-vus", vus: Number(__ENV.VUS || 6), duration: __ENV.DURATION || "5m" },
  serial: {  // one photo at a time per VU; VUS=2 reaches both workers
    executor: "per-vu-iterations", vus: Number(__ENV.VUS || 1), iterations: Number(__ENV.ITERATIONS || 12), maxDuration: "30m",
  },
};

export const options = {
  scenarios: { [SCENARIO]: SCENARIOS[SCENARIO] },
  thresholds: {
    job_failed: ["rate<0.01"],
    // Also makes k6 report each request type on its own.
    "http_req_duration{name:POST /jobs}": ["p(95)<3000"],
    "http_req_duration{name:S3 upload}": ["p(95)<10000"],
    "http_req_duration{name:GET /jobs/{id}}": ["p(95)<3000"],
  },
  summaryTrendStats: ["min", "med", "p(90)", "p(95)", "max", "count"],
};

export function setup() {
  if (!API.startsWith("https://")) throw new Error("pass -e API=https://<api-id>.execute-api.<region>.amazonaws.com");
}

function call(method, path, name) {
  for (let attempt = 0; ; attempt++) {
    const res = http.request(method, `${API}${path}`, null, { tags: { name } });
    if (res.status !== 429 || attempt === 6) return res;
    throttled.add(1);
    sleep(0.5 * 2 ** attempt);
  }
}

// S3 presigned POST: the policy fields first, Content-Type, and the file last.
// Built by hand because k6's multipart encoder doesn't keep field order.
function multipart(fields, photo) {
  const boundary = `----holopaint${Math.random().toString(16).slice(2)}`;
  let head = "";
  for (const [name, value] of Object.entries({ ...fields, "Content-Type": "image/jpeg" })) {
    head += `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  }
  head += `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="photo.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  const bytes = (text) => {  // the fields are ASCII
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
    return out;
  };
  const body = new Uint8Array(head.length + photo.byteLength + tail.length);
  body.set(bytes(head), 0);
  body.set(new Uint8Array(photo), head.length);
  body.set(bytes(tail), head.length + photo.byteLength);
  return { body: body.buffer, type: `multipart/form-data; boundary=${boundary}` };
}

export default function () {
  const photo = PHOTOS[exec.scenario.iterationInTest % PHOTOS.length];
  const started = Date.now();

  const created = call("POST", "/jobs", "POST /jobs");
  if (!check(created, { "job created": (r) => r.status === 201 })) return jobFailed.add(true);
  const job = created.json();

  const { body, type } = multipart(job.upload.fields, photo);
  const upload = http.post(job.upload.url, body, { headers: { "Content-Type": type }, tags: { name: "S3 upload" } });
  if (!check(upload, { "photo uploaded": (r) => r.status === 204 })) return jobFailed.add(true);

  let state = { status: "PENDING" };
  while (!["DONE", "FAILED"].includes(state.status) && Date.now() - started < TIMEOUT_MS) {
    sleep(POLL);
    const res = call("GET", `/jobs/${job.job_id}`, "GET /jobs/{id}");
    if (res.status === 200) state = res.json();
  }
  const ok = check(state, { "job done": (s) => s.status === "DONE" });
  jobFailed.add(!ok);
  if (!ok) return;

  const seconds = (Date.now() - started) / 1000;
  jobsDone.add(1);
  photoSeconds.add(seconds);
  workerSeconds.add(state.duration_ms / 1000);
  waitSeconds.add(seconds - state.duration_ms / 1000);
}
