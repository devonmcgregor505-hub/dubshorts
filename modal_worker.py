import modal
from fastapi import Request
from fastapi.responses import JSONResponse

app = modal.App("dubshorts-caption-remover")

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "libgl1", "libglib2.0-0", "wget", "unzip", "git")
    .pip_install(
        "numpy==1.26.4",
        "opencv-python-headless",
        "easyocr",
        "scikit-image",
        "kornia",
        "easydict",
        "scikit-learn",
        "pandas",
        "omegaconf",
        "pytorch-lightning==1.9.5",
        "webdataset",
        "albumentations==1.2.1",
        "imgaug",
        "packaging",
        "requests",
        "fastapi",
        "python-multipart",
    )
    .run_commands(
        "git clone https://github.com/advimman/lama.git /app/lama",
        "sed -i 's/from albumentations import DualIAATransform, to_tuple/from albumentations.core.transforms_interface import DualTransform as DualIAATransform; to_tuple = lambda x, low: (low, x) if isinstance(x, (int, float)) else x/' /app/lama/saicinpainting/training/data/aug.py",
        "mkdir -p /app/lama_weights",
        "wget -q https://huggingface.co/smartywu/big-lama/resolve/main/big-lama.zip -O /tmp/big-lama.zip",
        "unzip /tmp/big-lama.zip -d /app/lama_weights/",
        "rm /tmp/big-lama.zip",
    )
)

BATCH_SIZE = 8  # frames per LaMa batch


@app.function(image=image, gpu="T4", timeout=600, memory=8192)
@modal.fastapi_endpoint(method="POST")
async def remove_captions(request: Request):
    import os, sys, cv2, numpy as np, tempfile, subprocess, shutil, base64, json
    import torch
    sys.path.insert(0, "/app/lama")

    body = await request.json()
    video_b64 = body.get("video_base64")
    box = body.get("box")

    if not video_b64 or not box:
        return JSONResponse({"error": "Missing video_base64 or box"}, status_code=400)

    tmp = tempfile.mkdtemp()

    try:
        # ── Write input video ────────────────────────────────────────────────
        video_in = os.path.join(tmp, "input.mp4")
        with open(video_in, "wb") as f:
            f.write(base64.b64decode(video_b64))

        # ── Probe video ──────────────────────────────────────────────────────
        probe = subprocess.run(
            ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_streams", video_in],
            capture_output=True, text=True
        )
        info = json.loads(probe.stdout)
        fps, W, H = 30.0, 1080, 1920
        for s in info["streams"]:
            if s["codec_type"] == "video":
                n, d = s.get("r_frame_rate", "30/1").split("/")
                fps = float(n) / float(d)
                W = int(s["width"])
                H = int(s["height"])
                break

        cap_fps = min(fps, 30)
        sW, sH = 960, 540

        # ── Extract frames at 540p ───────────────────────────────────────────
        ff = os.path.join(tmp, "frames")
        os.makedirs(ff)
        subprocess.run(
            ["ffmpeg", "-y", "-i", video_in,
             "-vf", f"fps={cap_fps},scale={sW}:{sH}",
             f"{ff}/%05d.png"],
            check=True, capture_output=True
        )
        frames = sorted([f for f in os.listdir(ff) if f.endswith(".png")])
        print(f"Extracted {len(frames)} frames at {sW}x{sH}")

        # ── Caption region pixel coords ──────────────────────────────────────
        hx1 = max(0, int(box["x"] * sW))
        hy1 = max(0, int(box["y"] * sH))
        hx2 = min(sW, int((box["x"] + box["w"]) * sW))
        hy2 = min(sH, int((box["y"] + box["h"]) * sH))
        print(f"Caption region: ({hx1},{hy1}) -> ({hx2},{hy2})")

        # ── EasyOCR — scan sample frames to find tight text bounds ──────────
        print("Running EasyOCR to find text bounds...")
        import easyocr
        reader = easyocr.Reader(['en'], gpu=torch.cuda.is_available())
        all_boxes = []

        for fname in frames[::5][:40]:
            img = cv2.imread(os.path.join(ff, fname))
            roi = img[hy1:hy2, hx1:hx2]
            if roi.size == 0:
                continue
            for (coords, text, conf) in reader.readtext(roi):
                if conf > 0.15:
                    xs = [int(c[0]) + hx1 for c in coords]
                    ys = [int(c[1]) + hy1 for c in coords]
                    all_boxes.append((min(xs), min(ys), max(xs), max(ys)))

        if not all_boxes:
            print("No text detected — using full user box")
            all_boxes = [(hx1, hy1, hx2, hy2)]

        # ── Build tight crop region with padding ─────────────────────────────
        pad = 15
        cx1 = max(0, min(b[0] for b in all_boxes) - pad)
        cy1 = max(0, min(b[1] for b in all_boxes) - pad)
        cx2 = min(sW, max(b[2] for b in all_boxes) + pad)
        cy2 = min(sH, max(b[3] for b in all_boxes) + pad)
        cW = cx2 - cx1
        cH = cy2 - cy1
        print(f"Crop region: ({cx1},{cy1}) -> ({cx2},{cy2}), size {cW}x{cH}")

        # ── Build mask for the crop region only ──────────────────────────────
        crop_mask = np.zeros((cH, cW), dtype=np.uint8)
        for b in all_boxes:
            bx1 = max(0, b[0] - cx1 - pad)
            by1 = max(0, b[1] - cy1 - pad)
            bx2 = min(cW, b[2] - cx1 + pad)
            by2 = min(cH, b[3] - cy1 + pad)
            crop_mask[by1:by2, bx1:bx2] = 255
        crop_mask = cv2.dilate(crop_mask, np.ones((8, 8), np.uint8), iterations=3)

        # ── Load LaMa ────────────────────────────────────────────────────────
        print("Loading LaMa model...")
        from omegaconf import OmegaConf
        from saicinpainting.training.trainers import load_checkpoint

        _orig_load = torch.load
        torch.load = lambda *a, **kw: _orig_load(*a, **{**kw, "weights_only": False})

        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        train_config = OmegaConf.load("/app/lama_weights/big-lama/config.yaml")
        train_config.training_model.predict_only = True
        train_config.visualizer.kind = "noop"
        model = load_checkpoint(
            train_config,
            "/app/lama_weights/big-lama/models/best.ckpt",
            strict=False,
            map_location=device
        )
        model.freeze()
        model.to(device)
        print(f"LaMa loaded on {device}")

        # ── Helper: pad to multiple of 8 ─────────────────────────────────────
        def pad8(x):
            h, w = x.shape[:2]
            ph = (8 - h % 8) % 8
            pw = (8 - w % 8) % 8
            return cv2.copyMakeBorder(x, 0, ph, 0, pw, cv2.BORDER_REFLECT), h, w

        # ── Pre-pad the mask once ─────────────────────────────────────────────
        mask_padded, mh, mw = pad8(crop_mask)
        mask_tensor = torch.from_numpy(
            mask_padded.astype(np.float32) / 255.0
        ).unsqueeze(0).unsqueeze(0).to(device)  # (1, 1, H, W)

        # ── Batch inpaint — crop region only ─────────────────────────────────
        print(f"Inpainting {len(frames)} frames in batches of {BATCH_SIZE}...")
        out_dir = os.path.join(tmp, "inpainted")
        os.makedirs(out_dir)

        # Read all full frames into memory list (paths only, load on demand)
        def inpaint_batch(batch_imgs, batch_fnames):
            crops = []
            orig_sizes = []
            for img in batch_imgs:
                crop = img[cy1:cy2, cx1:cx2]
                cp, oh, ow = pad8(crop)
                orig_sizes.append((oh, ow))
                cr = cv2.cvtColor(cp, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
                crops.append(torch.from_numpy(cr).permute(2, 0, 1))  # (3,H,W)

            # Stack into batch
            img_batch = torch.stack(crops, dim=0).to(device)  # (B,3,H,W)
            mask_batch = mask_tensor.expand(len(crops), -1, -1, -1)  # (B,1,H,W)

            with torch.no_grad():
                result = model({"image": img_batch, "mask": mask_batch})

            inpainted = result["inpainted"]  # (B,3,H,W)

            for i, (fname, img, (oh, ow)) in enumerate(zip(batch_fnames, batch_imgs, orig_sizes)):
                out_crop = inpainted[i].permute(1, 2, 0).cpu().numpy()
                out_crop = (out_crop * 255).clip(0, 255).astype(np.uint8)[:oh, :ow]
                out_crop_bgr = cv2.cvtColor(out_crop, cv2.COLOR_RGB2BGR)
                # Paste inpainted crop back into full frame
                full_out = img.copy()
                full_out[cy1:cy2, cx1:cx2] = out_crop_bgr
                cv2.imwrite(os.path.join(out_dir, fname), full_out)

        batch_imgs = []
        batch_fnames = []

        for i, fname in enumerate(frames):
            img = cv2.imread(os.path.join(ff, fname))
            batch_imgs.append(img)
            batch_fnames.append(fname)

            if len(batch_imgs) == BATCH_SIZE:
                inpaint_batch(batch_imgs, batch_fnames)
                batch_imgs = []
                batch_fnames = []
                print(f"  Batches done: {i+1}/{len(frames)}")

        # Process remaining frames
        if batch_imgs:
            inpaint_batch(batch_imgs, batch_fnames)
            print(f"  Final batch done: {len(frames)}/{len(frames)}")

        # ── Reassemble video ──────────────────────────────────────────────────
        print("Assembling final video...")
        tv = os.path.join(tmp, "tmp.mp4")
        vo = os.path.join(tmp, "out.mp4")

        subprocess.run([
            "ffmpeg", "-y",
            "-framerate", str(int(cap_fps)),
            "-i", f"{out_dir}/%05d.png",
            "-vf", f"scale={W}:{H}",
            "-c:v", "libx264", "-preset", "fast", "-crf", "18",
            "-pix_fmt", "yuv420p", tv
        ], check=True, capture_output=True)

        subprocess.run([
            "ffmpeg", "-y",
            "-i", tv, "-i", video_in,
            "-map", "0:v:0", "-map", "1:a:0",
            "-c:v", "copy", "-c:a", "aac", "-shortest", vo
        ], check=True, capture_output=True)

        print("Done! Encoding result...")
        with open(vo, "rb") as f:
            result_b64 = base64.b64encode(f.read()).decode()

        return JSONResponse({"video_base64": result_b64})

    except Exception as e:
        import traceback
        print("ERROR:", traceback.format_exc())
        return JSONResponse(
            {"error": str(e) + "\n" + traceback.format_exc()},
            status_code=500
        )

    finally:
        shutil.rmtree(tmp, ignore_errors=True)