#!/usr/bin/env python3
import cv2
import numpy as np
import sys
import os

def inpaint_caption(input_video, output_video, x, y, w, h):
    """Remove caption area using inpainting"""
    
    cap = cv2.VideoCapture(input_video)
    if not cap.isOpened():
        print(f"Error: Cannot open video {input_video}")
        return False
    
    # Get video properties
    fps = int(cap.get(cv2.CAP_PROP_FPS))
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    
    # Convert normalized coordinates to pixels
    x_px = int(x * width)
    y_px = int(y * height)
    w_px = int(w * width)
    h_px = int(h * height)
    
    # Create mask for the caption area
    mask = np.zeros((height, width), dtype=np.uint8)
    mask[y_px:y_px+h_px, x_px:x_px+w_px] = 255
    
    # Setup video writer
    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
    out = cv2.VideoWriter(output_video, fourcc, fps, (width, height))
    
    frame_count = 0
    print(f"Processing {total_frames} frames...")
    
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        
        # Apply inpainting
        result = cv2.inpaint(frame, mask, 3, cv2.INPAINT_TELEA)
        out.write(result)
        
        frame_count += 1
        if frame_count % 30 == 0:
            print(f"Processed {frame_count}/{total_frames} frames")
    
    cap.release()
    out.release()
    print(f"Completed! Saved to {output_video}")
    return True

if __name__ == "__main__":
    if len(sys.argv) != 7:
        print("Usage: python inpaint.py <input_video> <output_video> <x> <y> <w> <h>")
        sys.exit(1)
    
    input_video = sys.argv[1]
    output_video = sys.argv[2]
    x = float(sys.argv[3])
    y = float(sys.argv[4])
    w = float(sys.argv[5])
    h = float(sys.argv[6])
    
    success = inpaint_caption(input_video, output_video, x, y, w, h)
    sys.exit(0 if success else 1)
