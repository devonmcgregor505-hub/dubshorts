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

def build_mask_from_box(W, H, box):
    mask = np.zeros((H, W), dtype=np.uint8)
    x1 = max(0, int(box['x'] * W))
    y1 = max(0, int(box['y'] * H))
    x2 = min(W, int((box['x'] + box['w']) * W))
    y2 = min(H, int((box['y'] + box['h']) * H))
    mask[y1:y2, x1:x2] = 255
    kernel = np.ones((8, 8), np.uint8)
    return cv2.dilate(mask, kernel, iterations=1)

def main():
    if len(sys.argv) < 3:
        print('Usage: remove_captions.py <input> <output> [box_json]')
        sys.exit(1)

    video_in = sys.argv[1]
    video_out = sys.argv[2]
    box = json.loads(sys.argv[3]) if len(sys.argv) > 3 else None

    if not box:
        print('ERROR: No box provided.')
        sys.exit(1)

    fps, W, H = get_video_info(video_in)
    print(f'Video: {W}x{H} @ {fps:.2f}fps')
    cap_fps = min(fps, 30)

    tmp = tempfile.mkdtemp()
    frames_dir = os.path.join(tmp, 'frames')
    mask_dir = os.path.join(tmp, 'masks')
    output_dir = os.path.join(tmp, 'propainter_out')
    os.makedirs(frames_dir)
    os.makedirs(mask_dir)
    os.makedirs(output_dir)

    try:
        # Extract frames at 360p
        print('Extracting frames...')
        subprocess.run([
            FFMPEG, '-y', '-i', video_in,
            '-vf', f'fps={cap_fps},scale=-2:360',
            f'{frames_dir}/%05d.png'
        ], check=True, capture_output=True)

        frame_files = sorted([f for f in os.listdir(frames_dir) if f.endswith('.png')])
        frame_count = len(frame_files)
        print(f'Extracted {frame_count} frames')

        # Build mask at scaled resolution
        dummy = cv2.imread(os.path.join(frames_dir, frame_files[0]))
        sH, sW = dummy.shape[:2]
        mask = build_mask_from_box(sW, sH, box)

        # Write masks
        print('Writing masks...')
        for fname in frame_files:
            cv2.imwrite(os.path.join(mask_dir, fname), mask)

        # Run ProPainter
        propainter_script = '/Users/kanemcgregor/dubshorts/ProPainter/inference_propainter.py'
        python = sys.executable

        print('Running ProPainter...')
        cmd = [
            python, propainter_script,
            '-i', frames_dir,
            '-m', mask_dir,
            '-o', output_dir,
            '--save_fps', str(int(cap_fps)),
            '--subvideo_length', '20',
            '--neighbor_length', '5',
            '--ref_stride', '10',
            '--fp16',
        ]

        result = subprocess.run(cmd, cwd='/Users/kanemcgregor/dubshorts/ProPainter')

        if result.returncode != 0:
            raise Exception('ProPainter failed')

        # Find inpaint_out.mp4
        out_video = None
        for root, dirs, files in os.walk(output_dir):
            for f in files:
                if f == 'inpaint_out.mp4':
                    out_video = os.path.join(root, f)

        if not out_video:
            raise Exception('inpaint_out.mp4 not found in output')

        print(f'Found output: {out_video}')

        # Upscale to original resolution and merge audio
        print('Upscaling to 1080p and merging audio...')
        subprocess.run([
            FFMPEG, '-y',
            '-i', out_video,
            '-i', video_in,
            '-map', '0:v:0', '-map', '1:a:0',
            '-vf', f'scale={W}:{H}',
            '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
            '-c:a', 'aac', '-shortest',
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
print('Done!')
