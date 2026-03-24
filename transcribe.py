import sys
import json
import whisper

def transcribe(audio_path, lang=None):
    model = whisper.load_model("base")
    opts = {}
    if lang and lang != 'none':
        opts['language'] = lang
    result = model.transcribe(audio_path, word_timestamps=True, **opts)
    cues = []
    for seg in result['segments']:
        cues.append({
            'start': seg['start'],
            'end': seg['end'],
            'text': seg['text'].strip()
        })
    print(json.dumps(cues))

if __name__ == '__main__':
    audio_path = sys.argv[1]
    lang = sys.argv[2] if len(sys.argv) > 2 else None
    transcribe(audio_path, lang)
