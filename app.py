import os
import tempfile
import whisper

from fastapi import FastAPI, UploadFile, File, HTTPException, Header

app = FastAPI()
model = whisper.load_model("tiny")

@app.get("/health")
def health():
    return {"ok": True}

@app.post("/transcribe")
async def transcribe(
    audio: UploadFile = File(...),
    authorization: str = Header(default="")
):
    expected = os.getenv("WHISPER_SECRET", "")
    if not expected or authorization != f"Bearer {expected}":
        raise HTTPException(status_code=401, detail="Unauthorized")

    suffix = os.path.splitext(audio.filename or "audio.webm")[1]
    path = None

    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as f:
            path = f.name
            while chunk := await audio.read(1024 * 1024):
                f.write(chunk)

        result = model.transcribe(path, language="hi", fp16=False)
        return {"text": result["text"].strip()}
    except Exception:
        raise HTTPException(status_code=500, detail="Transcription failed")
    finally:
        if path and os.path.exists(path):
            os.remove(path)
