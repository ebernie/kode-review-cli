#!/usr/bin/env python3
"""
Import graph builder and analyzer for import chain tracking.

This module provides:
- File-level import graph construction from chunks
- 2-level import tree computation (what imports a file, what it imports)
- Circular dependency detection
- Hub file identification (files with many dependents)

The import graph is built by analyzing the imports extracted from chunks
and resolving them to actual file paths where possible.
"""

from __future__ import annotations

import re
import hashlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional
from collections import defaultdict

import psycopg


def generate_repo_id(repo_url: str) -> str:
    """Generate a short unique identifier for a repository URL."""
    return hashlib.sha256(repo_url.encode()).hexdigest()[:16]


@dataclass
class ImportEdge:
    """Represents an import relationship between two files."""
    source_file: str  # File that contains the import statement
    target_file: str  # File being imported
    import_type: str = "static"  # 'static', 'dynamic', 're-export'
    imported_symbols: list[str] = field(default_factory=list)


@dataclass
class ImportTreeNode:
    """A node in the import tree with its relationships."""
    file_path: str
    imports: list[str] = field(default_factory=list)  # Files this file imports
    imported_by: list[str] = field(default_factory=list)  # Files that import this file


@dataclass
class ImportTree:
    """2-level import tree for a file."""
    target_file: str
    # Level 1: Direct relationships
    direct_imports: list[str] = field(default_factory=list)  # What this file imports
    direct_importers: list[str] = field(default_factory=list)  # What imports this file
    # Level 2: Indirect relationships (2 hops)
    indirect_imports: list[str] = field(default_factory=list)  # What direct imports import
    indirect_importers: list[str] = field(default_factory=list)  # What imports direct importers


@dataclass
class CircularDependency:
    """Represents a circular dependency chain."""
    cycle: list[str]  # Files in the cycle, in order
    cycle_type: str = "direct"  # 'direct' (A->B->A) or 'indirect' (A->B->C->A)


@dataclass
class HubFile:
    """A file that is imported by many other files."""
    file_path: str
    import_count: int  # Number of files that import this file
    importers: list[str] = field(default_factory=list)  # Sample of importing files


class ImportGraphBuilder:
    """
    Builds and analyzes the import graph from indexed chunks.

    The graph is built at the file level, aggregating imports from all chunks
    in each file. Import paths are resolved to actual file paths where possible.
    """

    # Common file extensions by language family
    JS_TS_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts']
    PYTHON_EXTENSIONS = ['.py', '.pyi']

    def __init__(self, conn: psycopg.Connection, repo_id: str, branch: str):
        self.conn = conn
        self.repo_id = repo_id
        self.branch = branch
        self._file_set: set[str] | None = None  # Cache of all files in the repo

    def _get_all_files(self) -> set[str]:
        """Get the set of all indexed files for this repo/branch."""
        if self._file_set is not None:
            return self._file_set

        with self.conn.cursor() as cur:
            cur.execute(
                """
                SELECT file_path FROM files
                WHERE repo_id = %s AND branch = %s
                """,
                (self.repo_id, self.branch)
            )
            self._file_set = {row[0] for row in cur.fetchall()}

        return self._file_set

    def _resolve_import_path(self, import_path: str, source_file: str) -> str | None:
        """
        Resolve an import path to an actual file path.

        Handles:
        - Relative imports (./foo, ../bar)
        - Node.js style imports (might need index.js/ts resolution)
        - Python relative imports (from .foo import bar)
        - TypeScript .js imports that map to .ts files
        """
        all_files = self._get_all_files()
        source_dir = str(Path(source_file).parent)

        # Handle relative imports
        if import_path.startswith('./') or import_path.startswith('../'):
            # Join paths and normalize (don't use .resolve() as it makes absolute)
            combined = Path(source_dir) / import_path
            # Normalize the path (resolve ./ and ../ but keep relative)
            parts = []
            for part in combined.parts:
                if part == '..':
                    if parts:
                        parts.pop()
                elif part != '.':
                    parts.append(part)
            resolved = '/'.join(parts)

            # Try with different extensions
            candidates = self._get_path_candidates(resolved)
            for candidate in candidates:
                if candidate in all_files:
                    return candidate

        # Handle Python relative imports (starting with .)
        if import_path.startswith('.'):
            # Count leading dots for relative depth
            dots = 0
            for c in import_path:
                if c == '.':
                    dots += 1
                else:
                    break

            module_path = import_path[dots:].replace('.', '/')
            base_path = source_dir

            # Go up directories based on dot count
            for _ in range(dots - 1):
                base_path = str(Path(base_path).parent)

            resolved = str(Path(base_path) / module_path) if module_path else base_path
            candidates = self._get_path_candidates(resolved)
            for candidate in candidates:
                if candidate in all_files:
                    return candidate

        # Handle absolute-style imports (package names, etc.)
        # Try to find a matching file in the repo
        clean_path = import_path.replace('.', '/')
        candidates = self._get_path_candidates(clean_path)
        for candidate in candidates:
            if candidate in all_files:
                return candidate

        # Try common source directories
        for prefix in ['src/', 'lib/', 'app/', '']:
            test_path = prefix + clean_path
            candidates = self._get_path_candidates(test_path)
            for candidate in candidates:
                if candidate in all_files:
                    return candidate

        return None

    def _get_path_candidates(self, base_path: str) -> list[str]:
        """Get candidate file paths for an import, trying common extensions."""
        candidates = []
        path = Path(base_path)
        suffix = path.suffix.lower()

        # If path already has an extension
        if suffix:
            # First try the exact path
            candidates.append(base_path)

            # For .js imports, also try .ts (TypeScript projects often compile to .js)
            # This handles: import x from './foo.js' -> src/foo.ts
            if suffix == '.js':
                stem = str(path.with_suffix(''))
                candidates.append(stem + '.ts')
                candidates.append(stem + '.tsx')
            elif suffix == '.jsx':
                stem = str(path.with_suffix(''))
                candidates.append(stem + '.tsx')
                candidates.append(stem + '.ts')
            elif suffix == '.mjs':
                stem = str(path.with_suffix(''))
                candidates.append(stem + '.mts')
                candidates.append(stem + '.ts')

            return candidates

        # No extension - try adding common extensions
        for ext in self.JS_TS_EXTENSIONS + self.PYTHON_EXTENSIONS:
            candidates.append(base_path + ext)

        # Try index files (for directory imports)
        for ext in self.JS_TS_EXTENSIONS:
            candidates.append(f"{base_path}/index{ext}")

        # Python __init__.py
        candidates.append(f"{base_path}/__init__.py")

        return candidates

    def build_import_graph(self) -> list[ImportEdge]:
        """
        Build the file-level import graph from indexed chunks.

        Extracts imports from all chunks, resolves them to file paths,
        and creates edges in the import graph.
        """
        edges: list[ImportEdge] = []
        seen_edges: set[tuple[str, str]] = set()

        # Get all chunks with their imports grouped by file
        with self.conn.cursor() as cur:
            cur.execute(
                """
                SELECT file_path, array_agg(DISTINCT import_elem) as all_imports
                FROM chunks,
                LATERAL unnest(imports) AS import_elem
                WHERE repo_id = %s AND branch = %s
                  AND array_length(imports, 1) > 0
                GROUP BY file_path
                """,
                (self.repo_id, self.branch)
            )

            for row in cur.fetchall():
                source_file = row[0]
                imports = row[1] if row[1] else []

                for import_path in imports:
                    if not import_path:
                        continue

                    # Resolve the import to a file path
                    target_file = self._resolve_import_path(import_path, source_file)

                    if target_file and target_file != source_file:
                        edge_key = (source_file, target_file)
                        if edge_key not in seen_edges:
                            seen_edges.add(edge_key)

                            # Determine import type
                            import_type = "static"
                            if "dynamic" in import_path.lower() or "import(" in import_path:
                                import_type = "dynamic"

                            edges.append(ImportEdge(
                                source_file=source_file,
                                target_file=target_file,
                                import_type=import_type,
                            ))

        return edges

    def store_import_graph(self, edges: list[ImportEdge]) -> int:
        """
        Store the import graph edges in the file_imports table.

        Returns the number of edges stored.
        """
        if not edges:
            return 0

        # Clear existing imports for this repo/branch
        with self.conn.cursor() as cur:
            cur.execute(
                """
                DELETE FROM file_imports
                WHERE repo_id = %s AND branch = %s
                """,
                (self.repo_id, self.branch)
            )

            # Insert new edges
            for edge in edges:
                try:
                    cur.execute(
                        """
                        INSERT INTO file_imports
                        (source_file, target_file, import_type, imported_symbols, repo_id, branch)
                        VALUES (%s, %s, %s, %s, %s, %s)
                        ON CONFLICT (source_file, target_file, repo_id, branch)
                        DO UPDATE SET
                            import_type = EXCLUDED.import_type,
                            imported_symbols = EXCLUDED.imported_symbols
                        """,
                        (
                            edge.source_file,
                            edge.target_file,
                            edge.import_type,
                            edge.imported_symbols,
                            self.repo_id,
                            self.branch,
                        )
                    )
                except Exception as e:
                    # Skip edges with missing files (foreign key constraint)
                    if "violates foreign key constraint" not in str(e):
                        raise

            self.conn.commit()

        return len(edges)

    def get_import_tree(self, file_path: str, max_depth: int = 2) -> ImportTree:
        """
        Get the 2-level import tree for a file.

        Returns what the file imports (and what those import),
        and what imports the file (and what imports those).
        """
        tree = ImportTree(target_file=file_path)

        with self.conn.cursor() as cur:
            # Level 1: Direct imports (what this file imports)
            cur.execute(
                """
                SELECT target_file FROM file_imports
                WHERE source_file = %s AND repo_id = %s AND branch = %s
                """,
                (file_path, self.repo_id, self.branch)
            )
            tree.direct_imports = [row[0] for row in cur.fetchall()]

            # Level 1: Direct importers (what imports this file)
            cur.execute(
                """
                SELECT source_file FROM file_imports
                WHERE target_file = %s AND repo_id = %s AND branch = %s
                """,
                (file_path, self.repo_id, self.branch)
            )
            tree.direct_importers = [row[0] for row in cur.fetchall()]

            if max_depth >= 2:
                # Level 2: Indirect imports (what direct imports import)
                if tree.direct_imports:
                    placeholders = ",".join(["%s"] * len(tree.direct_imports))
                    cur.execute(
                        f"""
                        SELECT DISTINCT target_file FROM file_imports
                        WHERE source_file IN ({placeholders})
                          AND repo_id = %s AND branch = %s
                          AND target_file != %s
                          AND target_file NOT IN ({placeholders})
                        """,
                        tuple(tree.direct_imports) +
                        (self.repo_id, self.branch, file_path) +
                        tuple(tree.direct_imports)
                    )
                    tree.indirect_imports = [row[0] for row in cur.fetchall()]

                # Level 2: Indirect importers (what imports direct importers)
                if tree.direct_importers:
                    placeholders = ",".join(["%s"] * len(tree.direct_importers))
                    cur.execute(
                        f"""
                        SELECT DISTINCT source_file FROM file_imports
                        WHERE target_file IN ({placeholders})
                          AND repo_id = %s AND branch = %s
                          AND source_file != %s
                          AND source_file NOT IN ({placeholders})
                        """,
                        tuple(tree.direct_importers) +
                        (self.repo_id, self.branch, file_path) +
                        tuple(tree.direct_importers)
                    )
                    tree.indirect_importers = [row[0] for row in cur.fetchall()]

        return tree

    def detect_circular_dependencies(self, max_cycle_length: int = 10) -> list[CircularDependency]:
        """
        Detect circular dependencies in the import graph.

        Uses DFS to find cycles in the directed import graph.
        Returns all unique cycles found, up to max_cycle_length.
        """
        # Build adjacency list
        graph: dict[str, list[str]] = defaultdict(list)

        with self.conn.cursor() as cur:
            cur.execute(
                """
                SELECT source_file, target_file FROM file_imports
                WHERE repo_id = %s AND branch = %s
                """,
                (self.repo_id, self.branch)
            )

            for row in cur.fetchall():
                graph[row[0]].append(row[1])

        if not graph:
            return []

        cycles: list[CircularDependency] = []
        visited: set[str] = set()
        rec_stack: set[str] = set()
        path: list[str] = []
        seen_cycles: set[frozenset[str]] = set()

        def dfs(node: str) -> None:
            if len(path) > max_cycle_length:
                return

            visited.add(node)
            rec_stack.add(node)
            path.append(node)

            for neighbor in graph.get(node, []):
                if neighbor not in visited:
                    dfs(neighbor)
                elif neighbor in rec_stack:
                    # Found a cycle
                    cycle_start = path.index(neighbor)
                    cycle = path[cycle_start:] + [neighbor]

                    # Normalize cycle for deduplication
                    cycle_set = frozenset(cycle[:-1])
                    if cycle_set not in seen_cycles:
                        seen_cycles.add(cycle_set)
                        cycle_type = "direct" if len(cycle) == 3 else "indirect"
                        cycles.append(CircularDependency(
                            cycle=cycle,
                            cycle_type=cycle_type,
                        ))

            path.pop()
            rec_stack.remove(node)

        # Run DFS from each node
        for node in graph:
            if node not in visited:
                dfs(node)

        return cycles

    def find_hub_files(self, threshold: int = 10, limit: int = 50) -> list[HubFile]:
        """
        Find 'hub' files that are imported by many other files.

        These are high-impact files where changes could affect many dependents.

        Args:
            threshold: Minimum number of importers to be considered a hub
            limit: Maximum number of hub files to return

        Returns:
            List of HubFile objects, sorted by import_count descending
        """
        hubs: list[HubFile] = []

        with self.conn.cursor() as cur:
            cur.execute(
                """
                SELECT target_file, COUNT(*) as import_count,
                       array_agg(source_file ORDER BY source_file) as importers
                FROM file_imports
                WHERE repo_id = %s AND branch = %s
                GROUP BY target_file
                HAVING COUNT(*) >= %s
                ORDER BY import_count DESC
                LIMIT %s
                """,
                (self.repo_id, self.branch, threshold, limit)
            )

            for row in cur.fetchall():
                hubs.append(HubFile(
                    file_path=row[0],
                    import_count=row[1],
                    importers=row[2][:10] if row[2] else [],  # Limit sample to 10
                ))

        return hubs


def build_and_store_import_graph(
    conn: psycopg.Connection,
    repo_url: str,
    branch: str
) -> dict:
    """
    Build and store the import graph for a repository.

    This is the main entry point for import graph construction.
    Should be called after indexing is complete.

    Returns:
        Dictionary with statistics about the import graph
    """
    repo_id = generate_repo_id(repo_url)
    builder = ImportGraphBuilder(conn, repo_id, branch)

    # Build the graph
    edges = builder.build_import_graph()

    # Store it
    stored = builder.store_import_graph(edges)

    # Detect circular dependencies
    cycles = builder.detect_circular_dependencies()

    # Find hub files
    hubs = builder.find_hub_files(threshold=10)

    return {
        "edges": len(edges),
        "stored": stored,
        "circular_dependencies": len(cycles),
        "hub_files": len(hubs),
    }
