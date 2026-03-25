import sys
import json
import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import os

def hex_to_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))

def draw_text_with_outline(draw, x, y, txt, font, text_color, outline_color, outline_w, shadow, font_size, img):
    # Shadow (blur-based to match canvas shadowBlur)
    if shadow > 0:
        blur_radius = max(1, int(shadow * font_size))
        offset_y = max(1, int(shadow * font_size * 0.3))
        shadow_layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
        shadow_draw = ImageDraw.Draw(shadow_layer)
        shadow_draw.text((x, y), txt, font=font, fill=(0, 0, 0, 230), anchor="mm")
        shadow_layer = shadow_layer.filter(ImageFilter.GaussianBlur(radius=blur_radius))
        img.paste(Image.new("RGBA", img.size, (0,0,0,0)), mask=shadow_layer)
        # Composite shadow onto image
        base = img.copy()
        shadow_shifted = Image.new("RGBA", img.size, (0, 0, 0, 0))
        shadow_shifted.paste(shadow_layer, (0, offset_y))
        img_rgba = img.convert("RGBA")
        img_rgba = Image.alpha_composite(img_rgba, shadow_shifted)
        img.paste(img_rgba.convert("RGB"))
        draw = ImageDraw.Draw(img)

    # Outline - use thick text trick for round outline like strokeText
    if outline_w > 0:
        for dx in range(-outline_w, outline_w + 1):
            for dy in range(-outline_w, outline_w + 1):
                if dx*dx + dy*dy <= outline_w*outline_w:
                    draw.text((x + dx, y + dy), txt, font=font, fill=outline_color, anchor="mm")

    # Main text
    draw.text((x, y), txt, font=font, fill=text_color, anchor="mm")
    return draw

def burn_captions(video_path, output_path, cues, style):
    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    y_pct = style.get("yPct", 70) / 100
    font_size_pct = style.get("fontSize", 5) / 100
    # Match preview: Math.round(H * fsp), min 8
    font_size = max(8, round(height * font_size_pct))
    text_color = hex_to_rgb(style.get("textColor", "#ffffff"))
    outline_color = hex_to_rgb(style.get("outlineColor", "#000000"))
    highlight_color = hex_to_rgb(style.get("highlightColor", "#f5e132"))
    # Match preview: outlineWidth is % of fontSize
    outline_w = max(0, round(font_size * style.get("outlineWidth", 15) / 100))
    text_case = style.get("textCase", "upper")
    caption_mode = style.get("captionMode", "single")
    shadow = style.get("shadowSize", 0)
    text_style = style.get("textStyle", "bold")
    # y is center of text, matching textBaseline='middle'
    y_pos = round(height * y_pct)

    # Load font - match textStyle (bold/italic/bold italic/normal)
    script_dir = os.path.dirname(os.path.abspath(__file__))
    font_paths = [
        os.path.join(script_dir, "DejaVuSans-Bold.ttf"),
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

    # Pre-build lines (15 char max per line, matching server buildChunk)
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

    tmp_output = output_path + ".tmp.mp4"
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    out = cv2.VideoWriter(tmp_output, fourcc, fps, (width, height))

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
            cx = width // 2

            if caption_mode == "single":
                word = active if active else line[0]
                txt = apply_case(word["text"])
                draw_text_with_outline(draw, cx, y_pos, txt, font,
                    text_color, outline_color, outline_w, shadow, font_size, img)

            else:
                # Multi-word: measure total width then draw word by word
                # matching preview: curX = W/2 - totalWidth/2
                words_txt = [apply_case(w["text"]) for w in line]
                spaces = [" " if i < len(line)-1 else "" for i in range(len(line))]
                widths = []
                for wt, sp in zip(words_txt, spaces):
                    bb = font.getbbox(wt + sp)
                    widths.append(bb[2] - bb[0])
                total_w = sum(widths)
                cur_x = cx - total_w // 2

                for wi, (w, wt, sp, ww) in enumerate(zip(line, words_txt, spaces, widths)):
                    is_active = (active and w["start"] == active["start"])
                    color = highlight_color if (caption_mode == "highlight" and is_active) else text_color
                    # Center of this word
                    word_cx = cur_x + ww // 2
                    draw_text_with_outline(draw, word_cx, y_pos, wt + sp, font,
                        color, outline_color, outline_w, shadow, font_size, img)
                    cur_x += ww

            frame = cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)

        out.write(frame)
        frame_idx += 1
        if frame_idx % 100 == 0:
            print(f"Captioned {frame_idx}/{total}", flush=True)

    cap.release()
    out.release()

    # Re-encode with ffmpeg to fix mp4v codec
    import subprocess
    subprocess.run([
        'ffmpeg', '-y', '-i', tmp_output,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
        '-pix_fmt', 'yuv420p', output_path
    ], check=True, capture_output=True)
    os.remove(tmp_output)
    print(f"Done! {frame_idx} frames", flush=True)

if __name__ == "__main__":
    video_path = sys.argv[1]
    output_path = sys.argv[2]
    cues = json.loads(sys.argv[3])
    style = json.loads(sys.argv[4])
    burn_captions(video_path, output_path, cues, style)
