# syntax=docker/dockerfile:1
# faster-whisper transcription service (CPU). Multi-arch: python base images
# ship amd64 + arm64; faster-whisper/ctranslate2 wheels cover both.
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

# Model downloads on first boot into this cache volume-friendly path
ENV HF_HOME=/models WHISPER_MODEL=small
EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
