#!/usr/bin/env python3
import sys, json, cv2, numpy as np
import easyocr

def detect_subtitle_box(video_path, sample_frames=5, padding=0.02):
    reader = easyocr.Reader(['en'], gpu=False, verbose=False)
    cap = cv2.VideoCapture(video_path)
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    sample_positions = [int(total * i / sample_frames) for i in range(sample_frames)]

    all_boxes = []
    for pos in sample_positions:
        cap.set(cv2.CAP_PROP_POS_FRAMES, pos)
        ret, frame = cap.read()
        if not ret:
            continue
        crop_y = int(h * 0.6)
        crop = frame[crop_y:, :]
        results = reader.readtext(crop)
        for (bbox, text, conf) in results:
            if conf < 0.3 or len(text.strip()) < 2:
                continue
            xs = [p[0] for p in bbox]
            ys = [p[1] for p in bbox]
            all_boxes.append({
                'x': min(xs) / w,
                'y': (min(ys) + crop_y) / h,
                'x2': max(xs) / w,
                'y2': (max(ys) + crop_y) / h,
            })

    cap.release()

    if not all_boxes:
        return {"x": 0.05, "y": 0.82, "w": 0.90, "h": 0.13}

    x1 = max(0,   min(b['x']  for b in all_boxes) - padding)
    y1 = max(0,   min(b['y']  for b in all_boxes) - padding)
    x2 = min(1,   max(b['x2'] for b in all_boxes) + padding)
    y2 = min(1,   max(b['y2'] for b in all_boxes) + padding)

    return {"x": round(x1,4), "y": round(y1,4), "w": round(x2-x1,4), "h": round(y2-y1,4)}

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No video path provided"}))
        sys.exit(1)
    result = detect_subtitle_box(sys.argv[1])
    print(json.dumps(result))
