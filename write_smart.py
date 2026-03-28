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

def extract_frames(video_path, out_dir):
    subprocess.run([FFMPEG, '-y', '-i', video_path, f'{out_dir}/%06d.png'],
                   check=True, capture_output=True)

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

def get_roi_hash(frame, box_coords):
    """Hash just the caption region to detect changes."""
    x1, y1, x2, y2 = box_coords
    roi = frame[y1:y2, x1:x2]
    # Resize to tiny for fast comparison
    small = cv2.resize(roi, (32, 16), interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    # Simple hash: quantize to 8 levels
    quantized = (gray // 32).tobytes()
    return quantized

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
        extract_frames(video_in, frames_dir)
        frame_files = sorted([f for f in os.listdir(frames_dir) if f.endswith('.png')])
        total = len(frame_files)
        print(f'{total} frames total')

        # Build mask from box
        dummy = cv2.imread(os.path.join(frames_dir, frame_files[0]))
        mask, box_coords = build_mask_from_box(dummy.shape, box)
        x1, y1, x2, y2 = box_coords
        print(f'Caption region: ({x1},{y1}) -> ({x2},{y2})')

        # ── SMART MODE: group frames by caption content ──
        print('Analyzing caption changes...')
        frame_hashes = []
        for fname in frame_files:
            frame = cv2.imread(os.path.join(frames_dir, fname))
            if frame is None:
                frame_hashes.append(None)
                continue
            h = get_roi_hash(frame, box_coords)
            frame_hashes.append(h)

        # Group consecutive frames with same hash
        # Format: [(hash, [frame_indices])]
        groups = []
        i = 0
        while i < len(frame_hashes):
            if frame_hashes[i] is None:
                i += 1
                continue
            current_hash = frame_hashes[i]
            group_indices = [i]
            j = i + 1
            while j < len(frame_hashes):
                if frame_hashes[j] is None:
                    j += 1
                    continue
                # Allow small tolerance - if hash is identical, same group
                if frame_hashes[j] == current_hash:
                    group_indices.append(j)
                    j += 1
                else:
                    break
            groups.append((current_hash, group_indices))
            i = j

        unique_count = len(groups)
        print(f'Found {unique_count} unique caption states (vs {total} total frames)')
        print(f'Will only inpaint {unique_count} frames instead of {total} — {(1-unique_count/total)*100:.0f}% speedup!')

        # Inpaint one representative frame per group, copy to all in group
        inpainted_cache = {}  # hash -> inpainted frame

        for g_idx, (h, indices) in enumerate(groups):
            if g_idx % 10 == 0 or g_idx == unique_count - 1:
                print(f'  Inpainting unique frame {g_idx+1}/{unique_count}...')

            rep_idx = indices[len(indices)//2]  # use middle frame as representative
            rep_fname = frame_files[rep_idx]
            frame = cv2.imread(os.path.join(frames_dir, rep_fname))

            if frame is None:
                continue

            # Check if caption region is blank/dark (no caption present)
            roi = frame[y1:y2, x1:x2]
            roi_mean = roi.mean()
            roi_std = roi.std()

            # If region is very uniform (no text), skip inpainting
            if roi_std < 8:
                inpainted = frame.copy()
            elif use_lama:
                frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                result_raw = lama(frame_rgb, mask)
                inpainted = to_numpy_bgr(result_raw, frame.shape)
            else:
                inpainted = cv2.inpaint(frame, mask, 5, cv2.INPAINT_TELEA)

            inpainted_cache[h] = inpainted

        # Write all frames
        print('Writing output frames...')
        for i, fname in enumerate(frame_files):
            out_path = os.path.join(out_dir, fname)
            h = frame_hashes[i]
            if h is not None and h in inpainted_cache:
                cv2.imwrite(out_path, inpainted_cache[h])
            else:
                # Copy original
                frame = cv2.imread(os.path.join(frames_dir, fname))
                if frame is not None:
                    cv2.imwrite(out_path, frame)

        print('Assembling video...')
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

        print('Done!')

    finally:
        shutil.rmtree(tmp, ignore_errors=True)

if __name__ == '__main__':
    main()
'''

with open('/Users/kanemcgregor/dubshorts/caption-remover/remove_captions.py', 'w') as f:
    f.write(content)
print('remove_captions.py written successfully!')
