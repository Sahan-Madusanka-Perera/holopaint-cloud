#!/usr/bin/env bash
# Three fixed Lorem Picsum photos (Unsplash licence) at the two sizes the load test
# uses: 640x480, and 1600x1200, the most the page uploads. Downloaded, not committed.
#   loadtest/fetch_photos.sh
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p photos
for id in 1025 237 851; do
  for size in 640x480 1600x1200; do
    curl -sSfL -o "photos/$id-$size.jpg" "https://picsum.photos/id/$id/${size/x//}.jpg"
  done
done
ls -l photos
