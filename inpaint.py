import sys
import cv2
import numpy as np
from PIL import Image
from simple_lama_inpainting import SimpleLama
import os

def inpaint_video(video_path, output_path, x, y, w, h):
    print(f"Loading LaMa model...")
    lama = SimpleLama()
    
    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration = total_frames / fps
    
    px = int(x * width)
    py = int(y * height)
    pw = int(w * width)
    ph = int(h * height)
    
    print(f"Video: {width}x{height} @ {fps}fps, {total_frames} frames, {duration:.1f}s")
    print(f"Mask region: {px},{py} {pw}x{ph}")
    
    # Create mask
    mask = np.zeros((height, width), dtype=np.uint8)
    mask[py:py+ph, px:px+pw] = 255
    mask_pil = Image.fromarray(mask)
    
    # Sample a clean patch every 0.5 seconds
    sample_interval = 0.5
    sample_times = [i * sample_interval for i in range(int(duration / sample_interval) + 1)]
    sample_times = [t for t in sample_times if t < duration]
    
    print(f"Generating {len(sample_times)} clean patches (every 0.5s)...")
    patches = []
    for t in sample_times:
        frame_idx = int(t * fps)
        cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
        ret, frame = cap.read()
        if not ret:
            continue
        frame_pil = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
        clean = lama(frame_pil, mask_pil)
        clean_patch = np.array(clean)[py:py+ph, px:px+pw]
        patches.append({'time': t, 'patch': clean_patch})
        print(f"Patch {len(patches)}/{len(sample_times)} at {t:.1f}s done")
    
    if not patches:
        print("ERROR: No patches generated")
        sys.exit(1)
    
    print(f"Got {len(patches)} patches, applying to all frames...")
    
    # Reset to beginning
    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
    
    # Write output
    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
    out = cv2.VideoWriter(output_path, fourcc, fps, (width, height))
    
    frame_idx = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        
        # Find nearest patch
        frame_time = frame_idx / fps
        nearest = min(patches, key=lambda p: abs(p['time'] - frame_time))
        patch_bgr = cv2.cvtColor(nearest['patch'], cv2.COLOR_RGB2BGR)
        frame[py:py+ph, px:px+pw] = patch_bgr
        out.write(frame)
        frame_idx += 1
        if frame_idx % 30 == 0:
            print(f"Processed {frame_idx}/{total_frames} frames")
    
    cap.release()
    out.release()
    print(f"Done! Output: {output_path}")

if __name__ == "__main__":
    video_path = sys.argv[1]
    output_path = sys.argv[2]
    x = float(sys.argv[3])
    y = float(sys.argv[4])
    w = float(sys.argv[5])
    h = float(sys.argv[6])
    inpaint_video(video_path, output_path, x, y, w, h)
