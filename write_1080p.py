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

def main():
    if len(sys.argv) < 3:
        print('Usage: remove_captions.py <input> <o> [box_json]')
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

    # Caption box pixel coords at full 1080p
    x1 = max(0, int(box['x'] * W))
    y1 = max(0, int(box['y'] * H))
    x2 = min(W, int((box['x'] + box['w']) * W))
    y2 = min(H, int((box['y'] + box['h']) * H))
    # Add padding
    pad = 20
    rx1 = max(0, x1 - pad)
    ry1 = max(0, y1 - pad)
    rx2 = min(W, x2 + pad)
    ry2 = min(H, y2 + pad)
    rW = rx2 - rx1
    rH = ry2 - ry1
    print(f'Caption region: ({rx1},{ry1}) -> ({rx2},{ry2}) = {rW}x{rH}px')

    tmp = tempfile.mkdtemp()
    full_frames_dir = os.path.join(tmp, 'full_frames')    # full 1080p frames
    crop_frames_dir = os.path.join(tmp, 'crop_frames')    # cropped caption region
    mask_dir = os.path.join(tmp, 'masks')                 # masks for crop
    output_dir = os.path.join(tmp, 'propainter_out')      # ProPainter output
    final_frames_dir = os.path.join(tmp, 'final_frames')  # composited final frames
    os.makedirs(full_frames_dir)
    os.makedirs(crop_frames_dir)
    os.makedirs(mask_dir)
    os.makedirs(output_dir)
    os.makedirs(final_frames_dir)

    try:
        # Extract full 1080p frames
        print('Extracting full 1080p frames...')
        subprocess.run([
            FFMPEG, '-y', '-i', video_in,
            '-vf', f'fps={cap_fps}',
            f'{full_frames_dir}/%05d.png'
        ], check=True, capture_output=True)

        frame_files = sorted([f for f in os.listdir(full_frames_dir) if f.endswith('.png')])
        frame_count = len(frame_files)
        print(f'Extracted {frame_count} frames at full 1080p')

        # Crop caption region from each frame and save at 540p
        print('Cropping caption regions at 540p...')
        scale = 0.5
        cW = int(rW * scale)
        cH = int(rH * scale)
        # Make divisible by 8 for ProPainter
        cW = cW + (8 - cW % 8) if cW % 8 != 0 else cW
        cH = cH + (8 - cH % 8) if cH % 8 != 0 else cH

        # Build mask at crop resolution
        # The box within the crop
        mx1 = int((x1 - rx1) * scale)
        my1 = int((y1 - ry1) * scale)
        mx2 = int((x2 - rx1) * scale)
        my2 = int((y2 - ry1) * scale)
        mx1 = max(0, mx1)
        my1 = max(0, my1)
        mx2 = min(cW, mx2)
        my2 = min(cH, my2)
        mask = np.zeros((cH, cW), dtype=np.uint8)
        mask[my1:my2, mx1:mx2] = 255
        kernel = np.ones((8, 8), np.uint8)
        mask = cv2.dilate(mask, kernel, iterations=1)

        for fname in frame_files:
            full_frame = cv2.imread(os.path.join(full_frames_dir, fname))
            # Crop region
            crop = full_frame[ry1:ry2, rx1:rx2]
            # Downscale to 540p
            small = cv2.resize(crop, (cW, cH), interpolation=cv2.INTER_AREA)
            cv2.imwrite(os.path.join(crop_frames_dir, fname), small)
            cv2.imwrite(os.path.join(mask_dir, fname), mask)

        # Run ProPainter on the crop only
        propainter_script = '/Users/kanemcgregor/dubshorts/ProPainter/inference_propainter.py'
        python = sys.executable

        print(f'Running ProPainter on {cW}x{cH} caption crop...')
        cmd = [
            python, propainter_script,
            '-i', crop_frames_dir,
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
            raise Exception('inpaint_out.mp4 not found')

        print(f'ProPainter done: {out_video}')

        # Extract inpainted crop frames
        inpainted_dir = os.path.join(tmp, 'inpainted_crops')
        os.makedirs(inpainted_dir)
        subprocess.run([
            FFMPEG, '-y', '-i', out_video,
            f'{inpainted_dir}/%05d.png'
        ], check=True, capture_output=True)

        inpainted_files = sorted([f for f in os.listdir(inpainted_dir) if f.endswith('.png')])
        print(f'Got {len(inpainted_files)} inpainted crop frames')

        # Composite: paste inpainted crop back onto full 1080p frames
        print('Compositing back onto 1080p frames...')
        for i, fname in enumerate(frame_files):
            full_frame = cv2.imread(os.path.join(full_frames_dir, fname))

            if i < len(inpainted_files):
                inp_fname = inpainted_files[i]
                inp_crop_small = cv2.imread(os.path.join(inpainted_dir, inp_fname))
                # Upscale inpainted crop back to original region size
                inp_crop = cv2.resize(inp_crop_small, (rW, rH), interpolation=cv2.INTER_LANCZOS4)
                # Paste back onto full frame
                full_frame[ry1:ry2, rx1:rx2] = inp_crop

            cv2.imwrite(os.path.join(final_frames_dir, fname), full_frame)

        # Assemble final 1080p video
        print('Assembling final 1080p video...')
        temp_video = os.path.join(tmp, 'no_audio.mp4')
        subprocess.run([
            FFMPEG, '-y',
            '-framerate', str(int(cap_fps)),
            '-i', f'{final_frames_dir}/%05d.png',
            '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
            '-pix_fmt', 'yuv420p',
            temp_video
        ], check=True, capture_output=True)

        # Merge original audio
        print('Merging audio...')
        subprocess.run([
            FFMPEG, '-y',
            '-i', temp_video,
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
print('Done!')
