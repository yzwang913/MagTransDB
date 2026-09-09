FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=1999 \
    DATA_ROOT=/data \
    TMP_DIR=/app-tmp

WORKDIR /app

COPY web_show/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt \
    && useradd --create-home --uid 10001 appuser \
    && mkdir -p /app-tmp \
    && chown appuser:appuser /app-tmp

COPY --chown=appuser:appuser web_show/ /app/

USER appuser
EXPOSE 1999

CMD ["gunicorn", "--bind", "0.0.0.0:1999", "--workers", "2", "--threads", "4", "--timeout", "120", "--access-logfile", "-", "--error-logfile", "-", "app:create_app()"]
