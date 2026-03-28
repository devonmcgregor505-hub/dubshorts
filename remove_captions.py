import sys
import os
import cv2
import numpy as np
import easyocr
import tempfile
import subprocess
import shutil

def get_ffmpeg():
    for cmd in ['ffmpeg', '/usr/bin/ffmpeg']:
        if shutil.which(cmd):
            return cmd
    return 'ffmpeg'

FFMPEG = get_ffmpeg()

def extract_frames(video_path, out_dir):
    cmd = [FFMPEG, '-y', '-i', video_path, f'{out_dir}/%06d.png']
    subprocess.run(cmd, check=True, capture_output=True)

def get_video_info(video_path):
    import json
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
            return fps, s['width'], s['height']
    return 30.0, 1080, 1920

def detect_caption_regions(reader, frame, min_conf=0.4):
    results = reader.readtext(frame, paragraph=False, min_size=10)
    boxes = []
    for (bbox, text, conf) in results:
        if conf < min_conf or len(text.strip()) < 2:
            continue
        pts = np.array(bbox, dtype=np.int32)
        x1, y1 = pts[:, 0].min(), pts[:, 1].min()
        x2, y2 = pts[:, 0].max(), pts[:, 1].max()
        pad_x = int((x2 - x1) * 0.1)
        pad_y = int((y2 - y1) * 0.35)
        x1 = max(0, x1 - pad_x)
        y1 = max(0, y1 - pad_y)
        x2 = min(frame.shape[1], x2 + pad_x)
        y2 = min(frame.shape[0], y2 + pad_y)
        boxes.append((x1, y1, x2, y2))
    return boxes

def merge_boxes(boxes, gap=20):
    if not boxes:
        return []
    boxes = sorted(boxes, key=lambda b: b[1])
    merged = [list(boxes[0])]
    for b in boxes[1:]:
        last = merged[-1]
        if b[1] <= last[3] + gap and b[0] <= last[2] + gap and b[2] >= last[0] - gap:
            last[0] = min(last[0], b[0])
            last[1] = min(last[1], b[1])
            last[2] = max(last[2], b[2])
            last[3] = max(last[3], b[3])
        else:
            merged.append(list(b))
    return [tuple(b) for b in merged]

def build_caption_mask(frame_shape, boxes):
    h, w = frame_shape[:2]
    mask = np.zeros((h, w), dtype=np.uint8)
    for (x1, y1, x2, y2) in boxes:
        mask[y1:y2, x1:x2] = 255
    kernel = np.ones((12, 12), np.uint8)
    mask = cv2.dilate(mask, kernel, iterations=1)
    return mask

def to_numpy_bgr(result, reference_shape):
    """Convert LaMa result (PIL Image or numpy) to BGR numpy array for cv2."""
    if hasattr(result, 'mode'):
        # PIL Image
        arr = np.array(result)
        if arr.ndim == 2:
            arr = cv2.cvtColor(arr, cv2.COLOR_GRAY2BGR)
        elif arr.shape[2] == 4:
            arr = cv2.cvtColor(arr, cv2.COLOR_RGBA2BGR)
        elif arr.shape[2] == 3:
            arr = cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)
        return arr
    elif isinstance(result, np.ndarray):
        if result.ndim == 2:
            return cv2.cvtColor(result, cv2.COLOR_GRAY2BGR)
        if result.shape[2] == 4:
            return cv2.cvtColor(result, cv2.COLOR_RGBA2BGR)
        return result
    else:
        raise ValueError(f"Unknown LaMa output type: {type(result)}")

def main():
    if len(sys.argv) < 3:
        print("Usage: remove_captions.py <input_video> <output_video>")
        sys.exit(1)

    video_in = sys.argv[1]
    video_out = sys.argv[2]

    print("Loading EasyOCR...")
    reader = easyocr.Reader(['en'], gpu=False, verbose=False)

    print("Loading LaMa inpainter...")
    try:
        from simple_lama_inpainting import SimpleLama
        lama = SimpleLama()
        use_lama = True
        print("LaMa loaded successfully")
    except Exception as e:
        print(f"LaMa not available ({e}), using OpenCV inpaint fallback")
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

        print("Detecting caption regions from sample frames...")
        sample_indices = list(range(0, min(total, 30), 3))
        all_boxes = []
        for idx in sample_indices:
            frame_path = os.path.join(frames_dir, frame_files[idx])
            frame = cv2.imread(frame_path)
            if frame is None:
                continue
            boxes = detect_caption_regions(reader, frame)
            all_boxes.extend(boxes)

        if not all_boxes:
            print("No captions in sample, scanning more frames...")
            for idx in range(min(total, 100)):
                frame_path = os.path.join(frames_dir, frame_files[idx])
                frame = cv2.imread(frame_path)
                if frame is None:
                    continue
                boxes = detect_caption_regions(reader, frame, min_conf=0.25)
                all_boxes.extend(boxes)

        merged = merge_boxes(all_boxes, gap=30)
        print(f"Found {len(merged)} caption region(s): {merged}")

        if not merged:
            print("WARNING: No captions detected. Copying video as-is.")
            shutil.copy(video_in, video_out)
            return

        dummy = cv2.imread(os.path.join(frames_dir, frame_files[0]))
        static_mask = build_caption_mask(dummy.shape, merged)

        for i, fname in enumerate(frame_files):
            if i % 20 == 0:
                print(f"  Inpainting frame {i+1}/{total}...")

            frame_path = os.path.join(frames_dir, fname)
            frame = cv2.imread(frame_path)
            if frame is None:
                continue

            dynamic_boxes = detect_caption_regions(reader, frame, min_conf=0.3)
            dynamic_mask = build_caption_mask(frame.shape, dynamic_boxes)
            combined_mask = cv2.bitwise_or(static_mask, dynamic_mask)

            out_path = os.path.join(out_dir, fname)

            if combined_mask.max() == 0:
                cv2.imwrite(out_path, frame)
                continue

            if use_lama:
                # LaMa expects RGB PIL or numpy — give it RGB numpy
                frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                result_raw = lama(frame_rgb, combined_mask)
                result = to_numpy_bgr(result_raw, frame.shape)
            else:
                result = cv2.inpaint(frame, combined_mask, 5, cv2.INPAINT_TELEA)

            # Ensure correct dtype and shape before writing
            if result.dtype != np.uint8:
                result = np.clip(result, 0, 255).astype(np.uint8)
            if result.shape[:2] != frame.shape[:2]:
                result = cv2.resize(result, (frame.shape[1], frame.shape[0]))

            cv2.imwrite(out_path, result)

        print("Assembling output video...")
        temp_video = os.path.join(tmp, 'no_audio.mp4')
        subprocess.run([
            FFMPEG, '-y',
            '-framerate', str(fps),
            '-i', f'{out_dir}/%06d.png',
            '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
            '-pix_fmt', 'yuv420p',
            temp_video
        ], check=True, capture_output=True)

        # Merge original audio
        subprocess.run([
            FFMPEG, '-y',
            '-i', temp_video,
            '-i', video_in,
            '-map', '0:v:0', '-map', '1:a:0',
            '-c:v', 'copy', '-c:a', 'aac',
            '-shortest',
            video_out
        ], check=True, capture_output=True)

        print("Done!")

    finally:
        shutil.rmtree(tmp, ignore_errors=True)

if __name__ == '__main__':
    main()
