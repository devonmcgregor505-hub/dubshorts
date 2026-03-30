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
        "albumentations==1.2.1",  # pinned for lama compatibility
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
        video_in = os.path.join(tmp, "input.mp4")
        open(video_in, "wb").write(base64.b64decode(video_b64))
        probe = subprocess.run(["ffprobe","-v","quiet","-print_format","json","-show_streams",video_in], capture_output=True, text=True)
        info = json.loads(probe.stdout)
        fps, W, H = 30.0, 1080, 1920
        for s in info["streams"]:
            if s["codec_type"] == "video":
                n,d = s.get("r_frame_rate","30/1").split("/")
                fps=float(n)/float(d); W=int(s["width"]); H=int(s["height"]); break
        cap_fps = min(fps, 30)
        sW, sH = 960, 540
        ff = os.path.join(tmp, "frames"); os.makedirs(ff)
        subprocess.run(["ffmpeg","-y","-i",video_in,"-vf",f"fps={cap_fps},scale={sW}:{sH}",f"{ff}/%05d.png"], check=True, capture_output=True)
        frames = sorted([f for f in os.listdir(ff) if f.endswith(".png")])
        print(f"Extracted {len(frames)} frames")
        hx1=max(0,int(box["x"]*sW)); hy1=max(0,int(box["y"]*sH))
        hx2=min(sW,int((box["x"]+box["w"])*sW)); hy2=min(sH,int((box["y"]+box["h"])*sH))
        print("Running EasyOCR...")
        import easyocr
        reader = easyocr.Reader(['en'], gpu=torch.cuda.is_available())
        all_boxes = []
        for fname in frames[::10][:20]:
            img = cv2.imread(os.path.join(ff, fname))
            roi = img[hy1:hy2, hx1:hx2]
            if roi.size == 0: roi = img
            for (coords, text, conf) in reader.readtext(roi):
                if conf > 0.3:
                    xs=[int(c[0])+hx1 for c in coords]; ys=[int(c[1])+hy1 for c in coords]
                    all_boxes.append((min(xs),min(ys),max(xs),max(ys)))
        if not all_boxes: all_boxes=[(hx1,hy1,hx2,hy2)]
        pad=8
        rx1=max(0,min(b[0] for b in all_boxes)-pad); ry1=max(0,min(b[1] for b in all_boxes)-pad)
        rx2=min(sW,max(b[2] for b in all_boxes)+pad); ry2=min(sH,max(b[3] for b in all_boxes)+pad)
        mask_img=np.zeros((sH,sW),dtype=np.uint8); mask_img[ry1:ry2,rx1:rx2]=255
        mask_img=cv2.dilate(mask_img,np.ones((6,6),np.uint8),iterations=2)
        print("Loading LaMa...")
        from omegaconf import OmegaConf
        from saicinpainting.training.trainers import load_checkpoint
        import torch.serialization
        # Patch for PyTorch 2.6+ weights_only default change
        _orig_load = torch.load
        torch.load = lambda *a, **kw: _orig_load(*a, **{**kw, "weights_only": False})
        device=torch.device("cuda" if torch.cuda.is_available() else "cpu")
        train_config=OmegaConf.load("/app/lama_weights/big-lama/config.yaml")
        train_config.training_model.predict_only=True
        train_config.visualizer.kind="noop"
        model=load_checkpoint(train_config,"/app/lama_weights/big-lama/models/best.ckpt",strict=False,map_location=device)
        model.freeze(); model.to(device)
        # Pad dimensions to multiples of 8 for LaMa
        def pad_to_multiple(img, mult=8):
            h, w = img.shape[:2]
            ph = (mult - h % mult) % mult
            pw = (mult - w % mult) % mult
            if ph > 0 or pw > 0:
                img = cv2.copyMakeBorder(img, 0, ph, 0, pw, cv2.BORDER_REFLECT)
            return img, h, w

        print("Inpainting...")
        out_dir=os.path.join(tmp,"inpainted"); os.makedirs(out_dir)
        mask_f=mask_img.astype(np.float32)/255.0
        def pad8(x):
            h,w=x.shape[:2]; ph=(8-h%8)%8; pw=(8-w%8)%8
            return cv2.copyMakeBorder(x,0,ph,0,pw,cv2.BORDER_REFLECT),h,w

        for fname in frames:
            img=cv2.imread(os.path.join(ff,fname))
            ip,oh,ow=pad8(img); mp,_,_=pad8(mask_img)
            ir=cv2.cvtColor(ip,cv2.COLOR_BGR2RGB).astype(np.float32)/255.0
            mf=mp.astype(np.float32)/255.0
            batch={"image":torch.from_numpy(ir).permute(2,0,1).unsqueeze(0).to(device),"mask":torch.from_numpy(mf).unsqueeze(0).unsqueeze(0).to(device)}
            with torch.no_grad(): result=model(batch)
            out=result["inpainted"][0].permute(1,2,0).cpu().numpy()
            out=(out*255).clip(0,255).astype(np.uint8)[:oh,:ow]
            cv2.imwrite(os.path.join(out_dir,fname),cv2.cvtColor(out,cv2.COLOR_RGB2BGR))
        print("Assembling...")
        tv=os.path.join(tmp,"tmp.mp4"); vo=os.path.join(tmp,"out.mp4")
        subprocess.run(["ffmpeg","-y","-framerate",str(int(cap_fps)),"-i",f"{out_dir}/%05d.png","-vf",f"scale={W}:{H}","-c:v","libx264","-preset","fast","-crf","18","-pix_fmt","yuv420p",tv], check=True, capture_output=True)
        subprocess.run(["ffmpeg","-y","-i",tv,"-i",video_in,"-map","0:v:0","-map","1:a:0","-c:v","copy","-c:a","aac","-shortest",vo], check=True, capture_output=True)
        return JSONResponse({"video_base64": base64.b64encode(open(vo,"rb").read()).decode()})
    except Exception as e:
        import traceback
        return JSONResponse({"error": str(e)+"\n"+traceback.format_exc()}, status_code=500)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
