import sys
import os
import json
import cv2
import numpy as np
import torch
import subprocess
import tempfile
import shutil

def main():
    video_in = sys.argv[1]
    video_out = sys.argv[2]
    box = json.loads(sys.argv[3])

    device = 'mps' if torch.backends.mps.is_available() else 'cpu'
    print(f'Using device: {device}')

    # Read video
    cap = cv2.VideoCapture(video_in)
    fps = cap.get(cv2.CAP_PROP_FPS)
    W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    print(f'Video: {W}x{H} {fps}fps {total} frames')

    # Convert box fractions to pixels
    bx = int(box['x'] * W)
    by = int(box['y'] * H)
    bw = int(box['w'] * W)
    bh = int(box['h'] * H)
    # Add padding
    pad = 8
    bx = max(0, bx - pad)
    by = max(0, by - pad)
    bw = min(W - bx, bw + pad*2)
    bh = min(H - by, bh + pad*2)
    print(f'Mask region: {bx},{by} {bw}x{bh}')

    # Work at 540p for speed
    scale = 540.0 / H if H > 540 else 1.0
    tW = int(W * scale) // 2 * 2
    tH = int(H * scale) // 2 * 2
    mbx = int(bx * scale)
    mby = int(by * scale)
    mbw = int(bw * scale)
    mbh = int(bh * scale)

    # Read all frames
    frames = []
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        frame = cv2.resize(frame, (tW, tH))
        frames.append(frame)
    cap.release()
    print(f'Read {len(frames)} frames')

    # Build mask
    mask = np.zeros((tH, tW), dtype=np.uint8)
    mask[mby:mby+mbh, mbx:mbx+mbw] = 255

    # Use ProPainter
    propainter_dir = os.path.join(os.path.dirname(__file__), 'ProPainter')
    sys.path.insert(0, propainter_dir)

    try:
        from model.propainter import InpaintGenerator
        from model.recurrent_flow_completion import RecurrentFlowCompleteNet
        from RAFT.raft import RAFT
        from utils.flow_util import flow_to_image
        import argparse

        weights_dir = os.path.join(propainter_dir, 'weights')

        print('Loading models...')
        # Load RAFT
        raft_args = argparse.Namespace(small=False, mixed_precision=False, alternate_corr=False)
        raft = RAFT(raft_args)
        raft_weights = torch.load(os.path.join(weights_dir, 'raft-things.pth'), map_location='cpu')
        raft_weights = {k.replace('module.', ''): v for k, v in raft_weights.items()}
        raft.load_state_dict(raft_weights)
        raft = raft.to(device).eval()

        # Load flow completion net
        fix_raft = RecurrentFlowCompleteNet()
        fix_weights = torch.load(os.path.join(weights_dir, 'recurrent_flow_completion.pth'), map_location='cpu')
        fix_raft.load_state_dict(fix_weights)
        fix_raft = fix_raft.to(device).eval()

        # Load ProPainter
        model = InpaintGenerator()
        model_weights = torch.load(os.path.join(weights_dir, 'ProPainter.pth'), map_location='cpu')
        model.load_state_dict(model_weights)
        model = model.to(device).eval()

        print('Models loaded, running inference...')

        # Run inference using ProPainter's own inference script
        tmpdir = tempfile.mkdtemp()
        frames_dir = os.path.join(tmpdir, 'frames')
        masks_dir = os.path.join(tmpdir, 'masks')
        os.makedirs(frames_dir)
        os.makedirs(masks_dir)

        for i, f in enumerate(frames):
            cv2.imwrite(os.path.join(frames_dir, f'{i:05d}.png'), f)
            cv2.imwrite(os.path.join(masks_dir, f'{i:05d}.png'), mask)

        result_dir = os.path.join(tmpdir, 'result')
        python = sys.executable
        script = os.path.join(propainter_dir, 'inference_propainter.py')
        cmd = [
            python, script,
            '--video', frames_dir,
            '--mask', masks_dir,
            '--output', result_dir,
            '--width', str(tW),
            '--height', str(tH),
            '--fp16',
        ]
        print('Running ProPainter inference...')
        ret = subprocess.run(cmd, capture_output=True, text=True, cwd=propainter_dir)
        print(ret.stdout[-500:] if ret.stdout else '')
        if ret.returncode != 0:
            print('ProPainter error:', ret.stderr[-500:])
            raise RuntimeError('ProPainter inference failed')

        # Find output frames
        out_frames_dir = os.path.join(result_dir, os.listdir(result_dir)[0], 'frames')
        if not os.path.exists(out_frames_dir):
            # try finding mp4
            for root, dirs, files in os.walk(result_dir):
                for fn in files:
                    if fn.endswith('.mp4'):
                        shutil.copy(os.path.join(root, fn), video_out)
                        print('Done (mp4 output)')
                        shutil.rmtree(tmpdir)
                        return

        out_files = sorted([f for f in os.listdir(out_frames_dir) if f.endswith('.png')])
        if not out_files:
            raise RuntimeError('No output frames found')

        # Write output video
        fourcc = cv2.VideoWriter_fourcc(*'mp4v')
        writer = cv2.VideoWriter(video_out, fourcc, fps, (tW, tH))
        for fn in out_files:
            frame = cv2.imread(os.path.join(out_frames_dir, fn))
            writer.write(frame)
        writer.release()
        shutil.rmtree(tmpdir)
        print(f'Done! Output: {video_out}')

    except Exception as e:
        print(f'ProPainter failed: {e}, falling back to LaMa')
        shutil.rmtree(tmpdir, ignore_errors=True)
        raise

if __name__ == '__main__':
    main()
