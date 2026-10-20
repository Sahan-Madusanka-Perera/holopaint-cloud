# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Delegated: static HTML, CSS and vanilla JS in `web/`, no build step. Chosen because the page is hosted on GitHub Pages and served locally with `python3 -m http.server 8000 -d web`; the API origin allow-list already covers both.

## Users

Recruiters and engineers reviewing Sahan Perera's portfolio for software, DevOps/cloud or ML internships. They arrive from a CV or GitHub link, usually on a laptop, sometimes on a phone, and try the system once, often with a photo already on their device.

## Product Purpose

HoloPaint Cloud turns a photo into a colouring page: black outlines whose regions close, so every area can be flood-filled. The demo page exists to let a reviewer see the deployed system work end to end in under a minute.

## Positioning

The outlines come from a U-Net Sahan trained from scratch for HoloDraw, compressed to INT8 ONNX, served by an event-driven serverless pipeline on AWS (presigned S3 upload, SQS with a dead-letter queue, a Lambda worker, DynamoDB job status), all defined in Terraform.

## Capabilities and Constraints

- Accepts JPEG, PNG and WebP up to 5 MB; the page downscales to 1600 px on the longer side before upload. HEIC is not decoded by the worker.
- Processing is asynchronous: upload, then poll the job. Measured: about 9 s extra on a cold start, about 5 s warm for a 640×480 photo, longer for larger photos.
- Uploads and results are deleted after 24 hours.
- API is throttled to 5 requests per second; at most 2 photos process at once.
- Hosted in AWS ap-southeast-2 (Sydney).

## Brand Commitments

- Name: HoloPaint (HoloPaint Cloud for the deployed system).
- Copy is minimal and plain. No em dashes. Nothing that reads as generated filler.

## Evidence on Hand

- Measured results in `README.md` and `results/parity.md` (118 MB to 30 MB, 0.99 mean outline IoU vs PyTorch; Lambda timings).
- No users, testimonials or usage numbers exist; do not invent any.

## Product Principles

1. The working system is the pitch: let the reviewer run it, not read about it.
2. Show real timings and real states; never fake progress.
3. Every word earns its place.
4. Fail clearly: a rejected photo says why and how to fix it.

## Accessibility & Inclusion

WCAG 2.2 AA: keyboard-operable upload, visible focus, status changes announced to screen readers, reduced-motion respected.
