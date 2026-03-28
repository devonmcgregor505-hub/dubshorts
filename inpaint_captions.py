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

    cap          = cv2.VideoCapture(video_in)
    fps          = cap.get(cv2.CAP_PROP_FPS)
    width        = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height       = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration     = total_frames / fps if fps > 0 else 0

    print(f"Duration: {duration:.1f}s | source: {width}x{height} | {total_frames} frames", flush=True)

    # Full res box coords — tight, no padding
    fx1 = max(0,      int(box['x'] * width))
    fy1 = max(0,      int(box['y'] * height))
    fx2 = min(width,  int((box['x'] + box['w']) * width))
    fy2 = min(height, int((box['y'] + box['h']) * height))
    fw  = fx2 - fx1
    fh  = fy2 - fy1

    # Solid white mask — entire box, every frame, no detection
    full_mask    = np.ones((fh, fw), dtype=np.uint8) * 255
    mask_pil     = Image.fromarray(full_mask)
    mask_3ch     = cv2.cvtColor(full_mask, cv2.COLOR_GRAY2BGR)

    print(f"Box: x={fx1} y={fy1} w={fw} h={fh} — solid mask, no detection", flush=True)

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

    idx = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break

        full_crop  = frame[fy1:fy2, fx1:fx2].copy()
        crop_pil   = Image.fromarray(cv2.cvtColor(full_crop, cv2.COLOR_BGR2RGB))
        result_pil = lama(crop_pil, mask_pil)
        result_bgr = cv2.cvtColor(np.array(result_pil), cv2.COLOR_RGB2BGR)

        if result_bgr.shape[:2] != (fh, fw):
            result_bgr = cv2.resize(result_bgr, (fw, fh))

        frame[fy1:fy2, fx1:fx2] = result_bgr

        try:
            proc.stdin.write(frame.tobytes())
        except BrokenPipeError:
            print(f"Pipe closed at frame {idx}", flush=True)
            break

        idx += 1
        if idx % 30 == 0:
            pct = int(idx / max(total_frames, 1) * 100)
            print(f"  [{pct}%] {idx}/{total_frames}", flush=True)

    cap.release()
    try:
        proc.stdin.close()
    except Exception:
        pass
    proc.wait()

    if os.path.exists(video_out) and os.path.getsize(video_out) > 10000:
        print(f"Done — {idx} frames processed", flush=True)
    else:
        stderr_out = proc.stderr.read().decode(errors='replace')
        raise RuntimeError(f'FFmpeg failed (rc={proc.returncode}): {stderr_out[-600:]}')

if __name__ == '__main__':
    main()
