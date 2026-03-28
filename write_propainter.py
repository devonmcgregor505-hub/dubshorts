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
        print('ERROR: No box provided. Please draw a box over the captions first.')
        sys.exit(1)

    fps, W, H = get_video_info(video_in)
    print(f'Video: {W}x{H} @ {fps:.2f}fps')

    tmp = tempfile.mkdtemp()
    mask_dir = os.path.join(tmp, 'masks')
    output_dir = os.path.join(tmp, 'propainter_out')
    os.makedirs(mask_dir)
    os.makedirs(output_dir)

    try:
        # Get frame count
        cap = cv2.VideoCapture(video_in)
        frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        cap.release()
        print(f'Frame count: {frame_count}')

        # Build mask image once
        mask = build_mask_from_box(W, H, box)
        print(f'Mask region built')

        # Write same mask for every frame
        print('Writing masks...')
        for i in range(frame_count):
            mask_path = os.path.join(mask_dir, f'{i:05d}.png')
            cv2.imwrite(mask_path, mask)

        # Run ProPainter
        propainter_script = '/Users/kanemcgregor/dubshorts/ProPainter/inference_propainter.py'
        python = sys.executable

        print('Running ProPainter...')
        cmd = [
            python, propainter_script,
            '-i', video_in,
            '-m', mask_dir,
            '-o', output_dir,
            '--save_fps', str(int(min(fps, 30))),
            '--subvideo_length', '80',
            '--neighbor_length', '10',
            '--ref_stride', '10',
        ]

        result = subprocess.run(cmd, capture_output=False,
                                cwd='/Users/kanemcgregor/dubshorts/ProPainter')

        if result.returncode != 0:
            raise Exception('ProPainter failed')

        # Find output video
        out_video = None
        for root, dirs, files in os.walk(output_dir):
            for f in files:
                if f.endswith('.mp4'):
                    out_video = os.path.join(root, f)
                    break

        if not out_video:
            raise Exception('ProPainter produced no output video')

        print(f'ProPainter output: {out_video}')

        # Merge original audio back
        print('Merging audio...')
        subprocess.run([
            FFMPEG, '-y',
            '-i', out_video,
            '-i', video_in,
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
print('remove_captions.py written with ProPainter!')
