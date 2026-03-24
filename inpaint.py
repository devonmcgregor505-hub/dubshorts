import sys
import cv2
import numpy as np

def inpaint_video(video_path, output_path, x, y, w, h):
    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    
    dilation = 8
    px = max(0, int(x * width) - dilation)
    py = max(0, int(y * height) - dilation)
    pw = min(width - px, int(w * width) + dilation * 2)
    ph = min(height - py, int(h * height) + dilation * 2)
    
    print(f"Video: {width}x{height} @ {fps}fps, {total_frames} frames")
    print(f"Mask region: {px},{py} {pw}x{ph}")
    
    mask = np.zeros((height, width), dtype=np.uint8)
    mask[py:py+ph, px:px+pw] = 255
    
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    out = cv2.VideoWriter(output_path, fourcc, fps, (width, height))
    
    frame_idx = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        inpainted = cv2.inpaint(frame, mask, 3, cv2.INPAINT_TELEA)
        out.write(inpainted)
        frame_idx += 1
        if frame_idx % 50 == 0:
            print(f"Processed {frame_idx}/{total_frames}")
    
    cap.release()
    out.release()
    print(f"Done! {frame_idx} frames processed")
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
