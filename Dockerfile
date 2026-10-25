FROM python:3.12-slim

LABEL org.opencontainers.image.title="Kongo" \
      org.opencontainers.image.description="Live stats for a Linux server, in the style of Windows Task Manager" \
      org.opencontainers.image.source="https://github.com/bassidus/kongo"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8090

WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app

CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --no-access-log"]
