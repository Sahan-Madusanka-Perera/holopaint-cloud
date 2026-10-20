# HoloPaint Cloud

Upload a photo, get back a colouring page: black outlines whose regions all close, so
they can be flood-filled. It runs on AWS as an event-driven serverless pipeline. The model is
the U-Net I trained from scratch on BSDS500 for
[HoloDraw](https://github.com/Sahan-Madusanka-Perera/HoloDraw).

```
browser ─► API Gateway ─► api Lambda ─► presigned POST ─► S3 ─► SQS (+DLQ) ─► worker Lambda (ONNX INT8) ─► S3
```

**Status:** M1 (model compression) and M2 (worker container) are done. Next is M3
(Terraform: deploy to AWS).

| Milestone | |
|---|---|
| M1 Compress the model (ONNX INT8) + parity gate | ✅ |
| M2 Worker Lambda container + tests + local end-to-end | ✅ |
| M3 Terraform: S3, SQS + DLQ, DynamoDB, Lambdas, HTTP API | in progress |
| M4 CI (GitHub Actions) + CD (CodePipeline/CodeBuild), smoke test + rollback | |
| M5 CloudWatch dashboard + alarms, k6 load test | |
| M6 Demo page | |

## M1: compressing the model without changing its output

The worker runs ONNX Runtime instead of PyTorch. That keeps the Lambda image small
and cold starts fast. The question was how far the model can shrink before the
colouring pages change.

**Method**
1. `worker/pipeline.py` ports HoloDraw's full pipeline to NumPy, with the model
   passed in as a function: global pass with flip TTA, Hanning-blended
   full-resolution tiles, Canny fusion, hysteresis, gap bridging and noise removal.
   `model/check_port.py` runs HoloDraw's original code next to the port. The
   outlines are **pixel-identical**.
2. `model/export_onnx.py` exports to ONNX (opset 17, dynamic batch). The raw
   outputs differ from PyTorch by at most 1e-6.
3. `model/quantize.py` builds two INT8 variants:
   - *static*: QDQ, per-channel weights, activations calibrated on 120 tiles from
     BSDS500 **train** images
   - *dynamic*: weight-only
4. `model/parity_eval.py` runs the whole pipeline on a fixed set of 30 photos (20
   BSDS500 *test* at 481×321, 10 BIPED test at 1280×720). It compares each variant's
   outline with the PyTorch outline (IoU of edge pixels), using 2 CPU threads to
   approximate a 3 GB Lambda.

**Results** (Apple M4, 2 threads)

| model | size (MB) | outline IoU mean | IoU worst | prob. MAE | s/photo 481×321 | s/photo 1280×720 |
|---|---:|---:|---:|---:|---:|---:|
| PyTorch (original) | 118.5 | 1.0000 | 1.0000 | 0.00000 | 0.54 | 3.64 |
| ONNX FP32 | 118.4 | 1.0000 | 1.0000 | 0.00000 | 1.72 | 8.58 |
| ONNX INT8 dynamic | 37.6 | 0.9928 | 0.9796 | 0.00199 | 0.68 | 3.40 |
| **ONNX INT8 static** | **29.7** | **0.9907** | **0.9821** | 0.00326 | 0.59 | 2.94 |

**Decision: deploy INT8 static.** It is 4× smaller with 99% outline overlap. Even
the worst photo (98.2%) is visually indistinguishable from the original. The CI
parity gate fails the build if any photo drops below **0.97 IoU**.

**Caveats**
- On the M4, INT8 is only modestly faster than PyTorch (about 1.2× on HD photos), so
  the main win is size, which drives image size and cold-start time. FP32 ONNX is
  slower than PyTorch on this machine. Speed on Lambda's Graviton CPUs gets measured
  in M5, and those are the numbers that count.
- Post-processing takes about 0.05 s. Nearly all the time goes to running the
  model on 18 tiles plus the global pass for an HD photo.

## M2: the worker Lambda, built and tested locally

`worker/handler.py` is invoked by SQS with S3 upload events. For each upload it
loads the photo, runs the pipeline, writes `results/<job_id>.png` and marks the job
`DONE` in DynamoDB.

- **Hostile input** (`worker/photo.py`): byte and pixel limits are checked from the
  header before decoding (decompression bombs). Only real JPEG/PNG/WebP files pass,
  whatever the file name says. EXIF rotation is applied, then all metadata is
  dropped. The longer side is capped at 1600 px.
- **At-least-once delivery:** a job already `DONE` is skipped, and re-processing writes
  byte-identical output to the same key.
- **Failures:**
  - A bad upload is marked `FAILED` once and never retried.
  - Transient errors are returned as SQS *partial batch failures* and retried.
  - On the final attempt the job is marked `FAILED` before the message goes to the
    DLQ, so a user never waits on a job that will never finish.
- **Observability:** Powertools JSON logs and EMF metrics (`JobLatency`,
  `TilesPerImage`, `JobsFailed`, `JobsRejected`, cold starts).

**Tests:** 26 pytest tests (`worker/tests`). Photo validation, a golden outline,
and handler behaviour against moto (fake S3 + DynamoDB): success, duplicate
delivery, identical re-processing, a rejected upload, retry then fail on the last
attempt, S3 test events, path tricks, and a mixed batch.

**Container:** AWS's Lambda Python 3.12 base image for arm64. It holds no PyTorch,
only ONNX Runtime and the 30 MB INT8 model (`worker/Dockerfile`, allow-list
`.dockerignore`), 301 MB in total. `scripts/local_e2e.py` runs the real image (with the
Lambda Runtime Interface Emulator inside) beside a moto server and checks
upload → DONE → PNG.

| 640×480 photo, container capped at 2 CPUs / 3008 MB | per photo |
|---|---:|
| ONNX Runtime default threads | 4.47 s |
| **`ORT_THREADS=2`** (match the CPU quota) | **1.34 s** |

**Thread oversubscription:** inside a CPU-capped container, ONNX Runtime sized its
pool from all 10 host cores. Pinning it to the 2-CPU quota made inference 3.3×
faster. The Lambda sets `ORT_THREADS` to match its vCPUs.

**Portability:** given the same lossless input, the Linux arm64 container's outline
is **pixel-identical** to the macOS one (`worker/tests/golden/`).

## Reproduce

Needs the HoloDraw repo next to this one (for the weights and the BSDS500/BIPED
images), or set `HOLODRAW_DIR`.

```bash
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r model/requirements.txt -r worker/requirements-dev.txt
cp ../HoloDraw/holopaint_unet.pth artifacts/

.venv/bin/python model/check_port.py        # port == HoloDraw, pixel for pixel
.venv/bin/python model/export_onnx.py       # -> artifacts/unet_fp32.onnx
.venv/bin/python model/quantize.py          # -> artifacts/unet_int8_{static,dynamic}.onnx
.venv/bin/python model/parity_eval.py --gate unet_int8_static.onnx   # -> results/parity.{md,json}

.venv/bin/python -m pytest                  # 26 worker tests
.venv/bin/python scripts/local_e2e.py       # build image, run it against moto, check upload -> PNG
```

## Layout

```
model/    unet.py  common.py  check_port.py  export_onnx.py  quantize.py  parity_eval.py
worker/   handler.py  photo.py  pipeline.py  onnx_predictor.py  Dockerfile  tests/
scripts/  local_e2e.py
results/  parity.md  parity.json                   (side-by-side PNGs are git-ignored)
artifacts/  weights and ONNX files (git-ignored; S3 model registry from M3)
```
