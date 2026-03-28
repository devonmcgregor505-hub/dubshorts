content = r'''import sys
import os
import cv2
import numpy as np
import easyocr
import tempfile
import subprocess
import shutil
import json

def get_ffmpeg():
    for cmd in ['/opt/homebrew/bin/ffmpeg', 'ffmpeg', '/usr/bin/ffmpeg']:
        if shutil.which(cmd):
            return cmd
    return 'ffmpeg'

FFMPEG = get_ffmpeg()

def extract_frames(video_path, out_dir):
    cmd = [FFMPEG, '-y', '-i', video_path, f'{out_dir}/%06d.png']
    subprocess.run(cmd, check=True, capture_output=True)

def get_video_info(video_path):
    r = subprocess.run([
        'ffprobe', '-v', 'quiet', '-print_format', 'json',
        '-show_streams', video_path
    ], capture_output=True, text=True)
    info = json.loads(r.stdout)
    for s in info['streams']:
        if s['codec_type'] == 'video':
            fps_str = s.get('r_frame_rate', '30/1')
            num, den = fps_str.split('/')
            fps = float(num) / float(den)
            return fps, int(s['width']), int(s['height'])
    return 30.0, 1080, 1920

def build_static_mask(frame_shape, box):
    """Build mask directly from user-drawn box (normalized 0-1 coords)."""
    h, w = frame_shape[:2]
    mask = np.zeros((h, w), dtype=np.uint8)
    x1 = max(0, int(box['x'] * w))
    y1 = max(0, int(box['y'] * h))
    x2 = min(w, int((box['x'] + box['w']) * w))
    y2 = min(h, int((box['y'] + box['h']) * h))
    mask[y1:y2, x1:x2] = 255
    # Small dilation to catch edges
    kernel = np.ones((6, 6), np.uint8)
    mask = cv2.dilate(mask, kernel, iterations=1)
    print(f"  Mask region: ({x1},{y1}) -> ({x2},{y2})")
    return mask

def detect_in_region(reader, frame, box):
    """Run OCR only inside the user box, return mask."""
    h, w = frame.shape[:2]
    x1 = max(0, int(box['x'] * w))
    y1 = max(0, int(box['y'] * h))
    x2 = min(w, int((box['x'] + box['w']) * w))
    y2 = min(h, int((box['y'] + box['h']) * h))
    roi = frame[y1:y2, x1:x2]
    if roi.size == 0:
        return np.zeros((h, w), dtype=np.uint8)
    results = reader.readtext(roi, paragraph=False, min_size=8)
    mask = np.zeros((h, w), dtype=np.uint8)
    for (bbox, text, conf) in results:
        if conf < 0.3 or len(text.strip()) < 1:
            continue
        pts = np.array(bbox, dtype=np.int32)
        rx1, ry1 = pts[:, 0].min() + x1, pts[:, 1].min() + y1
        rx2, ry2 = pts[:, 0].max() + x1, pts[:, 1].max() + y1
        pad_y = int((ry2 - ry1) * 0.3)
        mask[max(0,ry1-pad_y):min(h,ry2+pad_y), max(0,rx1):min(w,rx2)] = 255
    kernel = np.ones((8, 8), np.uint8)
    mask = cv2.dilate(mask, kernel, iterations=1)
    return mask

def to_numpy_bgr(result, ref_shape):
    if hasattr(result, 'mode'):
        arr = np.array(result)
        if arr.ndim == 2:
            arr = cv2.cvtColor(arr, cv2.COLOR_GRAY2BGR)
        elif arr.shape[2] == 4:
            arr = cv2.cvtColor(arr, cv2.COLOR_RGBA2BGR)
        elif arr.shape[2] == 3:
            arr = cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)
    elif isinstance(result, np.ndarray):
        arr = result.copy()
        if arr.ndim == 2:
            arr = cv2.cvtColor(arr, cv2.COLOR_GRAY2BGR)
        elif arr.shape[2] == 4:
            arr = cv2.cvtColor(arr, cv2.COLOR_RGBA2BGR)
        else:
            arr = arr
    else:
        raise ValueError(f"Unknown type: {type(result)}")
    if arr.dtype != np.uint8:
        arr = np.clip(arr, 0, 255).astype(np.uint8)
    if arr.shape[:2] != ref_shape[:2]:
        arr = cv2.resize(arr, (ref_shape[1], ref_shape[0]))
    return arr

def main():
    if len(sys.argv) < 3:
        print("Usage: remove_captions.py <input_video> <output_video> [box_json]")
        sys.exit(1)

    video_in = sys.argv[1]
    video_out = sys.argv[2]
    box = json.loads(sys.argv[3]) if len(sys.argv) > 3 else None

    use_box = box is not None
    print(f"Mode: {'box-guided' if use_box else 'full-frame OCR'}")

    print("Loading EasyOCR...")
    reader = easyocr.Reader(['en'], gpu=False, verbose=False)

    print("Loading LaMa inpainter...")
    try:
        from simple_lama_inpainting import SimpleLama
        lama = SimpleLama()
        use_lama = True
        print("LaMa loaded successfully")
    except Exception as e:
        print(f"LaMa unavailable ({e}), using OpenCV fallback")
        use_lama = False

    fps, W, H = get_video_info(video_in)
    print(f"Video: {W}x{H} @ {fps:.2f}fps")

    tmp = tempfile.mkdtemp()
    frames_dir = os.path.join(tmp, 'frames')
    out_dir = os.path.join(tmp, 'out_frames')
    os.makedirs(frames_dir)
    os.makedirs(out_dir)

    try:
        print("Extracting frames...")
        extract_frames(video_in, frames_dir)

        frame_files = sorted([f for f in os.listdir(frames_dir) if f.endswith('.png')])
        total = len(frame_files)
        print(f"Processing {total} frames...")

        # Build static mask from box (skip OCR detection phase entirely if box given)
        dummy = cv2.imread(os.path.join(frames_dir, frame_files[0]))

        if use_box:
            print("Using user-drawn box as mask region...")
            static_mask = build_static_mask(dummy.shape, box)
            use_dynamic_ocr = False
        else:
            print("Running OCR detection on sample frames...")
            from remove_captions import detect_caption_regions, merge_boxes, build_caption_mask
            sample_indices = list(range(0, min(total, 20), 2))
            all_boxes = []
            for idx in sample_indices:
                frame = cv2.imread(os.path.join(frames_dir, frame_files[idx]))
                if frame is not None:
                    all_boxes.extend(detect_caption_regions(reader, frame))
            merged = merge_boxes(all_boxes, gap=30)
            print(f"Found {len(merged)} region(s)")
            if not merged:
                print("No captions detected, copying as-is")
                shutil.copy(video_in, video_out)
                return
            static_mask = build_caption_mask(dummy.shape, merged)
            use_dynamic_ocr = True

        print("Inpainting frames...")
        for i, fname in enumerate(frame_files):
            if i % 10 == 0:
                print(f"  Frame {i+1}/{total}...")

            frame = cv2.imread(os.path.join(frames_dir, fname))
            if frame is None:
                continue

            out_path = os.path.join(out_dir, fname)

            # If box mode, just use static mask — no per-frame OCR needed
            if use_box:
                mask = static_mask
            else:
                # Dynamic OCR only in box region if we have one
                dyn = detect_in_region(reader, frame, box) if box else static_mask
                mask = cv2.bitwise_or(static_mask, dyn)

            if mask.max() == 0:
                cv2.imwrite(out_path, frame)
                continue

            if use_lama:
                frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                result_raw = lama(frame_rgb, mask)
                result = to_numpy_bgr(result_raw, frame.shape)
            else:
                result = cv2.inpaint(frame, mask, 5, cv2.INPAINT_TELEA)

            if not isinstance(result, np.ndarray):
                result = np.array(result)
            if result.dtype != np.uint8:
                result = np.clip(result, 0, 255).astype(np.uint8)

            cv2.imwrite(out_path, result)

        print("Assembling video...")
        temp_video = os.path.join(tmp, 'no_audio.mp4')
        subprocess.run([
            FFMPEG, '-y', '-framerate', str(fps),
            '-i', f'{out_dir}/%06d.png',
            '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
            '-pix_fmt', 'yuv420p', temp_video
        ], check=True, capture_output=True)

        subprocess.run([
            FFMPEG, '-y',
            '-i', temp_video, '-i', video_in,
            '-map', '0:v:0', '-map', '1:a:0',
            '-c:v', 'copy', '-c:a', 'aac', '-shortest',
            video_out
        ], check=True, capture_output=True)

        print("Done!")

    finally:
        shutil.rmtree(tmp, ignore_errors=True)

if __name__ == '__main__':
    main()
'''

with open('/Users/kanemcgregor/dubshorts/caption-remover/remove_captions.py', 'w') as f:
    f.write(content)
print('remove_captions.py written!')
