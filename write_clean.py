content = r'''import sys
import os
import cv2
import numpy as np
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

def get_video_info(video_path):
    r = subprocess.run([
        'ffprobe', '-v', 'quiet', '-print_format', 'json', '-show_streams', video_path
    ], capture_output=True, text=True)
    info = json.loads(r.stdout)
    for s in info['streams']:
        if s['codec_type'] == 'video':
            num, den = s.get('r_frame_rate', '30/1').split('/')
            return float(num)/float(den), int(s['width']), int(s['height'])
    return 30.0, 1080, 1920

def extract_frames(video_path, out_dir, src_fps=30):
    cap_fps = min(src_fps, 30)
    subprocess.run([
        FFMPEG, '-y', '-i', video_path,
        '-vf', f'fps={cap_fps}',
        f'{out_dir}/%06d.png'
    ], check=True, capture_output=True)

def build_mask_from_box(frame_shape, box):
    h, w = frame_shape[:2]
    mask = np.zeros((h, w), dtype=np.uint8)
    x1 = max(0, int(box['x'] * w))
    y1 = max(0, int(box['y'] * h))
    x2 = min(w, int((box['x'] + box['w']) * w))
    y2 = min(h, int((box['y'] + box['h']) * h))
    mask[y1:y2, x1:x2] = 255
    kernel = np.ones((6, 6), np.uint8)
    return cv2.dilate(mask, kernel, iterations=1), (x1, y1, x2, y2)

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
        raise ValueError(f'Unknown type: {type(result)}')
    if arr.dtype != np.uint8:
        arr = np.clip(arr, 0, 255).astype(np.uint8)
    if arr.shape[:2] != ref_shape[:2]:
        arr = cv2.resize(arr, (ref_shape[1], ref_shape[0]))
    return arr

def main():
    if len(sys.argv) < 3:
        print('Usage: remove_captions.py <input> <output> [box_json]')
        sys.exit(1)

    video_in = sys.argv[1]
    video_out = sys.argv[2]
    box = json.loads(sys.argv[3]) if len(sys.argv) > 3 else None

    if not box:
        print('ERROR: No box provided. Please draw a box over the captions first.')
        sys.exit(1)

    print('Loading LaMa inpainter...')
    try:
        from simple_lama_inpainting import SimpleLama
        lama = SimpleLama()
        use_lama = True
        print('LaMa loaded')
    except Exception as e:
        print(f'LaMa unavailable ({e}), using OpenCV fallback')
        use_lama = False

    fps, W, H = get_video_info(video_in)
    print(f'Video: {W}x{H} @ {fps:.2f}fps')

    tmp = tempfile.mkdtemp()
    frames_dir = os.path.join(tmp, 'frames')
    out_dir = os.path.join(tmp, 'out')
    os.makedirs(frames_dir)
    os.makedirs(out_dir)

    try:
        print('Extracting frames...')
        extract_frames(video_in, frames_dir, fps)
        frame_files = sorted([f for f in os.listdir(frames_dir) if f.endswith('.png')])
        total = len(frame_files)
        print(f'{total} frames to process')

        # Build mask from box
        dummy = cv2.imread(os.path.join(frames_dir, frame_files[0]))
        mask, box_coords = build_mask_from_box(dummy.shape, box)
        x1, y1, x2, y2 = box_coords
        print(f'Caption region: ({x1},{y1}) -> ({x2},{y2})')

        # Downscale mask once for reuse
        h, w = dummy.shape[:2]
        sw, sh = w // 2, h // 2
        small_mask = cv2.resize(mask, (sw, sh), interpolation=cv2.INTER_NEAREST)
        _, small_mask = cv2.threshold(small_mask, 127, 255, cv2.THRESH_BINARY)

        print('Inpainting every frame at 540p...')
        for i, fname in enumerate(frame_files):
            if i % 20 == 0:
                print(f'  Frame {i+1}/{total}...')

            frame = cv2.imread(os.path.join(frames_dir, fname))
            if frame is None:
                continue

            out_path = os.path.join(out_dir, fname)

            # Check if caption region has content worth inpainting
            roi = frame[y1:y2, x1:x2]
            if roi.std() < 6:
                cv2.imwrite(out_path, frame)
                continue

            if use_lama:
                # Downscale to 540p, inpaint, upscale back
                small_frame = cv2.resize(frame, (sw, sh), interpolation=cv2.INTER_AREA)
                frame_rgb = cv2.cvtColor(small_frame, cv2.COLOR_BGR2RGB)
                result_raw = lama(frame_rgb, small_mask)
                result_small = to_numpy_bgr(result_raw, small_frame.shape)
                result = cv2.resize(result_small, (w, h), interpolation=cv2.INTER_LANCZOS4)
            else:
                result = cv2.inpaint(frame, mask, 5, cv2.INPAINT_TELEA)

            cv2.imwrite(out_path, result)

        print('Assembling video...')
        temp_video = os.path.join(tmp, 'no_audio.mp4')
        subprocess.run([
            FFMPEG, '-y', '-framerate', str(min(fps, 30)),
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

        print('Done!')

    finally:
        shutil.rmtree(tmp, ignore_errors=True)

if __name__ == '__main__':
    main()
'''

with open('/Users/kanemcgregor/dubshorts/caption-remover/remove_captions.py', 'w') as f:
    f.write(content)
print('Done! Clean version written.')
