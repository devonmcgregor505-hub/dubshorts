import sys
import json
import warnings
warnings.filterwarnings("ignore")
import whisper

def transcribe(audio_path, lang=None):
    model = whisper.load_model("base")
    opts = {"word_timestamps": True, "fp16": False}
    if lang and lang not in ("none", "en"):
        opts["language"] = lang
    result = model.transcribe(audio_path, **opts)
    cues = []
    for seg in result["segments"]:
        words = seg.get("words", [])
        if words:
            for w in words:
                cues.append({"start": round(w["start"],3), "end": round(w["end"],3), "text": w["word"].strip()})
        else:
            cues.append({"start": round(seg["start"],3), "end": round(seg["end"],3), "text": seg["text"].strip()})
    print(json.dumps(cues))

if __name__ == "__main__":
    audio_path = sys.argv[1]
    lang = sys.argv[2] if len(sys.argv) > 2 else None
    transcribe(audio_path, lang)
