#!/usr/bin/env python3
"""
Verification script for US-005: Generate embeddings and export to Postgres.

This script verifies that:
1. Chunks are properly exported with embeddings to the chunks table
2. Relationships are properly exported to the relationships table
3. Vector similarity search works correctly
4. All required fields are populated

Usage:
    python verify_export.py [--repo-url URL] [--branch BRANCH]

Environment variables:
    COCOINDEX_DATABASE_URL: PostgreSQL connection string (required)
    REPO_URL: Repository URL (optional, for filtering)
    REPO_BRANCH: Branch name (optional, for filtering)
"""

from __future__ import annotations

import os
import sys
import hashlib
import argparse
from typing import Any

import psycopg
from pgvector.psycopg import register_vector
from sentence_transformers import SentenceTransformer


def generate_repo_id(repo_url: str) -> str:
    """Generate a short unique identifier for a repository URL."""
    return hashlib.sha256(repo_url.encode()).hexdigest()[:16]


def verify_chunks_table(
    conn: psycopg.Connection,
    repo_id: str | None = None,
    branch: str | None = None,
) -> dict[str, Any]:
    """Verify chunks table has properly exported data."""
    results: dict[str, Any] = {
        "status": "pass",
        "total_chunks": 0,
        "chunks_with_embeddings": 0,
        "chunks_with_symbols": 0,
        "chunks_with_imports": 0,
        "unique_files": 0,
        "chunk_types": {},
        "languages": {},
        "issues": [],
    }

    with conn.cursor() as cur:
        # Build query with optional filters
        where_clauses = []
        params: list[Any] = []

        if repo_id:
            where_clauses.append("repo_id = %s")
            params.append(repo_id)
        if branch:
            where_clauses.append("branch = %s")
            params.append(branch)

        where_sql = f"WHERE {' AND '.join(where_clauses)}" if where_clauses else ""

        # Count total chunks
        cur.execute(f"SELECT COUNT(*) FROM chunks {where_sql}", params)
        results["total_chunks"] = cur.fetchone()[0]

        if results["total_chunks"] == 0:
            results["status"] = "fail"
            results["issues"].append("No chunks found in database")
            return results

        # Count chunks with embeddings (non-null)
        cur.execute(
            f"SELECT COUNT(*) FROM chunks {where_sql} {'AND' if where_sql else 'WHERE'} embedding IS NOT NULL",
            params,
        )
        results["chunks_with_embeddings"] = cur.fetchone()[0]

        if results["chunks_with_embeddings"] < results["total_chunks"]:
            missing = results["total_chunks"] - results["chunks_with_embeddings"]
            results["issues"].append(f"{missing} chunks missing embeddings")

        # Count chunks with symbol_names
        cur.execute(
            f"SELECT COUNT(*) FROM chunks {where_sql} {'AND' if where_sql else 'WHERE'} array_length(symbol_names, 1) > 0",
            params,
        )
        results["chunks_with_symbols"] = cur.fetchone()[0]

        # Count chunks with imports
        cur.execute(
            f"SELECT COUNT(*) FROM chunks {where_sql} {'AND' if where_sql else 'WHERE'} array_length(imports, 1) > 0",
            params,
        )
        results["chunks_with_imports"] = cur.fetchone()[0]

        # Count unique files
        cur.execute(f"SELECT COUNT(DISTINCT file_path) FROM chunks {where_sql}", params)
        results["unique_files"] = cur.fetchone()[0]

        # Get chunk type distribution
        cur.execute(
            f"SELECT chunk_type, COUNT(*) FROM chunks {where_sql} GROUP BY chunk_type ORDER BY COUNT(*) DESC",
            params,
        )
        for row in cur.fetchall():
            results["chunk_types"][row[0] or "unknown"] = row[1]

        # Get language distribution
        cur.execute(
            f"SELECT language, COUNT(*) FROM chunks {where_sql} GROUP BY language ORDER BY COUNT(*) DESC",
            params,
        )
        for row in cur.fetchall():
            results["languages"][row[0] or "unknown"] = row[1]

        # Verify embedding dimensions
        cur.execute(
            f"SELECT vector_dims(embedding) FROM chunks {where_sql} {'AND' if where_sql else 'WHERE'} embedding IS NOT NULL LIMIT 1",
            params,
        )
        row = cur.fetchone()
        if row:
            results["embedding_dimensions"] = row[0]
            # Check if dimensions are as expected (384 for MiniLM or 1536 padded)
            if row[0] not in (384, 1536):
                results["issues"].append(
                    f"Unexpected embedding dimensions: {row[0]}"
                )

    if not results["issues"]:
        results["status"] = "pass"
    elif results["chunks_with_embeddings"] > 0:
        results["status"] = "partial"
    else:
        results["status"] = "fail"

    return results


def verify_relationships_table(
    conn: psycopg.Connection,
    repo_id: str | None = None,
    branch: str | None = None,
) -> dict[str, Any]:
    """Verify relationships table has properly exported data."""
    results: dict[str, Any] = {
        "status": "pass",
        "total_relationships": 0,
        "relationship_types": {},
        "issues": [],
    }

    with conn.cursor() as cur:
        # Count relationships (need to join with chunks for repo/branch filter)
        if repo_id or branch:
            where_parts = []
            params: list[Any] = []
            if repo_id:
                where_parts.append("c.repo_id = %s")
                params.append(repo_id)
            if branch:
                where_parts.append("c.branch = %s")
                params.append(branch)

            where_sql = " AND ".join(where_parts)
            cur.execute(
                f"""
                SELECT COUNT(DISTINCT (r.source_chunk_id, r.target_chunk_id, r.relationship_type))
                FROM relationships r
                JOIN chunks c ON r.source_chunk_id = c.id
                WHERE {where_sql}
                """,
                params,
            )
        else:
            cur.execute("SELECT COUNT(*) FROM relationships")

        results["total_relationships"] = cur.fetchone()[0]

        # Get relationship type distribution
        if repo_id or branch:
            cur.execute(
                f"""
                SELECT r.relationship_type, COUNT(*)
                FROM relationships r
                JOIN chunks c ON r.source_chunk_id = c.id
                WHERE {where_sql}
                GROUP BY r.relationship_type
                ORDER BY COUNT(*) DESC
                """,
                params,
            )
        else:
            cur.execute(
                "SELECT relationship_type, COUNT(*) FROM relationships GROUP BY relationship_type ORDER BY COUNT(*) DESC"
            )

        for row in cur.fetchall():
            results["relationship_types"][row[0]] = row[1]

        # Verify referential integrity
        cur.execute(
            """
            SELECT COUNT(*) FROM relationships r
            WHERE NOT EXISTS (SELECT 1 FROM chunks c WHERE c.id = r.source_chunk_id)
               OR NOT EXISTS (SELECT 1 FROM chunks c WHERE c.id = r.target_chunk_id)
            """
        )
        orphaned = cur.fetchone()[0]
        if orphaned > 0:
            results["issues"].append(f"{orphaned} relationships with missing chunks")
            results["status"] = "fail"

    return results


def verify_vector_search(
    conn: psycopg.Connection,
    model: SentenceTransformer,
    repo_id: str | None = None,
    branch: str | None = None,
) -> dict[str, Any]:
    """Verify vector similarity search works correctly."""
    results: dict[str, Any] = {
        "status": "pass",
        "search_works": False,
        "sample_results": [],
        "issues": [],
    }

    # Generate a test query embedding
    test_query = "function that handles user authentication"
    query_embedding = model.encode(test_query).tolist()

    # Pad to 1536 if needed (for compatibility with padded embeddings)
    if len(query_embedding) < 1536:
        query_embedding = query_embedding + [0.0] * (1536 - len(query_embedding))

    with conn.cursor() as cur:
        # Build search query
        where_parts = []
        params: list[Any] = [query_embedding]

        if repo_id:
            where_parts.append("repo_id = %s")
            params.append(repo_id)
        if branch:
            where_parts.append("branch = %s")
            params.append(branch)

        where_sql = f"WHERE {' AND '.join(where_parts)}" if where_parts else ""

        try:
            cur.execute(
                f"""
                SELECT
                    file_path,
                    chunk_type,
                    symbol_names,
                    line_start,
                    line_end,
                    1 - (embedding <=> %s::vector) AS similarity
                FROM chunks
                {where_sql}
                ORDER BY embedding <=> %s::vector
                LIMIT 5
                """,
                params + [query_embedding],
            )

            rows = cur.fetchall()
            if rows:
                results["search_works"] = True
                for row in rows:
                    results["sample_results"].append(
                        {
                            "file_path": row[0],
                            "chunk_type": row[1],
                            "symbol_names": row[2],
                            "lines": f"{row[3]}-{row[4]}",
                            "similarity": round(row[5], 4) if row[5] else 0,
                        }
                    )
            else:
                results["issues"].append("Vector search returned no results")
                results["status"] = "fail"

        except Exception as e:
            results["issues"].append(f"Vector search failed: {e}")
            results["status"] = "fail"

    return results


def verify_files_table(
    conn: psycopg.Connection,
    repo_id: str | None = None,
    branch: str | None = None,
) -> dict[str, Any]:
    """Verify files table has properly exported data."""
    results: dict[str, Any] = {
        "status": "pass",
        "total_files": 0,
        "files_with_language": 0,
        "issues": [],
    }

    with conn.cursor() as cur:
        where_clauses = []
        params: list[Any] = []

        if repo_id:
            where_clauses.append("repo_id = %s")
            params.append(repo_id)
        if branch:
            where_clauses.append("branch = %s")
            params.append(branch)

        where_sql = f"WHERE {' AND '.join(where_clauses)}" if where_clauses else ""

        # Count total files
        cur.execute(f"SELECT COUNT(*) FROM files {where_sql}", params)
        results["total_files"] = cur.fetchone()[0]

        # Count files with language detected
        cur.execute(
            f"SELECT COUNT(*) FROM files {where_sql} {'AND' if where_sql else 'WHERE'} language IS NOT NULL",
            params,
        )
        results["files_with_language"] = cur.fetchone()[0]

    return results


def main():
    parser = argparse.ArgumentParser(
        description="Verify US-005 export to Postgres"
    )
    parser.add_argument(
        "--repo-url",
        default=os.environ.get("REPO_URL", ""),
        help="Repository URL to filter by",
    )
    parser.add_argument(
        "--branch",
        default=os.environ.get("REPO_BRANCH", ""),
        help="Branch to filter by",
    )
    parser.add_argument(
        "--skip-search",
        action="store_true",
        help="Skip vector search verification (faster)",
    )
    args = parser.parse_args()

    database_url = os.environ.get("COCOINDEX_DATABASE_URL")
    if not database_url:
        print("Error: COCOINDEX_DATABASE_URL environment variable required")
        sys.exit(1)

    repo_id = generate_repo_id(args.repo_url) if args.repo_url else None
    branch = args.branch if args.branch else None

    print("=" * 60)
    print("US-005 Export Verification")
    print("=" * 60)
    if repo_id:
        print(f"Repository: {args.repo_url}")
        print(f"Repo ID: {repo_id}")
    if branch:
        print(f"Branch: {branch}")
    print("=" * 60)

    # Connect to database
    print("\nConnecting to database...")
    conn = psycopg.connect(database_url)
    register_vector(conn)

    all_passed = True

    # Verify files table
    print("\n--- Files Table ---")
    files_results = verify_files_table(conn, repo_id, branch)
    print(f"  Total files: {files_results['total_files']}")
    print(f"  Files with language: {files_results['files_with_language']}")
    print(f"  Status: {files_results['status'].upper()}")
    if files_results["issues"]:
        for issue in files_results["issues"]:
            print(f"  ⚠ {issue}")
    if files_results["status"] == "fail":
        all_passed = False

    # Verify chunks table
    print("\n--- Chunks Table ---")
    chunks_results = verify_chunks_table(conn, repo_id, branch)
    print(f"  Total chunks: {chunks_results['total_chunks']}")
    print(f"  Chunks with embeddings: {chunks_results['chunks_with_embeddings']}")
    print(f"  Chunks with symbols: {chunks_results['chunks_with_symbols']}")
    print(f"  Chunks with imports: {chunks_results['chunks_with_imports']}")
    print(f"  Unique files: {chunks_results['unique_files']}")
    if "embedding_dimensions" in chunks_results:
        print(f"  Embedding dimensions: {chunks_results['embedding_dimensions']}")
    print(f"  Chunk types: {chunks_results['chunk_types']}")
    print(f"  Languages: {chunks_results['languages']}")
    print(f"  Status: {chunks_results['status'].upper()}")
    if chunks_results["issues"]:
        for issue in chunks_results["issues"]:
            print(f"  ⚠ {issue}")
    if chunks_results["status"] == "fail":
        all_passed = False

    # Verify relationships table
    print("\n--- Relationships Table ---")
    rel_results = verify_relationships_table(conn, repo_id, branch)
    print(f"  Total relationships: {rel_results['total_relationships']}")
    print(f"  Relationship types: {rel_results['relationship_types']}")
    print(f"  Status: {rel_results['status'].upper()}")
    if rel_results["issues"]:
        for issue in rel_results["issues"]:
            print(f"  ⚠ {issue}")
    if rel_results["status"] == "fail":
        all_passed = False

    # Verify vector search
    if not args.skip_search and chunks_results["chunks_with_embeddings"] > 0:
        print("\n--- Vector Search ---")
        print("  Loading embedding model...")
        model = SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2")
        search_results = verify_vector_search(conn, model, repo_id, branch)
        print(f"  Search works: {search_results['search_works']}")
        if search_results["sample_results"]:
            print("  Sample results:")
            for r in search_results["sample_results"][:3]:
                print(f"    - {r['file_path']}:{r['lines']} ({r['chunk_type']}) sim={r['similarity']}")
        print(f"  Status: {search_results['status'].upper()}")
        if search_results["issues"]:
            for issue in search_results["issues"]:
                print(f"  ⚠ {issue}")
        if search_results["status"] == "fail":
            all_passed = False

    conn.close()

    # Final summary
    print("\n" + "=" * 60)
    if all_passed:
        print("✓ All verifications PASSED")
        print("=" * 60)
        sys.exit(0)
    else:
        print("✗ Some verifications FAILED")
        print("=" * 60)
        sys.exit(1)


if __name__ == "__main__":
    main()
