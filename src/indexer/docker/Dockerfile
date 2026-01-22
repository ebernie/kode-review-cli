FROM python:3.11-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first for better caching
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY main.py .
COPY indexer.py .
COPY import_graph.py .
COPY call_graph.py .
COPY ast_chunker.py .
COPY bm25.py .
COPY hybrid.py .
COPY incremental.py .
COPY cocoindex_flow.py .
COPY config_parser.py .
COPY migrate.py .
COPY verify_export.py .
COPY schema.sql .

# Expose the API port
EXPOSE 8000

# Health check for API mode
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')" || exit 1

# Default: Run the FastAPI server (API mode)
# For indexing, override with: python indexer.py
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
