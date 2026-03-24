import sys
import cv2
import numpy as np
from PIL import Image
from simple_lama_inpainting import SimpleLama
import random

def inpaint_video(video_path, output_path, x, y, w, h):
    print("Loading LaMa model...")
    lama = SimpleLama()
    
    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    
    # Dilate mask by 8px for better context
    dilation = 8
    px = max(0, int(x * width) - dilation)
    py = max(0, int(y * height) - dilation)
    pw = min(width - px, int(w * width) + dilation * 2)
    ph = min(height - py, int(h * height) + dilation * 2)
    
    print(f"Video: {width}x{height} @ {fps}fps, {total_frames} frames")
    print(f"Mask region (dilated): {px},{py} {pw}x{ph}")
    
    mask = np.zeros((height, width), dtype=np.uint8)
    mask[py:py+ph, px:px+pw] = 255
    mask_pil = Image.fromarray(mask)
    
    # Precompute background plate - average 10 random frames
    print("Computing background plate from 10 random frames...")
    sample_indices = sorted(random.sample(range(total_frames), min(10, total_frames)))
    bg_regions = []
    for idx in sample_indices:
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
        ret, frame = cap.read()
        if ret:
            bg_regions.append(frame[py:py+ph, px:px+pw].astype(np.float32))
    
    bg_plate = None
    if bg_regions:
        bg_plate = np.median(np.stack(bg_regions), axis=0).astype(np.uint8)
        print(f"Background plate computed from {len(bg_regions)} frames")
    
    # Read all frames and detect scene changes
    print("Detecting scene changes...")
    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
    frames = []
    prev_region = None
    change_threshold = 15
    
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        region = frame[py:py+ph, px:px+pw].astype(np.float32)
        needs_new_patch = False
        if prev_region is None:
            needs_new_patch = True
        else:
            diff = np.abs(region - prev_region).mean()
            if diff > change_threshold:
                needs_new_patch = True
                print(f"Scene change at frame {len(frames)} (diff={diff:.1f})")
        frames.append({"frame": frame.copy(), "needs_patch": needs_new_patch})
        prev_region = region
    
    cap.release()
    print(f"Read {len(frames)} frames, generating patches...")
    
    # Use background plate as first patch if available
    current_patch = bg_plate
    if current_patch is not None:
        print("Using background plate as initial patch")
    
    patch_count = 0
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    out = cv2.VideoWriter(output_path, fourcc, fps, (width, height))
    
    for i, f in enumerate(frames):
        frame = f["frame"]
        if f["needs_patch"]:
            # Try background plate first - if scene is static, use it
            # Otherwise run LaMa for a fresh patch
            frame_pil = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
            clean = lama(frame_pil, mask_pil)
            current_patch = cv2.cvtColor(np.array(clean)[py:py+ph, px:px+pw], cv2.COLOR_RGB2BGR)
            patch_count += 1
            print(f"Patch {patch_count} at frame {i}")
        if current_patch is not None:
            frame[py:py+ph, px:px+pw] = current_patch
        out.write(frame)
        if i % 30 == 0:
            print(f"Processed {i}/{len(frames)}")
    
    out.release()
    print(f"Done! {patch_count} LaMa patches + bg plate for {len(frames)} frames")
    print(f"Output: {output_path}")

if __name__ == "__main__":
    video_path = sys.argv[1]
    output_path = sys.argv[2]
    x = float(sys.argv[3])
    y = float(sys.argv[4])
    w = float(sys.argv[5])
    h = float(sys.argv[6])
    inpaint_video(video_path, output_path, x, y, w, h)
