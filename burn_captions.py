#!/usr/bin/env python3
import sys, os, json, subprocess, shutil
import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

def hex_to_rgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))

def apply_case(text, case):
    if case == 'upper': return text.upper()
    if case == 'lower': return text.lower()
    return text

def build_lines(words, max_chars=15):
    """Group words into lines, max_chars per line."""
    lines = []
    current = []
    current_len = 0
    for w in words:
        txt = w['text']
        if current and current_len + len(txt) + 1 > max_chars:
            lines.append(current)
            current = [w]
            current_len = len(txt)
        else:
            current.append(w)
            current_len += len(txt) + (1 if current_len > 0 else 0)
    if current:
        lines.append(current)
    return lines

def get_active_line(lines, t):
    """Return the line that is currently being spoken."""
    for line in lines:
        start = line[0]['start']
        end = line[-1]['end']
        if start <= t <= end + 0.15:
            return line
    return None

def draw_frame_caption(frame, line, t, font, fs, ww, wh,
                        text_color, outline_color, outline_w,
                        text_case, caption_mode, highlight_color,
                        y_pct, shadow_size):
    img = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
    draw = ImageDraw.Draw(img)
    cy = int(wh * y_pct)

    words_txt = [apply_case(w['text'], text_case) for w in line]

    # Measure total line width
    spaces = len(words_txt) - 1
    word_widths = [int(font.getlength(t)) for t in words_txt]
    space_w = int(font.getlength(' '))
    total_w = sum(word_widths) + spaces * space_w

    cx = (ww - total_w) // 2

    for i, (word, txt, wlen) in enumerate(zip(line, words_txt, word_widths)):
        is_active = (caption_mode == 'highlight' and word['start'] <= t <= word['end'] + 0.05)
        color = highlight_color if is_active else text_color
        wx = cx + wlen // 2

        # shadow
        if shadow_size > 0:
            off = int(fs * shadow_size * 0.3)
            draw.text((wx, cy + off), txt, font=font, fill=(0, 0, 0, 180), anchor='mm')

        # outline
        for dx in range(-outline_w, outline_w + 1):
            for dy in range(-outline_w, outline_w + 1):
                if dx*dx + dy*dy <= outline_w * outline_w:
                    draw.text((wx + dx, cy + dy), txt, font=font, fill=outline_color, anchor='mm')

        # text
        draw.text((wx, cy), txt, font=font, fill=color, anchor='mm')
        cx += wlen + space_w

    return cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)

def main():
    video_in   = sys.argv[1]
    video_out  = sys.argv[2]
    words_json = sys.argv[3]
    style_json = sys.argv[4]

    words = json.loads(words_json)
    style = json.loads(style_json)

    cap    = cv2.VideoCapture(video_in)
    fps    = cap.get(cv2.CAP_PROP_FPS)
    width  = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total  = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration = total / fps if fps > 0 else 0

    # Dynamic work resolution
    if duration <= 10:
        WORK_H = 720
    elif duration <= 30:
        WORK_H = 560
    else:
        WORK_H = 480

    scale = WORK_H / height if height > WORK_H else 1.0
    ww = int(width * scale)
    wh = int(height * scale)

    # Style
    fs           = max(10, int(wh * float(style.get('fontSize', 4)) / 100))
    text_color   = hex_to_rgb(style.get('textColor', '#ffffff'))
    outline_color = hex_to_rgb(style.get('outlineColor', '#000000'))
    outline_w    = max(1, int(fs * float(style.get('outlineWidth', 15)) / 100))
    text_case    = style.get('textCase', 'upper')
    caption_mode = style.get('captionMode', 'highlight')
    highlight_color = hex_to_rgb(style.get('highlightColor', '#f5e132'))
    y_pct        = float(style.get('yPct', 70)) / 100
    shadow_size  = float(style.get('shadowSize', 0))

    font_family = style.get('fontFamily', 'CaptionFont')
    font_map = {
        'Impact': 'fonts/Impact.ttf',
        'Anton': 'fonts/Anton-Regular.ttf',
        'BebasNeue': 'fonts/BebasNeue-Regular.ttf',
        'Oswald': 'fonts/Oswald-Bold.ttf',
        'BarlowCondensed': 'fonts/BarlowCondensed-Bold.ttf',
        'FjallaOne': 'fonts/FjallaOne-Regular.ttf',
        'Roboto': 'fonts/Roboto-Bold.ttf',
        'Poppins': 'fonts/Poppins-Bold.ttf',
        'Lato': 'fonts/Lato-Bold.ttf',
        'Ubuntu': 'fonts/Ubuntu-Bold.ttf',
        'Bangers': 'fonts/Bangers-Regular.ttf',
        'Pacifico': 'fonts/Pacifico-Regular.ttf',
        'PermanentMarker': 'fonts/PermanentMarker-Regular.ttf',
        'Righteous': 'fonts/Righteous-Regular.ttf',
        'Montserrat': 'fonts/Montserrat-Bold.ttf',
        'CaptionFont': 'DejaVuSans-Bold.ttf',
    }
    font_file = font_map.get(font_family, 'DejaVuSans-Bold.ttf')
    font_path = os.path.join(os.path.dirname(__file__), font_file)
    try:
        font = ImageFont.truetype(font_path, fs)
    except:
        font = ImageFont.load_default()

    lines = build_lines(words, max_chars=15)
    print(f"Built {len(lines)} lines from {len(words)} words", flush=True)

    ffmpeg = shutil.which('ffmpeg') or '/opt/homebrew/bin/ffmpeg'
    proc = subprocess.Popen([
        ffmpeg, '-y',
        '-f', 'rawvideo', '-vcodec', 'rawvideo',
        '-s', f'{width}x{height}',
        '-pix_fmt', 'bgr24',
        '-r', str(fps),
        '-i', 'pipe:0',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        video_out
    ], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

    idx = 0
    print(f"Burning captions: {width}x{height} @ {fps}fps work={ww}x{wh}", flush=True)

    while True:
        ret, frame = cap.read()
        if not ret:
            break

        t = idx / fps
        small = cv2.resize(frame, (ww, wh))
        line = get_active_line(lines, t)
        if line:
            small = draw_frame_caption(small, line, t, font, fs, ww, wh,
                                        text_color, outline_color, outline_w,
                                        text_case, caption_mode, highlight_color,
                                        y_pct, shadow_size)
        out_frame = cv2.resize(small, (width, height))

        try:
            proc.stdin.write(out_frame.tobytes())
        except BrokenPipeError:
            break

        idx += 1
        if idx % 30 == 0:
            print(f"  {idx}/{total} frames", flush=True)

    cap.release()
    try:
        proc.stdin.close()
    except:
        pass
    proc.wait()

    if os.path.exists(video_out) and os.path.getsize(video_out) > 10000:
        print(f"Done — {idx} frames → {video_out}", flush=True)
    else:
        stderr = proc.stderr.read().decode(errors='replace')
        raise RuntimeError(f'FFmpeg failed: {stderr[-400:]}')

if __name__ == '__main__':
    main()
