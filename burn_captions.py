#!/usr/bin/env python3
import sys, os, json, subprocess, tempfile, shutil
from PIL import Image, ImageDraw, ImageFont

video_path = sys.argv[1]
ass_path = sys.argv[2]
output_path = sys.argv[3]
ffmpeg = sys.argv[4]

# Parse ASS dialogue lines
cues = []
with open(ass_path) as f:
    for line in f:
        if not line.startswith('Dialogue:'): continue
        parts = line.strip().split(',', 9)
        if len(parts) < 10: continue
        def t(s):
            h,m,rest = s.strip().split(':')
            sc,cs = rest.split('.')
            return int(h)*3600+int(m)*60+int(sc)+int(cs)/100
        start = t(parts[1])
        end = t(parts[2])
        text = parts[9].strip()
        if text: cues.append((start, end, text))

# Get video info
probe = subprocess.run([ffmpeg,'-i',video_path], capture_output=True, text=True)
info = probe.stderr
import re
dim = re.search(r'(\d{3,4})x(\d{3,4})', info)
fps_m = re.search(r'(\d+(?:\.\d+)?) fps', info)
dur_m = re.search(r'Duration: (\d+):(\d+):(\d+\.\d+)', info)
W = int(dim.group(1)) if dim else 1080
H = int(dim.group(2)) if dim else 1920
fps = float(fps_m.group(1)) if fps_m else 30.0
dur = 0
if dur_m: dur = int(dur_m.group(1))*3600+int(dur_m.group(2))*60+float(dur_m.group(3))

print(f"Video: {W}x{H} {fps}fps {dur:.1f}s", flush=True)

# Extract frames
frames_dir = tempfile.mkdtemp()
print("Extracting frames...", flush=True)
subprocess.run([ffmpeg,'-y','-i',video_path,'-vf',f'fps={fps}','-q:v','2',os.path.join(frames_dir,'frame%06d.jpg')], capture_output=True)

frames = sorted([f for f in os.listdir(frames_dir) if f.endswith('.jpg')])
print(f"Got {len(frames)} frames, burning captions...", flush=True)

font_size = max(20, int(H * 0.045))
try:
    font = ImageFont.truetype("/run/current-system/sw/share/X11/fonts/truetype/liberation/LiberationSans-Bold.ttf", font_size)
except:
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf", font_size)
    except:
        font = ImageFont.load_default()

for i, fname in enumerate(frames):
    t = i / fps
    cue = next((c for c in cues if c[0] <= t < c[1]), None)
    if not cue: continue
    img = Image.open(os.path.join(frames_dir, fname))
    draw = ImageDraw.Draw(img)
    text = cue[2]
    bbox = draw.textbbox((0,0), text, font=font)
    tw = bbox[2]-bbox[0]
    x = (W - tw) / 2
    y = H * 0.75
    # Outline
    for dx,dy in [(-2,-2),(-2,2),(2,-2),(2,2),(-2,0),(2,0),(0,-2),(0,2)]:
        draw.text((x+dx, y+dy), text, font=font, fill=(0,0,0))
    draw.text((x, y), text, font=font, fill=(255,255,255))
    img.save(os.path.join(frames_dir, fname), quality=92)

print("Reassembling video...", flush=True)
subprocess.run([ffmpeg,'-y','-framerate',str(fps),'-i',os.path.join(frames_dir,'frame%06d.jpg'),'-i',video_path,'-map','0:v','-map','1:a','-c:v','libx264','-preset','fast','-crf','23','-c:a','copy','-shortest',output_path], capture_output=True)
shutil.rmtree(frames_dir)
print("Done!", flush=True)
