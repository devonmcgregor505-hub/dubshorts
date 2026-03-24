import sys
import cv2
import numpy as np
from PIL import Image
from simple_lama_inpainting import SimpleLama

def inpaint_video(video_path, output_path, x, y, w, h):
    print("Loading LaMa model...")
    lama = SimpleLama()
    
    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration = total_frames / fps

    # Dynamic interval
    if duration <= 5:
        min_interval = 0.1
    elif duration <= 15:
        min_interval = 0.2
    elif duration <= 30:
        min_interval = 0.3
    elif duration <= 60:
        min_interval = 0.4
    else:
        min_interval = 0.5
    min_interval_frames = max(1, int(min_interval * fps))
    print(f"Duration: {duration:.1f}s, patch interval: {min_interval}s")

    dilation = 8
    px = max(0, int(x * width) - dilation)
    py = max(0, int(y * height) - dilation)
    pw = min(width - px, int(w * width) + dilation * 2)
    ph = min(height - py, int(h * height) + dilation * 2)
    
    print(f"Video: {width}x{height} @ {fps}fps, {total_frames} frames")
    print(f"Mask region dilated: {px},{py} {pw}x{ph}")
    
    mask = np.zeros((height, width), dtype=np.uint8)
    mask[py:py+ph, px:px+pw] = 255
    mask_pil = Image.fromarray(mask)
    
    # Background plate from evenly spaced frames
    print("Computing background plate...")
    n_samples = min(10, total_frames)
    sample_indices = [int(i * total_frames / n_samples) for i in range(n_samples)]
    bg_regions = []
    for idx in sample_indices:
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
        ret, frame = cap.read()
        if ret:
            bg_regions.append(frame[py:py+ph, px:px+pw].astype(np.float32))
    
    current_patch = None
    if bg_regions:
        bg_plate = np.median(np.stack(bg_regions), axis=0).astype(np.uint8)
        current_patch = bg_plate
        print(f"Background plate ready from {len(bg_regions)} frames")

    # Stream frames - no storing all in memory
    print("Processing frames (streaming)...")
    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    out = cv2.VideoWriter(output_path, fourcc, fps, (width, height))
    
    prev_region = None
    change_threshold = 15
    frames_since_patch = 0
    patch_count = 0
    frame_idx = 0

    while True:
        ret, frame = cap.read()
        if not ret:
            break
        
        region = frame[py:py+ph, px:px+pw].astype(np.float32)
        needs_patch = False
        
        if prev_region is None:
            needs_patch = True
        else:
            diff = np.abs(region - prev_region).mean()
            if diff > change_threshold or frames_since_patch >= min_interval_frames:
                needs_patch = True
                if diff > change_threshold:
                    print(f"Scene change at frame {frame_idx} diff={diff:.1f}")
                else:
                    print(f"Interval patch at frame {frame_idx}")
        
        if needs_patch:
            try:
                frame_pil = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
                clean = lama(frame_pil, mask_pil)
                current_patch = cv2.cvtColor(np.array(clean)[py:py+ph, px:px+pw], cv2.COLOR_RGB2BGR)
                patch_count += 1
                print(f"LaMa patch {patch_count} at frame {frame_idx}")
            except Exception as e:
                print(f"LaMa error at frame {frame_idx}: {e}")
            frames_since_patch = 0
        else:
            frames_since_patch += 1
        
        if current_patch is not None:
            frame[py:py+ph, px:px+pw] = current_patch
        
        out.write(frame)
        prev_region = region
        frame_idx += 1
        
        if frame_idx % 50 == 0:
            print(f"Processed {frame_idx}/{total_frames}")
    
    cap.release()
    out.release()
    print(f"Done! {patch_count} LaMa patches for {frame_idx} frames")
    print(f"Output: {output_path}")

if __name__ == "__main__":
    try:
        video_path = sys.argv[1]
        output_path = sys.argv[2]
        x = float(sys.argv[3])
        y = float(sys.argv[4])
        w = float(sys.argv[5])
        h = float(sys.argv[6])
        inpaint_video(video_path, output_path, x, y, w, h)
    except Exception as e:
        print(f"FATAL ERROR: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
