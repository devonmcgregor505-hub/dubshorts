import sys
import json
import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont
import os

def hex_to_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))

def burn_captions(video_path, output_path, cues, style):
    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    y_pct = style.get("yPct", 70) / 100
    font_size_pct = style.get("fontSize", 5) / 100
    font_size = max(10, int(height * font_size_pct))
    text_color = hex_to_rgb(style.get("textColor", "#ffffff"))
    outline_color = hex_to_rgb(style.get("outlineColor", "#000000"))
    highlight_color = hex_to_rgb(style.get("highlightColor", "#fbff00"))
    outline_w = max(1, int(font_size * style.get("outlineWidth", 15) / 100))
    text_case = style.get("textCase", "upper")
    caption_mode = style.get("captionMode", "single")
    y_pos = int(height * y_pct)

    # Load font
    font_paths = [
        "/app/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
    ]
    font = None
    for fp in font_paths:
        if os.path.exists(fp):
            try:
                font = ImageFont.truetype(fp, font_size)
                break
            except:
                pass
    if font is None:
        font = ImageFont.load_default()

    # Pre-build lines (15 char max)
    lines = []
    i = 0
    while i < len(cues):
        line = []
        chars = 0
        while i < len(cues):
            w = cues[i]
            wl = len(w["text"])
            if line and chars + 1 + wl > 15:
                break
            line.append(w)
            chars += (0 if not line else 1) + wl
            i += 1
        if line:
            lines.append(line)

    def get_line_for_time(t):
        for line in lines:
            if line[0]["start"] <= t < line[-1]["end"]:
                return line
        return None

    def get_active_word(line, t):
        for w in line:
            if w["start"] <= t < w["end"]:
                return w
        return None

    def apply_case(txt):
        if text_case == "upper": return txt.upper()
        if text_case == "lower": return txt.lower()
        return txt

    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    out = cv2.VideoWriter(output_path, fourcc, fps, (width, height))

    frame_idx = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        t = frame_idx / fps
        line = get_line_for_time(t)
        if line:
            active = get_active_word(line, t)
            img = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
            draw = ImageDraw.Draw(img)

            if caption_mode == "single":
                word = active if active else line[0]
                txt = apply_case(word["text"])
                bbox = draw.textbbox((0, 0), txt, font=font)
                tw = bbox[2] - bbox[0]
                x = (width - tw) // 2
                y = y_pos - font_size // 2
                for dx, dy in [(-outline_w,0),(outline_w,0),(0,-outline_w),(0,outline_w),
                                (-outline_w,-outline_w),(outline_w,-outline_w),(-outline_w,outline_w),(outline_w,outline_w)]:
                    draw.text((x+dx, y+dy), txt, font=font, fill=outline_color)
                draw.text((x, y), txt, font=font, fill=text_color)
            else:
                # Multi-word or highlight - draw all words in line
                words_txt = [apply_case(w["text"]) for w in line]
                full = " ".join(words_txt)
                bbox = draw.textbbox((0, 0), full, font=font)
                tw = bbox[2] - bbox[0]
                x = (width - tw) // 2
                y = y_pos - font_size // 2
                # Draw each word individually for highlight
                cx = x
                for wi, w in enumerate(line):
                    txt = apply_case(w["text"])
                    space = " " if wi < len(line)-1 else ""
                    is_active = (active and w["start"] == active["start"])
                    color = highlight_color if (caption_mode == "highlight" and is_active) else text_color
                    for dx, dy in [(-outline_w,0),(outline_w,0),(0,-outline_w),(0,outline_w),
                                    (-outline_w,-outline_w),(outline_w,-outline_w),(-outline_w,outline_w),(outline_w,outline_w)]:
                        draw.text((cx+dx, y+dy), txt+space, font=font, fill=outline_color)
                    draw.text((cx, y), txt+space, font=font, fill=color)
                    wb = draw.textbbox((0,0), txt+space, font=font)
                    cx += wb[2] - wb[0]

            frame = cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)

        out.write(frame)
        frame_idx += 1
        if frame_idx % 100 == 0:
            print(f"Captioned {frame_idx}/{total}", flush=True)

    cap.release()
    out.release()
    print(f"Done! {frame_idx} frames", flush=True)

if __name__ == "__main__":
    video_path = sys.argv[1]
    output_path = sys.argv[2]
    cues = json.loads(sys.argv[3])
    style = json.loads(sys.argv[4])
    burn_captions(video_path, output_path, cues, style)
