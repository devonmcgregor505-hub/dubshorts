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
    
    # Convert percentage coords to pixels
    px = int(x * width)
    py = int(y * height)
    pw = int(w * width)
    ph = int(h * height)
    
    print(f"Video: {width}x{height} @ {fps}fps, {total_frames} frames")
    print(f"Mask region: {px},{py} {pw}x{ph}")
    
    # Create mask (white = remove, black = keep)
    mask = np.zeros((height, width), dtype=np.uint8)
    mask[py:py+ph, px:px+pw] = 255
    mask_pil = Image.fromarray(mask)
    
    # Get first frame clean patch from LaMa
    ret, first_frame = cap.read()
    if not ret:
        print("ERROR: Could not read first frame")
        sys.exit(1)
    
    first_pil = Image.fromarray(cv2.cvtColor(first_frame, cv2.COLOR_BGR2RGB))
    print("Running LaMa inpainting on first frame...")
    clean_first = lama(first_pil, mask_pil)
    clean_patch = np.array(clean_first)[py:py+ph, px:px+pw]
    print("Got clean patch!")
    
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
        frame[py:py+ph, px:px+pw] = cv2.cvtColor(clean_patch, cv2.COLOR_RGB2BGR)
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
