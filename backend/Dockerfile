FROM python:3.12-slim-bookworm AS dependencies

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

COPY requirements.txt .
COPY wheelhouse ./wheelhouse
RUN python -m pip install --no-cache-dir --no-index --find-links=./wheelhouse -r requirements.txt

FROM python:3.12-slim-bookworm AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

COPY --from=dependencies /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY --from=dependencies /usr/local/bin/uvicorn /usr/local/bin/uvicorn
COPY --from=dependencies /usr/local/bin/alembic /usr/local/bin/alembic
COPY --from=dependencies /usr/local/bin/pytest /usr/local/bin/pytest

COPY app ./app
COPY alembic.ini .
COPY alembic ./alembic
COPY tests ./tests

RUN groupadd --system --gid 10001 app \
    && useradd --system --uid 10001 --gid app --home-dir /app app

USER app
EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
