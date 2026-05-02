#!/bin/bash
# Extract and optimize video segment 00:16-00:20 (4 seconds) for web background
# Run this script from the mov/ directory

INPUT="Going Accross the Sea_version longue.mp4"

echo "Creating optimized MP4 (H.264)..."
ffmpeg -ss 00:00:16.0 -i "$INPUT" -t 00:00:04.0 \
  -vf "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2" \
  -an -c:v libx264 -preset slow -crf 28 -b:v 800k -maxrate 1000k -bufsize 2000k \
  -movflags +faststart trailer.mp4

echo "Creating optimized WebM (VP9)..."
ffmpeg -ss 00:00:16.0 -i "$INPUT" -t 00:00:04.0 \
  -vf "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2" \
  -an -c:v libvpx-vp9 -b:v 800k -crf 30 -speed 2 trailer.webm

echo "Done! Video files optimized for web."

