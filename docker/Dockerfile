FROM python:3.12-slim-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends libatomic1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY server/requirements.txt /app/server/requirements.txt
RUN pip install --no-cache-dir -r /app/server/requirements.txt

COPY server /app/server

ENV PYTHONPATH=/app
ENV PIPER_VOICES_DIR=/voices
ENV PIPER_DEFAULT_VOICE=en_US-lessac-medium

EXPOSE 8765

CMD ["uvicorn", "server.app.main:app", "--host", "0.0.0.0", "--port", "8765"]
