# ── Backend Dockerfile ────────────────────────────────────────────────────────
# Multi-stage build: builder installs deps, runtime image is lean.
# Stage 1 — dependency installation (cached if requirements.txt unchanged)
FROM python:3.12-slim AS builder

WORKDIR /install

COPY requirements.txt .

# Install into an isolated prefix so we can copy only what we need
RUN pip install --no-cache-dir --prefix=/install/deps -r requirements.txt


# Stage 2 — final runtime image
FROM python:3.12-slim AS runtime

# Non-root user for security hardening
RUN addgroup --system appgroup && adduser --system --ingroup appgroup appuser

WORKDIR /app

# Copy installed packages from builder stage
COPY --from=builder /install/deps /usr/local

# Copy application source
# All runtime modules (tests are excluded via .dockerignore)
COPY *.py ./

# Drop to non-root
USER appuser

# Expose the port uvicorn will listen on
EXPOSE 8000

# Health-check: polls the /health endpoint every 30s.
# Render / Docker Compose will mark the container unhealthy if this fails 3x.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')"

# Start uvicorn (single worker — appropriate for Render free tier / demo).
# Set workers > 1 via the WEB_CONCURRENCY env var in production.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
