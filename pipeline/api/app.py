"""FastAPI app: read-only endpoints for the web UI.

    uv run --env-file .env uvicorn pipeline.api.app:app

Only GET routes exist, and every connection is opened read-only, so nothing
here can write to the database. Merge review and undo stay in the CLI.
"""

from __future__ import annotations

from typing import Annotated

import psycopg
from fastapi import Depends, FastAPI, HTTPException, Query

from pipeline.api import queries, signals
from pipeline.api.signals import get_conn

app = FastAPI(title="flock", docs_url="/api/docs", openapi_url="/api/openapi.json")
app.include_router(signals.router)

Conn = Annotated[psycopg.Connection, Depends(get_conn)]


@app.get("/api/summary")
def summary(conn: Conn) -> dict:
    return queries.summary(conn)


@app.get("/api/tags")
def tags() -> list[dict]:
    return queries.tags()


@app.get("/api/recent")
def recent(conn: Conn, limit: Annotated[int, Query(ge=1, le=200)] = 70) -> list[dict]:
    return queries.recent(conn, limit)


@app.get("/api/graph")
def graph(conn: Conn, days: int = 90) -> dict:
    if days not in (0, 30, 90, 365):
        raise HTTPException(422, "days must be 30, 90, 365, or 0 for everything on record")
    return queries.graph(conn, days)


@app.get("/api/orgs/{org_id}")
def org(conn: Conn, org_id: int) -> dict:
    found = queries.org(conn, org_id)
    if found is None:
        raise HTTPException(404, "organization not found")
    return found


@app.get("/api/search")
def search(conn: Conn, q: Annotated[str, Query(max_length=100)] = "") -> list[dict]:
    return queries.search(conn, q)


@app.get("/api/digest")
def digest(conn: Conn) -> dict:
    return queries.digest(conn)
