#!/usr/bin/env python3
"""
Schema-level integration tests for the kode-review indexer.

These tests run against a real Postgres + pgvector database. They are skipped
unless COCOINDEX_DATABASE_URL (or DATABASE_URL) points at a database where
schema.sql can be applied. The connection string must already have the
`vector` and `uuid-ossp` extensions installed (or be a superuser-capable
URL so `CREATE EXTENSION` can run).

Run with: python -m pytest test_schema.py -v

The tests pin three behaviors documented in the schema migration:

1. `files` has a composite (file_path, repo_id, branch) primary key, so the
   same path on different repos/branches coexists instead of overwriting.
2. Composite FKs cascade-delete chunks and file_imports correctly when a
   `files` row is removed.
3. The DELETE /index endpoint's deletion strategy (DELETE FROM files +
   DELETE FROM code_embeddings) clears every canonical and legacy table.
"""

import os
import unittest
from pathlib import Path

try:
    import psycopg
    PSYCOPG_AVAILABLE = True
except ImportError:
    PSYCOPG_AVAILABLE = False


DB_URL = os.environ.get("COCOINDEX_DATABASE_URL") or os.environ.get("DATABASE_URL")
SCHEMA_PATH = Path(__file__).parent / "schema.sql"


def _has_db() -> bool:
    return PSYCOPG_AVAILABLE and bool(DB_URL)


def _apply_schema(conn) -> None:
    """Apply schema.sql to a fresh database."""
    with open(SCHEMA_PATH) as f:
        sql = f.read()
    with conn.cursor() as cur:
        cur.execute(sql)
    conn.commit()


def _drop_test_tables(conn) -> None:
    """Tear down tables created by schema.sql so the next test starts clean.

    Drops in reverse dependency order to avoid FK constraint errors.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            DROP TABLE IF EXISTS relationships CASCADE;
            DROP TABLE IF EXISTS file_imports CASCADE;
            DROP TABLE IF EXISTS chunks CASCADE;
            DROP TABLE IF EXISTS files CASCADE;
            DROP TABLE IF EXISTS embedding_cache CASCADE;
            DROP TABLE IF EXISTS code_embeddings CASCADE;
            DROP FUNCTION IF EXISTS update_files_updated_at() CASCADE;
            DROP FUNCTION IF EXISTS update_chunks_tsv() CASCADE;
            DROP FUNCTION IF EXISTS code_to_tsvector(TEXT) CASCADE;
            """
        )
    conn.commit()


@unittest.skipUnless(_has_db(), "Requires COCOINDEX_DATABASE_URL (or DATABASE_URL) and psycopg")
class SchemaCompositeKeyTests(unittest.TestCase):
    """Verify the composite PK on files and the cascading FKs that depend on it."""

    @classmethod
    def setUpClass(cls):
        cls.conn = psycopg.connect(DB_URL)

    @classmethod
    def tearDownClass(cls):
        _drop_test_tables(cls.conn)
        cls.conn.close()

    def setUp(self):
        # Clear any aborted-transaction state left behind by a failing test;
        # without this, _drop_test_tables would error on the shared connection.
        self.conn.rollback()
        _drop_test_tables(self.conn)
        _apply_schema(self.conn)

    def test_fresh_schema_files_pk_is_composite(self):
        """A freshly-applied schema yields a 3-column PK on files."""
        with self.conn.cursor() as cur:
            cur.execute(
                """
                SELECT kcu.column_name
                FROM information_schema.table_constraints tc
                JOIN information_schema.key_column_usage kcu
                  ON tc.constraint_name = kcu.constraint_name
                WHERE tc.table_name = 'files'
                  AND tc.constraint_type = 'PRIMARY KEY'
                ORDER BY kcu.ordinal_position
                """
            )
            cols = [row[0] for row in cur.fetchall()]
        self.assertEqual(cols, ["file_path", "repo_id", "branch"])

    def test_chunks_fk_is_composite(self):
        """The chunks→files FK references all three columns of the new PK."""
        with self.conn.cursor() as cur:
            cur.execute(
                """
                SELECT kcu.column_name
                FROM information_schema.table_constraints tc
                JOIN information_schema.key_column_usage kcu
                  ON tc.constraint_name = kcu.constraint_name
                WHERE tc.table_name = 'chunks'
                  AND tc.constraint_type = 'FOREIGN KEY'
                ORDER BY kcu.ordinal_position
                """
            )
            cols = [row[0] for row in cur.fetchall()]
        self.assertEqual(sorted(cols), sorted(["file_path", "repo_id", "branch"]))

    def test_file_imports_fks_are_composite(self):
        """Both source_file and target_file FKs are 3-column composites that
        reference the `files` table on (file_path, repo_id, branch)."""
        with self.conn.cursor() as cur:
            cur.execute(
                """
                SELECT tc.constraint_name,
                       array_agg(kcu.column_name ORDER BY kcu.ordinal_position),
                       ccu.table_name
                FROM information_schema.table_constraints tc
                JOIN information_schema.key_column_usage kcu
                  ON tc.constraint_name = kcu.constraint_name
                JOIN information_schema.referential_constraints rc
                  ON rc.constraint_name = tc.constraint_name
                JOIN information_schema.constraint_column_usage ccu
                  ON ccu.constraint_name = rc.unique_constraint_name
                WHERE tc.table_name = 'file_imports'
                  AND tc.constraint_type = 'FOREIGN KEY'
                GROUP BY tc.constraint_name, ccu.table_name
                ORDER BY tc.constraint_name
                """
            )
            rows = cur.fetchall()

        # Expect two composite FKs (one for source_file, one for target_file)
        # — both must reference `files`.
        self.assertEqual(len(rows), 2)

        seen_source = False
        seen_target = False
        for _, cols, referenced_table in rows:
            self.assertEqual(referenced_table, "files")
            self.assertEqual(len(cols), 3)
            self.assertIn("repo_id", cols)
            self.assertIn("branch", cols)
            if "source_file" in cols:
                seen_source = True
            if "target_file" in cols:
                seen_target = True
        self.assertTrue(seen_source, "Expected an FK on (source_file, repo_id, branch)")
        self.assertTrue(seen_target, "Expected an FK on (target_file, repo_id, branch)")

    def test_same_path_different_repo_coexists(self):
        """The core regression: same path on two repos no longer collides."""
        with self.conn.cursor() as cur:
            cur.execute(
                "INSERT INTO files (file_path, repo_id, repo_url, branch, language) "
                "VALUES (%s, %s, %s, %s, %s)",
                ("src/foo.ts", "repo-a", "https://repo-a", "main", "typescript"),
            )
            cur.execute(
                "INSERT INTO files (file_path, repo_id, repo_url, branch, language) "
                "VALUES (%s, %s, %s, %s, %s)",
                ("src/foo.ts", "repo-b", "https://repo-b", "main", "python"),
            )
            self.conn.commit()
            cur.execute("SELECT repo_id, language FROM files WHERE file_path = 'src/foo.ts' ORDER BY repo_id")
            rows = cur.fetchall()
        self.assertEqual(rows, [("repo-a", "typescript"), ("repo-b", "python")])

    def test_same_path_different_branch_coexists(self):
        """The same file on two branches of one repo coexists independently."""
        with self.conn.cursor() as cur:
            cur.execute(
                "INSERT INTO files (file_path, repo_id, repo_url, branch, language) "
                "VALUES (%s, %s, %s, %s, %s)",
                ("src/foo.ts", "repo-a", "https://repo-a", "main", "typescript"),
            )
            cur.execute(
                "INSERT INTO files (file_path, repo_id, repo_url, branch, language) "
                "VALUES (%s, %s, %s, %s, %s)",
                ("src/foo.ts", "repo-a", "https://repo-a", "feature/x", "typescript"),
            )
            self.conn.commit()
            cur.execute(
                "SELECT branch FROM files WHERE file_path = 'src/foo.ts' AND repo_id = 'repo-a' "
                "ORDER BY branch"
            )
            branches = [row[0] for row in cur.fetchall()]
        self.assertEqual(branches, ["feature/x", "main"])

    def test_on_conflict_uses_composite_key(self):
        """The production upsert syntax (used by indexer.py + incremental.py)
        treats same-path-different-repo as new rows, not conflicts."""
        with self.conn.cursor() as cur:
            sql = (
                "INSERT INTO files (file_path, repo_id, repo_url, branch, language) "
                "VALUES (%s, %s, %s, %s, %s) "
                "ON CONFLICT (file_path, repo_id, branch) DO UPDATE SET "
                "  repo_url = EXCLUDED.repo_url, language = EXCLUDED.language, updated_at = NOW()"
            )
            cur.execute(sql, ("src/foo.ts", "repo-a", "https://a", "main", "typescript"))
            cur.execute(sql, ("src/foo.ts", "repo-b", "https://b", "main", "python"))
            cur.execute(sql, ("src/foo.ts", "repo-a", "https://a", "main", "typescript-updated"))
            self.conn.commit()

            cur.execute("SELECT COUNT(*) FROM files WHERE file_path = 'src/foo.ts'")
            self.assertEqual(cur.fetchone()[0], 2)

            cur.execute(
                "SELECT language FROM files WHERE file_path = 'src/foo.ts' AND repo_id = 'repo-a'"
            )
            self.assertEqual(cur.fetchone()[0], "typescript-updated")

            cur.execute(
                "SELECT language FROM files WHERE file_path = 'src/foo.ts' AND repo_id = 'repo-b'"
            )
            self.assertEqual(cur.fetchone()[0], "python")

    def test_cascade_delete_scoped_to_repo(self):
        """Deleting a files row cascade-clears chunks/file_imports for that
        (path, repo, branch) only — never the same-path row on another repo."""
        with self.conn.cursor() as cur:
            # Set up two files (same path, different repos) and chunks for each.
            for repo_id, lang in [("repo-a", "typescript"), ("repo-b", "python")]:
                cur.execute(
                    "INSERT INTO files (file_path, repo_id, repo_url, branch, language) "
                    "VALUES (%s, %s, %s, %s, %s)",
                    ("src/foo.ts", repo_id, f"https://{repo_id}", "main", lang),
                )
                cur.execute(
                    "INSERT INTO chunks (file_path, content, language, chunk_type, line_start, line_end, "
                    "repo_id, repo_url, branch) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
                    ("src/foo.ts", f"// {repo_id} body", lang, "function", 1, 5, repo_id, f"https://{repo_id}", "main"),
                )
            self.conn.commit()

            # Delete one repo's files row — cascade should remove only its chunks.
            cur.execute("DELETE FROM files WHERE repo_id = 'repo-a'")
            self.conn.commit()

            cur.execute("SELECT COUNT(*) FROM chunks WHERE repo_id = 'repo-a'")
            self.assertEqual(cur.fetchone()[0], 0)
            cur.execute("SELECT COUNT(*) FROM chunks WHERE repo_id = 'repo-b'")
            self.assertEqual(cur.fetchone()[0], 1)
            cur.execute("SELECT COUNT(*) FROM files WHERE repo_id = 'repo-b'")
            self.assertEqual(cur.fetchone()[0], 1)

    def test_migration_idempotent(self):
        """Re-applying schema.sql against an already-migrated database is a no-op.

        setUp already applied the schema once (the first migration run). This
        test seeds a sentinel row, captures the current constraint state,
        re-applies the schema, and asserts both the constraint state and the
        sentinel row are unchanged. That proves the DO block exits early
        without dropping/recreating anything once the composite PK exists.
        """
        with self.conn.cursor() as cur:
            cur.execute(
                "INSERT INTO files (file_path, repo_id, repo_url, branch) "
                "VALUES (%s, %s, %s, %s)",
                ("src/sentinel.ts", "repo-sentinel", "https://sentinel", "main"),
            )
            self.conn.commit()

            # Capture the exact constraint identities and their column lists
            # BEFORE the second apply so we can assert nothing was recreated.
            cur.execute(
                """
                SELECT tc.constraint_name,
                       array_agg(kcu.column_name ORDER BY kcu.ordinal_position)
                FROM information_schema.table_constraints tc
                JOIN information_schema.key_column_usage kcu
                  ON tc.constraint_name = kcu.constraint_name
                WHERE tc.table_name IN ('files', 'chunks', 'file_imports')
                  AND tc.constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY')
                GROUP BY tc.constraint_name
                ORDER BY tc.constraint_name
                """
            )
            before = cur.fetchall()
            self.assertGreater(len(before), 0, "Expected the migrated schema to have constraints")

        # Re-apply the schema against a DB that already carries it. A
        # non-idempotent block would either error here or recreate constraints
        # (changing their identities/columns).
        _apply_schema(self.conn)

        with self.conn.cursor() as cur:
            cur.execute(
                "SELECT COUNT(*) FROM files WHERE repo_id = 'repo-sentinel'"
            )
            self.assertEqual(cur.fetchone()[0], 1, "Sentinel row must survive re-apply")

            cur.execute(
                """
                SELECT tc.constraint_name,
                       array_agg(kcu.column_name ORDER BY kcu.ordinal_position)
                FROM information_schema.table_constraints tc
                JOIN information_schema.key_column_usage kcu
                  ON tc.constraint_name = kcu.constraint_name
                WHERE tc.table_name IN ('files', 'chunks', 'file_imports')
                  AND tc.constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY')
                GROUP BY tc.constraint_name
                ORDER BY tc.constraint_name
                """
            )
            after = cur.fetchall()

        self.assertEqual(
            before, after,
            "Re-applying schema.sql must not drop/recreate any PK or FK constraints",
        )


@unittest.skipUnless(_has_db(), "Requires COCOINDEX_DATABASE_URL (or DATABASE_URL) and psycopg")
class DeleteIndexEndpointTests(unittest.TestCase):
    """Pin the SQL used by main.py's DELETE /index/{repo_url} endpoint."""

    @classmethod
    def setUpClass(cls):
        cls.conn = psycopg.connect(DB_URL)

    @classmethod
    def tearDownClass(cls):
        _drop_test_tables(cls.conn)
        cls.conn.close()

    def setUp(self):
        # Clear any aborted-transaction state left behind by a failing test;
        # without this, _drop_test_tables would error on the shared connection.
        self.conn.rollback()
        _drop_test_tables(self.conn)
        _apply_schema(self.conn)

    def _populate(self, repo_id: str, branch: str) -> None:
        """Insert one row in every relevant table for the given (repo, branch)."""
        with self.conn.cursor() as cur:
            cur.execute(
                "INSERT INTO files (file_path, repo_id, repo_url, branch, language) "
                "VALUES (%s, %s, %s, %s, %s)",
                (f"src/{repo_id}.ts", repo_id, f"https://{repo_id}", branch, "typescript"),
            )
            cur.execute(
                "INSERT INTO chunks (file_path, content, language, chunk_type, line_start, line_end, "
                "repo_id, repo_url, branch) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id",
                (f"src/{repo_id}.ts", "// body", "typescript", "function", 1, 5,
                 repo_id, f"https://{repo_id}", branch),
            )
            chunk_id = cur.fetchone()[0]
            cur.execute(
                "INSERT INTO files (file_path, repo_id, repo_url, branch, language) "
                "VALUES (%s, %s, %s, %s, %s)",
                (f"src/{repo_id}-other.ts", repo_id, f"https://{repo_id}", branch, "typescript"),
            )
            cur.execute(
                "INSERT INTO chunks (file_path, content, language, chunk_type, line_start, line_end, "
                "repo_id, repo_url, branch) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id",
                (f"src/{repo_id}-other.ts", "// other", "typescript", "function", 1, 3,
                 repo_id, f"https://{repo_id}", branch),
            )
            other_chunk_id = cur.fetchone()[0]
            cur.execute(
                "INSERT INTO relationships (source_chunk_id, target_chunk_id, relationship_type) "
                "VALUES (%s, %s, %s)",
                (chunk_id, other_chunk_id, "calls"),
            )
            cur.execute(
                "INSERT INTO file_imports (source_file, target_file, import_type, repo_id, branch) "
                "VALUES (%s, %s, %s, %s, %s)",
                (f"src/{repo_id}.ts", f"src/{repo_id}-other.ts", "static", repo_id, branch),
            )
            cur.execute(
                "INSERT INTO code_embeddings (repo_id, repo_url, branch, filename, location, code, "
                "start_line, end_line) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
                (repo_id, f"https://{repo_id}", branch, f"src/{repo_id}.ts", "1-5", "// body", 1, 5),
            )
        self.conn.commit()

    def _counts(self, repo_id: str) -> dict:
        out = {}
        with self.conn.cursor() as cur:
            for table in ("files", "chunks", "file_imports", "code_embeddings"):
                cur.execute(f"SELECT COUNT(*) FROM {table} WHERE repo_id = %s", (repo_id,))
                out[table] = cur.fetchone()[0]
            cur.execute(
                "SELECT COUNT(*) FROM relationships r "
                "JOIN chunks c ON c.id = r.source_chunk_id "
                "WHERE c.repo_id = %s",
                (repo_id,),
            )
            out["relationships"] = cur.fetchone()[0]
        return out

    def _delete_index(self, repo_id: str, branch: str | None) -> None:
        """Run the exact DELETE strategy from main.py:delete_index."""
        if branch:
            scope_clause = " AND branch = %s"
            params = (repo_id, branch)
        else:
            scope_clause = ""
            params = (repo_id,)
        with self.conn.cursor() as cur:
            cur.execute(f"DELETE FROM files WHERE repo_id = %s{scope_clause}", params)
            cur.execute(f"DELETE FROM code_embeddings WHERE repo_id = %s{scope_clause}", params)
        self.conn.commit()

    def test_delete_index_clears_all_tables(self):
        """Without a branch filter, every canonical and legacy table is cleared
        for the target repo — and the other repo is left alone."""
        self._populate("repo-a", "main")
        self._populate("repo-b", "main")

        self._delete_index("repo-a", None)

        cleared = self._counts("repo-a")
        for table, count in cleared.items():
            self.assertEqual(count, 0, f"{table} should be empty for repo-a after delete (got {count})")

        survived = self._counts("repo-b")
        for table, count in survived.items():
            self.assertGreater(count, 0, f"{table} should still have rows for repo-b (got {count})")

    def test_delete_index_scoped_by_branch(self):
        """A branched delete leaves the other branch's data intact."""
        self._populate("repo-a", "main")
        self._populate("repo-a", "feature/x")

        self._delete_index("repo-a", "main")

        with self.conn.cursor() as cur:
            cur.execute(
                "SELECT COUNT(*) FROM files WHERE repo_id = 'repo-a' AND branch = 'main'"
            )
            self.assertEqual(cur.fetchone()[0], 0)
            cur.execute(
                "SELECT COUNT(*) FROM files WHERE repo_id = 'repo-a' AND branch = 'feature/x'"
            )
            self.assertGreater(cur.fetchone()[0], 0)
            cur.execute(
                "SELECT COUNT(*) FROM code_embeddings WHERE repo_id = 'repo-a' AND branch = 'feature/x'"
            )
            self.assertGreater(cur.fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main()
