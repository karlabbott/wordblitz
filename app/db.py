import os
import pathlib

import psycopg2
import psycopg2.extras
from psycopg2.pool import SimpleConnectionPool

_pool: SimpleConnectionPool | None = None


def _get_pool() -> SimpleConnectionPool:
    global _pool
    if _pool is None:
        database_url = os.environ.get(
            'DATABASE_URL',
            'postgresql://wordblitz:wordblitz@localhost:5432/wordblitz',
        )
        _pool = SimpleConnectionPool(1, 10, database_url)
    return _pool


def get_db():
    """Get a connection from the pool."""
    return _get_pool().getconn()


def put_db(conn):
    """Return a connection to the pool."""
    _get_pool().putconn(conn)


def init_db():
    """Run schema.sql to initialise tables."""
    schema_path = pathlib.Path(__file__).resolve().parent.parent / 'db' / 'schema.sql'
    conn = get_db()
    try:
        with conn.cursor() as cur:
            cur.execute(schema_path.read_text())
        conn.commit()
    finally:
        put_db(conn)


def query_db(query, args=None, one=False):
    """Execute a SELECT query and return results as dicts."""
    conn = get_db()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(query, args)
            rows = cur.fetchall()
        conn.commit()
        if one:
            return dict(rows[0]) if rows else None
        return [dict(r) for r in rows]
    finally:
        put_db(conn)


def execute_db(query, args=None):
    """Execute an INSERT / UPDATE / DELETE and return affected row (if RETURNING)."""
    conn = get_db()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(query, args)
            try:
                result = cur.fetchone()
            except psycopg2.ProgrammingError:
                result = None
        conn.commit()
        return dict(result) if result else None
    finally:
        put_db(conn)
