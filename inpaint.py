import sys
import cv2
import numpy as np
from PIL import Image
from simple_lama_inpainting import SimpleLama

lama = SimpleLama()

def inpaint_video(video_path, output_path, x, y, w, h):
    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    # Work at 540p
    scale = 540 / height if height > 540 else 1.0
    work_w = int(width * scale) & ~1
    work_h = 540 if height > 540 else height

    dilation = 8
    px = max(0, int(x * work_w) - dilation)
    py = max(0, int(y * work_h) - dilation)
    pw = min(work_w - px, int(w * work_w) + dilation * 2)
    ph = min(work_h - py, int(h * work_h) + dilation * 2)

    print(f"Video: {width}x{height} @ {fps}fps, {total_frames} frames")
    print(f"Working at: {work_w}x{work_h}, mask: {px},{py} {pw}x{ph}")

    mask = np.zeros((work_h, work_w), dtype=np.uint8)
    mask[py:py+ph, px:px+pw] = 255
    mask_pil = Image.fromarray(mask)

    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    out = cv2.VideoWriter(output_path, fourcc, fps, (width, height))

    frame_idx = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break

        # Downscale to 540p
        small = cv2.resize(frame, (work_w, work_h), interpolation=cv2.INTER_AREA)

        # LaMa inpaint
        small_rgb = cv2.cvtColor(small, cv2.COLOR_BGR2RGB)
        small_pil = Image.fromarray(small_rgb)
        result_pil = lama(small_pil, mask_pil)

        # Upscale back to original resolution
        result = cv2.cvtColor(np.array(result_pil), cv2.COLOR_RGB2BGR)
        upscaled = cv2.resize(result, (width, height), interpolation=cv2.INTER_LANCZOS4)
        out.write(upscaled)

        frame_idx += 1
        if frame_idx % 50 == 0:
            print(f"Processed {frame_idx}/{total_frames}")

    cap.release()
    out.release()
    print(f"Done! {frame_idx} frames processed")

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
