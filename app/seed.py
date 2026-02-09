"""Seed the words table from db.words."""

import sys
import pathlib

# Ensure project root is on the path so we can import db.words
project_root = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(project_root))

from db.words import WORDS
from app.db import get_db, put_db, init_db


def seed_words():
    """Insert all words into the words table, skipping duplicates."""
    init_db()
    conn = get_db()
    try:
        with conn.cursor() as cur:
            for word in WORDS:
                cur.execute(
                    'INSERT INTO words (word) VALUES (%s) ON CONFLICT DO NOTHING',
                    (word.lower(),),
                )
        conn.commit()
        print(f'Seeded {len(WORDS)} words.')
    finally:
        put_db(conn)


if __name__ == '__main__':
    seed_words()
