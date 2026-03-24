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
    
    px = int(x * width)
    py = int(y * height)
    pw = int(w * width)
    ph = int(h * height)
    
    print(f"Video: {width}x{height} @ {fps}fps, {total_frames} frames")
    print(f"Mask region: {px},{py} {pw}x{ph}")
    
    # Create mask
    mask = np.zeros((height, width), dtype=np.uint8)
    mask[py:py+ph, px:px+pw] = 255
    mask_pil = Image.fromarray(mask)
    
    # PASS 1: Read all frames, detect scene changes in caption region
    print("Detecting scene changes...")
    frames = []
    prev_region = None
    change_threshold = 15  # mean pixel difference threshold
    
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        
        # Extract caption region
        region = frame[py:py+ph, px:px+pw].astype(np.float32)
        
        # Detect change
        needs_new_patch = False
        if prev_region is None:
            needs_new_patch = True  # first frame always needs patch
        else:
            diff = np.abs(region - prev_region).mean()
            if diff > change_threshold:
                needs_new_patch = True
                print(f"Scene change at frame {len(frames)} (diff={diff:.1f})")
        
        frames.append({'frame': frame, 'needs_patch': needs_new_patch})
        prev_region = region
    
    cap.release()
    print(f"Read {len(frames)} frames, generating patches for scene changes...")
    
    # PASS 2: Generate LaMa patches only for changed frames
    current_patch = None
    patch_count = 0
    
    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
    out = cv2.VideoWriter(output_path, fourcc, fps, (width, height))
    
    for i, f in enumerate(frames):
        frame = f['frame']
        
        if f['needs_patch']:
            # Run LaMa on this frame
            frame_pil = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
            clean = lama(frame_pil, mask_pil)
            current_patch = cv2.cvtColor(np.array(clean)[py:py+ph, px:px+pw], cv2.COLOR_RGB2BGR)
            patch_count += 1
            print(f"Patch {patch_count} generated at frame {i}")
        
        # Apply current patch
        if current_patch is not None:
            frame[py:py+ph, px:px+pw] = current_patch
        
        out.write(frame)
        
        if i % 30 == 0:
            print(f"Processed {i}/{len(frames)} frames")
    
    out.release()
    print(f"Done! {patch_count} patches used for {len(frames)} frames")
    print(f"Output: {output_path}")

if __name__ == "__main__":
    video_path = sys.argv[1]
    output_path = sys.argv[2]
    x = float(sys.argv[3])
    y = float(sys.argv[4])
    w = float(sys.argv[5])
    h = float(sys.argv[6])
    inpaint_video(video_path, output_path, x, y, w, h)
