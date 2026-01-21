#!/usr/bin/env python3
"""
Database migration module for kode-review semantic indexer.

This module handles schema creation and migration for the PostgreSQL database
with pgvector support. It ensures all required tables and indexes exist.
"""

import os
from pathlib import Path

import psycopg


def run_migration(conn: psycopg.Connection, schema_path: str | None = None) -> None:
    """
    Run the schema migration to ensure all tables and indexes exist.

    Args:
        conn: PostgreSQL connection
        schema_path: Optional path to schema.sql file. If None, uses the default
                     location relative to this file.
    """
    if schema_path is None:
        schema_path = str(Path(__file__).parent / "schema.sql")

    # Read the schema file
    with open(schema_path, "r") as f:
        schema_sql = f.read()

    # Execute the schema
    with conn.cursor() as cur:
        cur.execute(schema_sql)
    conn.commit()

    print("Schema migration completed successfully")


def ensure_schema(database_url: str | None = None) -> None:
    """
    Ensure the database schema is up to date.

    Args:
        database_url: PostgreSQL connection string. If None, reads from
                      COCOINDEX_DATABASE_URL environment variable.
    """
    if database_url is None:
        database_url = os.environ["COCOINDEX_DATABASE_URL"]

    conn = psycopg.connect(database_url)
    try:
        run_migration(conn)
    finally:
        conn.close()


if __name__ == "__main__":
    # Allow running as a standalone script
    ensure_schema()
