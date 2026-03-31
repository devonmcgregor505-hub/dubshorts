#!/usr/bin/env python3
import sys, os, json, subprocess, shutil
import cv2
import numpy as np
from PIL import Image
import torch
torch.backends.mps.enabled = True
os.environ['CUDA_VISIBLE_DEVICES'] = ''
from simple_lama_inpainting import SimpleLama


def detect_text_mask(crop_bgr, dilation_px=4):
    """
    Precisely detects caption text pixels (white + yellow + their black outlines).
    Uses connected-component filtering to reject non-text noise.
    """
    hsv = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2HSV)
    h, w = crop_bgr.shape[:2]

    # ── White text (high brightness, low saturation) ──────────────────────────
    white_mask = cv2.inRange(hsv,
        np.array([0,   0, 190]),
        np.array([180, 50, 255])
    )

    # ── Yellow highlighted word ────────────────────────────────────────────────
    yellow_mask = cv2.inRange(hsv,
        np.array([18, 130, 180]),
        np.array([38, 255, 255])
    )

    # ── Black outline ONLY where there's white/yellow nearby ──────────────────
    # Expand white+yellow to find their neighbourhood
    text_colour = cv2.bitwise_or(white_mask, yellow_mask)
    expand_k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
    text_neighbourhood = cv2.dilate(text_colour, expand_k)

    gray = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2GRAY)
    _, black_raw = cv2.threshold(gray, 45, 255, cv2.THRESH_BINARY_INV)
    # Only keep black pixels that are adjacent to text-coloured pixels
    black_mask = cv2.bitwise_and(black_raw, text_neighbourhood)

    # ── Combine ────────────────────────────────────────────────────────────────
    combined = cv2.bitwise_or(text_colour, black_mask)

    # ── Remove tiny specks (smaller than ~3×3 px) ─────────────────────────────
    kernel_open = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    combined = cv2.morphologyEx(combined, cv2.MORPH_OPEN, kernel_open)

    # ── Fill holes inside letter shapes ───────────────────────────────────────
    kernel_close = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    combined = cv2.morphologyEx(combined, cv2.MORPH_CLOSE, kernel_close)

    # ── Filter connected components — keep only plausible letter blobs ─────────
    num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(combined, connectivity=8)
    filtered = np.zeros_like(combined)
    min_area  = max(4, int((w * h) * 0.0001))   # at least 0.01% of crop area
    max_area  = int((w * h) * 0.30)              # at most 30% (avoids eating background)
    max_aspect = 12.0                             # letters are not ultra-wide blobs

    for label in range(1, num_labels):
        area   = stats[label, cv2.CC_STAT_AREA]
        bw_    = stats[label, cv2.CC_STAT_WIDTH]
        bh_    = stats[label, cv2.CC_STAT_HEIGHT]
        aspect = bw_ / max(bh_, 1)
        if min_area < area < max_area and aspect < max_aspect:
            filtered[labels == label] = 255

    # ── Small dilation to cover anti-aliased edges cleanly ────────────────────
    if dilation_px > 0:
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (dilation_px, dilation_px))
        filtered = cv2.dilate(filtered, k)

    return filtered


def main():
    video_in  = sys.argv[1]
    video_out = sys.argv[2]
    box_json  = sys.argv[3]
    box = json.loads(box_json)

    lama = SimpleLama()

    cap          = cv2.VideoCapture(video_in)
    fps          = cap.get(cv2.CAP_PROP_FPS)
    width        = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height       = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration     = total_frames / fps if fps > 0 else 0

    # ── Choose processing resolution ──────────────────────────────────────────
    # We process at a reduced height to keep LaMa fast, but paste back at
    # FULL resolution so there's no blurry upscale artefact.
    if duration <= 10:
        WORK_H = 720
    elif duration <= 30:
        WORK_H = 560
    else:
        WORK_H = 480

    scale = min(1.0, WORK_H / height)
    ww = int(width  * scale)
    wh = int(height * scale)

    print(f"Duration: {duration:.1f}s | source: {width}x{height} | work: {ww}x{wh}", flush=True)

    # ── Box coords at WORK size (for mask detection) ───────────────────────────
    pad_s = 4
    sx1 = max(0,  int(box['x'] * ww) - pad_s)
    sy1 = max(0,  int(box['y'] * wh) - pad_s)
    sx2 = min(ww, int((box['x'] + box['w']) * ww) + pad_s)
    sy2 = min(wh, int((box['y'] + box['h']) * wh) + pad_s)

    # ── Box coords at FULL size (for LaMa input + paste-back) ─────────────────
    pad_f = max(6, int(pad_s / scale))
    fx1 = max(0,      int(box['x'] * width)  - pad_f)
    fy1 = max(0,      int(box['y'] * height) - pad_f)
    fx2 = min(width,  int((box['x'] + box['w']) * width)  + pad_f)
    fy2 = min(height, int((box['y'] + box['h']) * height) + pad_f)
    fw  = fx2 - fx1
    fh  = fy2 - fy1

    ffmpeg_bin = shutil.which('ffmpeg') or '/opt/homebrew/bin/ffmpeg'
    proc = subprocess.Popen([
        ffmpeg_bin, '-y',
        '-f', 'rawvideo', '-vcodec', 'rawvideo',
        '-s', f'{width}x{height}',
        '-pix_fmt', 'bgr24',
        '-r', str(fps),
        '-i', 'pipe:0',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        video_out
    ], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

    idx = skipped = inpainted = 0
    print(f"Processing — precise text mask (white+yellow+contextual-black)", flush=True)

    while True:
        ret, frame = cap.read()
        if not ret:
            break

        # ── 1. Detect mask at work resolution (fast) ──────────────────────────
        small      = cv2.resize(frame, (ww, wh)) if scale < 1.0 else frame.copy()
        crop_small = small[sy1:sy2, sx1:sx2]
        text_mask_small = detect_text_mask(crop_small)

        text_ratio = np.sum(text_mask_small > 0) / max(1, (sx2-sx1) * (sy2-sy1))

        if text_ratio > 0.003:
            # ── 2. Scale mask up to FULL-RES box size ─────────────────────────
            text_mask_full = cv2.resize(text_mask_small, (fw, fh),
                                        interpolation=cv2.INTER_NEAREST)
            # Threshold after resize to keep it binary
            _, text_mask_full = cv2.threshold(text_mask_full, 127, 255, cv2.THRESH_BINARY)

            # ── 3. Run LaMa on the full-res crop ──────────────────────────────
            full_crop = frame[fy1:fy2, fx1:fx2]
            crop_pil  = Image.fromarray(cv2.cvtColor(full_crop, cv2.COLOR_BGR2RGB))
            mask_pil  = Image.fromarray(text_mask_full)

            result_pil = lama(crop_pil, mask_pil)
            result_bgr = cv2.cvtColor(np.array(result_pil), cv2.COLOR_RGB2BGR)

            if result_bgr.shape[:2] != (fh, fw):
                result_bgr = cv2.resize(result_bgr, (fw, fh))

            # ── 4. Composite: only replace masked pixels ───────────────────────
            mask_3ch = cv2.cvtColor(text_mask_full, cv2.COLOR_GRAY2BGR)
            blended  = np.where(mask_3ch > 0, result_bgr, full_crop)
            frame[fy1:fy2, fx1:fx2] = blended

            inpainted += 1
        else:
            skipped += 1

        try:
            proc.stdin.write(frame.tobytes())
        except BrokenPipeError:
            print(f"Pipe closed at frame {idx}", flush=True)
            break

        idx += 1
        if idx % 30 == 0:
            pct = int(idx / max(total_frames, 1) * 100)
            print(f"  [{pct}%] {idx}/{total_frames} — inpainted={inpainted} skipped={skipped} ratio={text_ratio:.3f}", flush=True)

    cap.release()
    try:
        proc.stdin.close()
    except Exception:
        pass
    proc.wait()

    if os.path.exists(video_out) and os.path.getsize(video_out) > 10000:
        print(f"Done — {idx} frames, {inpainted} inpainted, {skipped} skipped", flush=True)
    else:
        stderr_out = proc.stderr.read().decode(errors='replace')
        raise RuntimeError(f'FFmpeg failed (rc={proc.returncode}): {stderr_out[-600:]}')


if __name__ == '__main__':
    main()