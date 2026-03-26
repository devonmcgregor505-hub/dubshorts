#!/usr/bin/env python3
import sys, os, json, subprocess, shutil
import cv2
import numpy as np
from PIL import Image
import torch
torch.backends.mps.enabled = True
os.environ['CUDA_VISIBLE_DEVICES'] = ''
from simple_lama_inpainting import SimpleLama

def main():
    video_in  = sys.argv[1]
    video_out = sys.argv[2]
    box_json  = sys.argv[3]
    box = json.loads(box_json)

    lama = SimpleLama()
    cap = cv2.VideoCapture(video_in)
    fps    = cap.get(cv2.CAP_PROP_FPS)
    width  = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    WORK_H = 540
    scale  = WORK_H / height if height > WORK_H else 1.0
    ww     = int(width  * scale)
    wh     = int(height * scale)

    pad = 4
    x1 = max(0, int(box['x'] * ww) - pad)
    y1 = max(0, int(box['y'] * wh) - pad)
    x2 = min(ww, int((box['x'] + box['w']) * ww) + pad)
    y2 = min(wh, int((box['y'] + box['h']) * wh) + pad)
    bw = x2 - x1
    bh = y2 - y1

    mask = np.zeros((bh, bw), dtype=np.uint8)
    mask[pad:bh-pad, pad:bw-pad] = 255
    mask_pil = Image.fromarray(mask)

    fx1 = max(0, int(box['x'] * width) - pad * 2)
    fy1 = max(0, int(box['y'] * height) - pad * 2)
    fx2 = min(width,  int((box['x'] + box['w']) * width)  + pad * 2)
    fy2 = min(height, int((box['y'] + box['h']) * height) + pad * 2)

    ffmpeg = shutil.which('ffmpeg') or '/opt/homebrew/bin/ffmpeg'

    proc = subprocess.Popen([
        ffmpeg, '-y',
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

    idx = 0
    print(f"Processing {width}x{height} @ {fps}fps — LaMa at {ww}x{wh}, crop {bw}x{bh}", flush=True)

    while True:
        ret, frame = cap.read()
        if not ret:
            break
        small = cv2.resize(frame, (ww, wh))
        crop = small[y1:y2, x1:x2]
        crop_pil = Image.fromarray(cv2.cvtColor(crop, cv2.COLOR_BGR2RGB))
        result_pil = lama(crop_pil, mask_pil)
        result_bgr = cv2.cvtColor(np.array(result_pil), cv2.COLOR_RGB2BGR)
        if result_bgr.shape[:2] != (bh, bw):
            result_bgr = cv2.resize(result_bgr, (bw, bh))
        small[y1:y2, x1:x2] = result_bgr
        patch_full = cv2.resize(small[y1:y2, x1:x2], (fx2 - fx1, fy2 - fy1))
        frame[fy1:fy2, fx1:fx2] = patch_full
        try:
            proc.stdin.write(frame.tobytes())
        except BrokenPipeError:
            print(f"Pipe closed at frame {idx} — FFmpeg done early", flush=True)
            break
        idx += 1
        if idx % 30 == 0:
            print(f"  {idx} frames done", flush=True)

    cap.release()
    try:
        proc.stdin.close()
    except Exception:
        pass
    proc.wait()

    # Check output file exists and has real content
    if os.path.exists(video_out) and os.path.getsize(video_out) > 10000:
        print(f"Done — {idx} frames → {video_out}", flush=True)
    else:
        stderr = proc.stderr.read().decode(errors='replace')
        raise RuntimeError(f'FFmpeg failed (rc={proc.returncode}): {stderr[-600:]}')

if __name__ == '__main__':
    main()
