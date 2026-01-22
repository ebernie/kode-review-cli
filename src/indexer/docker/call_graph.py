#!/usr/bin/env python3
"""
Call graph builder for TypeScript/JavaScript code using tree-sitter.

This module provides:
- AST-based extraction of function calls from TS/JS code
- Graph construction: function -> [called functions]
- Storage in the relationships table with relationship_type='calls'
- Support for method calls on classes (e.g., this.method(), obj.method())

The call graph is built by parsing the AST of each chunk and extracting
call_expression nodes, then resolving them to target functions/methods.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Generator

import psycopg
import tree_sitter_javascript
import tree_sitter_typescript
from tree_sitter import Language, Parser, Node


def generate_repo_id(repo_url: str) -> str:
    """Generate a short unique identifier for a repository URL."""
    return hashlib.sha256(repo_url.encode()).hexdigest()[:16]


# =============================================================================
# Data Classes
# =============================================================================


@dataclass
class FunctionCall:
    """Represents a function or method call extracted from the AST."""

    # The name of the called function or method
    callee_name: str

    # For method calls: the object/receiver (e.g., "this", "obj", "ClassName")
    receiver: str | None = None

    # Whether this is a method call (obj.method()) vs function call (func())
    is_method_call: bool = False

    # Line number where the call occurs
    line_number: int = 0

    # Whether this is a dynamic call that can't be statically resolved
    is_dynamic: bool = False


@dataclass
class FunctionDefinition:
    """Represents a function or method definition in a chunk."""

    # The name of the function/method
    name: str

    # For methods: the class name it belongs to
    class_name: str | None = None

    # Whether this is a method inside a class
    is_method: bool = False

    # The chunk ID containing this definition
    chunk_id: str = ""

    # File path where this is defined
    file_path: str = ""


@dataclass
class CallEdge:
    """An edge in the call graph from caller to callee."""

    # The chunk ID of the caller (contains the call expression)
    source_chunk_id: str

    # The chunk ID of the callee (contains the function definition)
    target_chunk_id: str

    # Name of the called function/method
    callee_name: str

    # Receiver for method calls (e.g., "this", class name)
    receiver: str | None = None

    # Line number where the call occurs
    line_number: int = 0


# =============================================================================
# Language Configuration for Call Extraction
# =============================================================================


# Node types for function calls by language
CALL_CONFIG: dict[str, dict] = {
    ".js": {
        "language": tree_sitter_javascript.language(),
        "call_types": ["call_expression"],
        "member_expression_type": "member_expression",
        "identifier_type": "identifier",
        "function_types": ["function_declaration", "arrow_function", "function_expression"],
        "class_types": ["class_declaration", "class"],
        "method_types": ["method_definition"],
        "this_keywords": ["this"],
    },
    ".jsx": {
        "language": tree_sitter_javascript.language(),
        "call_types": ["call_expression"],
        "member_expression_type": "member_expression",
        "identifier_type": "identifier",
        "function_types": ["function_declaration", "arrow_function", "function_expression"],
        "class_types": ["class_declaration", "class"],
        "method_types": ["method_definition"],
        "this_keywords": ["this"],
    },
    ".ts": {
        "language": tree_sitter_typescript.language_typescript(),
        "call_types": ["call_expression"],
        "member_expression_type": "member_expression",
        "identifier_type": "identifier",
        "function_types": ["function_declaration", "arrow_function", "function_expression"],
        "class_types": ["class_declaration"],
        "method_types": ["method_definition", "public_field_definition"],
        "this_keywords": ["this"],
    },
    ".tsx": {
        "language": tree_sitter_typescript.language_tsx(),
        "call_types": ["call_expression"],
        "member_expression_type": "member_expression",
        "identifier_type": "identifier",
        "function_types": ["function_declaration", "arrow_function", "function_expression"],
        "class_types": ["class_declaration"],
        "method_types": ["method_definition", "public_field_definition"],
        "this_keywords": ["this"],
    },
    ".mjs": {
        "language": tree_sitter_javascript.language(),
        "call_types": ["call_expression"],
        "member_expression_type": "member_expression",
        "identifier_type": "identifier",
        "function_types": ["function_declaration", "arrow_function", "function_expression"],
        "class_types": ["class_declaration", "class"],
        "method_types": ["method_definition"],
        "this_keywords": ["this"],
    },
    ".mts": {
        "language": tree_sitter_typescript.language_typescript(),
        "call_types": ["call_expression"],
        "member_expression_type": "member_expression",
        "identifier_type": "identifier",
        "function_types": ["function_declaration", "arrow_function", "function_expression"],
        "class_types": ["class_declaration"],
        "method_types": ["method_definition", "public_field_definition"],
        "this_keywords": ["this"],
    },
}


def get_call_config(filename: str) -> dict | None:
    """Get the call extraction configuration for a file based on its extension."""
    ext = Path(filename).suffix.lower()
    return CALL_CONFIG.get(ext)


def is_supported_language(filename: str) -> bool:
    """Check if a file is a supported language for call graph extraction."""
    return get_call_config(filename) is not None


# =============================================================================
# AST-based Call Extraction
# =============================================================================


def extract_calls_from_code(
    content: str,
    filename: str,
    config: dict | None = None
) -> list[FunctionCall]:
    """
    Extract all function and method calls from code using tree-sitter AST.

    Args:
        content: The source code content
        filename: The filename (used for language detection)
        config: Optional language config (auto-detected if not provided)

    Returns:
        List of FunctionCall objects representing all calls in the code
    """
    if config is None:
        config = get_call_config(filename)

    if config is None:
        return []

    source_bytes = content.encode("utf-8")
    language = config["language"]

    parser = Parser(language)
    tree = parser.parse(source_bytes)

    calls: list[FunctionCall] = []

    def extract_callee_info(call_node: Node) -> FunctionCall | None:
        """Extract the callee name and receiver from a call expression."""
        # Get the function part of the call (the thing being called)
        function_node = call_node.child_by_field_name("function")
        if function_node is None:
            # Try first child as fallback
            for child in call_node.children:
                if child.type != "arguments":
                    function_node = child
                    break

        if function_node is None:
            return None

        line_number = call_node.start_point[0] + 1  # Convert to 1-indexed

        # Case 1: Direct function call - func()
        if function_node.type == config["identifier_type"]:
            callee_name = function_node.text.decode("utf-8") if function_node.text else ""
            if callee_name:
                return FunctionCall(
                    callee_name=callee_name,
                    receiver=None,
                    is_method_call=False,
                    line_number=line_number,
                )

        # Case 2: Method call - obj.method() or this.method()
        elif function_node.type == config["member_expression_type"]:
            # Get the property (method name)
            property_node = function_node.child_by_field_name("property")
            object_node = function_node.child_by_field_name("object")

            if property_node is None or object_node is None:
                # Try to extract manually from children
                children = list(function_node.children)
                if len(children) >= 3:
                    # Typically: object, ".", property
                    object_node = children[0]
                    property_node = children[-1]

            if property_node is not None:
                callee_name = property_node.text.decode("utf-8") if property_node.text else ""
                receiver = None
                is_dynamic = False

                if object_node is not None:
                    receiver_text = object_node.text.decode("utf-8") if object_node.text else ""

                    # Check for "this" keyword
                    if receiver_text in config.get("this_keywords", ["this"]):
                        receiver = "this"
                    # Check for identifier (variable or class name)
                    elif object_node.type == config["identifier_type"]:
                        receiver = receiver_text
                    # Check for chained calls like obj.getService().method()
                    elif object_node.type == "call_expression":
                        receiver = "<call_result>"
                        is_dynamic = True
                    # Check for nested member access like obj.prop.method()
                    elif object_node.type == config["member_expression_type"]:
                        # Get the root object
                        root_obj = object_node
                        while root_obj.type == config["member_expression_type"]:
                            child_obj = root_obj.child_by_field_name("object")
                            if child_obj is None:
                                children = list(root_obj.children)
                                if children:
                                    child_obj = children[0]
                            if child_obj is None or child_obj.type != config["member_expression_type"]:
                                break
                            root_obj = child_obj

                        if root_obj.child_by_field_name("object"):
                            root_obj = root_obj.child_by_field_name("object")
                        elif root_obj.children:
                            root_obj = list(root_obj.children)[0]

                        if root_obj:
                            receiver = root_obj.text.decode("utf-8") if root_obj.text else None
                    else:
                        # Dynamic receiver we can't resolve
                        receiver = "<dynamic>"
                        is_dynamic = True

                if callee_name:
                    return FunctionCall(
                        callee_name=callee_name,
                        receiver=receiver,
                        is_method_call=True,
                        line_number=line_number,
                        is_dynamic=is_dynamic,
                    )

        # Case 3: Immediately invoked function expression (IIFE) or other complex patterns
        # These are harder to resolve statically
        elif function_node.type in ["parenthesized_expression", "arrow_function", "function"]:
            return FunctionCall(
                callee_name="<anonymous>",
                receiver=None,
                is_method_call=False,
                line_number=line_number,
                is_dynamic=True,
            )

        return None

    def traverse(node: Node) -> None:
        """Recursively traverse the AST and collect calls."""
        if node.type in config["call_types"]:
            call_info = extract_callee_info(node)
            if call_info:
                calls.append(call_info)

        for child in node.children:
            traverse(child)

    traverse(tree.root_node)
    return calls


def extract_definitions_from_code(
    content: str,
    filename: str,
    config: dict | None = None
) -> list[FunctionDefinition]:
    """
    Extract all function and method definitions from code using tree-sitter AST.

    Args:
        content: The source code content
        filename: The filename (used for language detection)
        config: Optional language config (auto-detected if not provided)

    Returns:
        List of FunctionDefinition objects representing all definitions in the code
    """
    if config is None:
        config = get_call_config(filename)

    if config is None:
        return []

    source_bytes = content.encode("utf-8")
    language = config["language"]

    parser = Parser(language)
    tree = parser.parse(source_bytes)

    definitions: list[FunctionDefinition] = []

    def get_name(node: Node) -> str | None:
        """Extract the name from a function/method node."""
        name_node = node.child_by_field_name("name")
        if name_node:
            return name_node.text.decode("utf-8") if name_node.text else None
        return None

    def traverse(node: Node, current_class: str | None = None) -> None:
        """Recursively traverse the AST and collect definitions."""
        # Check for class definitions
        if node.type in config["class_types"]:
            class_name = get_name(node)
            # Traverse class body with class context
            for child in node.children:
                traverse(child, current_class=class_name)
            return

        # Check for method definitions (inside a class)
        if node.type in config["method_types"] and current_class:
            name = get_name(node)
            if name:
                definitions.append(FunctionDefinition(
                    name=name,
                    class_name=current_class,
                    is_method=True,
                    file_path=filename,
                ))

        # Check for standalone function definitions
        elif node.type in config["function_types"]:
            name = get_name(node)
            if name:
                definitions.append(FunctionDefinition(
                    name=name,
                    class_name=None,
                    is_method=False,
                    file_path=filename,
                ))

        # Continue traversal
        for child in node.children:
            traverse(child, current_class=current_class)

    traverse(tree.root_node)
    return definitions


# =============================================================================
# Call Graph Builder
# =============================================================================


@dataclass
class ChunkInfo:
    """Information about a code chunk from the database."""
    chunk_id: str
    file_path: str
    content: str
    symbol_names: list[str]
    line_start: int
    line_end: int
    chunk_type: str | None


class CallGraphBuilder:
    """
    Builds and stores the call graph for a repository.

    The call graph connects chunks based on function/method calls:
    - Source chunk contains a call expression
    - Target chunk contains the definition of the called function/method

    Relationships are stored with relationship_type='calls'.
    """

    def __init__(self, conn: psycopg.Connection, repo_id: str, branch: str):
        self.conn = conn
        self.repo_id = repo_id
        self.branch = branch
        self._chunks: list[ChunkInfo] | None = None
        self._symbol_to_chunks: dict[str, list[str]] | None = None

    def _load_chunks(self) -> list[ChunkInfo]:
        """Load all chunks for this repo/branch from the database."""
        if self._chunks is not None:
            return self._chunks

        with self.conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, file_path, content, symbol_names, line_start, line_end, chunk_type
                FROM chunks
                WHERE repo_id = %s AND branch = %s
                """,
                (self.repo_id, self.branch)
            )
            rows = cur.fetchall()

        self._chunks = []
        for row in rows:
            self._chunks.append(ChunkInfo(
                chunk_id=str(row[0]),
                file_path=row[1],
                content=row[2],
                symbol_names=row[3] or [],
                line_start=row[4],
                line_end=row[5],
                chunk_type=row[6],
            ))

        return self._chunks

    def _build_symbol_index(self) -> dict[str, list[str]]:
        """Build an index of symbol names to chunk IDs."""
        if self._symbol_to_chunks is not None:
            return self._symbol_to_chunks

        chunks = self._load_chunks()
        self._symbol_to_chunks = {}

        for chunk in chunks:
            for symbol in chunk.symbol_names:
                if symbol not in self._symbol_to_chunks:
                    self._symbol_to_chunks[symbol] = []
                self._symbol_to_chunks[symbol].append(chunk.chunk_id)

        return self._symbol_to_chunks

    def _resolve_call_target(
        self,
        call: FunctionCall,
        source_chunk: ChunkInfo,
        chunks: list[ChunkInfo],
        symbol_index: dict[str, list[str]]
    ) -> str | None:
        """
        Resolve a function call to its target chunk ID.

        Resolution strategy:
        1. For direct function calls: look up the function name in symbol_index
        2. For method calls with "this": look for method in same class/file
        3. For method calls with a receiver: try to resolve the class type

        Returns the target chunk ID or None if not resolvable.
        """
        # Skip dynamic calls that can't be resolved
        if call.is_dynamic:
            return None

        callee_name = call.callee_name

        # Skip very common built-in functions that aren't defined in user code
        builtin_names = {
            "console", "log", "error", "warn", "info", "debug",  # console methods
            "require", "import", "export",  # module system
            "setTimeout", "setInterval", "clearTimeout", "clearInterval",
            "fetch", "JSON", "parse", "stringify",
            "Array", "Object", "String", "Number", "Boolean", "Map", "Set",
            "Promise", "resolve", "reject", "then", "catch", "finally",
            "parseInt", "parseFloat", "isNaN", "isFinite",
            "encodeURIComponent", "decodeURIComponent", "encodeURI", "decodeURI",
            "Math", "Date", "RegExp", "Error",
            "document", "window", "navigator", "location", "history",
            "addEventListener", "removeEventListener", "querySelector", "querySelectorAll",
            "createElement", "getElementById", "getElementsByClassName",
        }

        if callee_name in builtin_names:
            return None

        # Case 1: Direct function call
        if not call.is_method_call:
            target_chunks = symbol_index.get(callee_name, [])

            # Prefer chunks in the same file
            same_file_chunks = [
                cid for cid in target_chunks
                if any(c.chunk_id == cid and c.file_path == source_chunk.file_path for c in chunks)
            ]

            if same_file_chunks:
                # Return the first match in the same file
                for cid in same_file_chunks:
                    if cid != source_chunk.chunk_id:
                        return cid

            # Fall back to any chunk with that symbol
            for cid in target_chunks:
                if cid != source_chunk.chunk_id:
                    return cid

        # Case 2: Method call with "this"
        elif call.receiver == "this":
            # Look for the method in chunks of the same file with chunk_type 'class' or 'method'
            for chunk in chunks:
                if chunk.file_path == source_chunk.file_path and chunk.chunk_id != source_chunk.chunk_id:
                    if callee_name in chunk.symbol_names:
                        return chunk.chunk_id

        # Case 3: Method call with a named receiver (could be a class or variable)
        elif call.receiver and call.receiver not in {"<dynamic>", "<call_result>"}:
            receiver = call.receiver

            # First, check if receiver is a class name and look for the method
            # Pattern: ClassName.staticMethod() or instance.method() where instance is typed

            # Look for method in classes with matching name
            for chunk in chunks:
                # Check if this chunk defines both the class and the method
                if receiver in chunk.symbol_names and callee_name in chunk.symbol_names:
                    if chunk.chunk_id != source_chunk.chunk_id:
                        return chunk.chunk_id

            # Also try just the method name as a fallback
            target_chunks = symbol_index.get(callee_name, [])
            for cid in target_chunks:
                if cid != source_chunk.chunk_id:
                    return cid

        return None

    def build_call_graph(self) -> list[CallEdge]:
        """
        Build the call graph for all TypeScript/JavaScript chunks.

        Returns a list of CallEdge objects representing the call relationships.
        """
        chunks = self._load_chunks()
        symbol_index = self._build_symbol_index()

        edges: list[CallEdge] = []
        seen_edges: set[tuple[str, str, str]] = set()

        for chunk in chunks:
            # Only process supported languages
            if not is_supported_language(chunk.file_path):
                continue

            # Extract calls from this chunk
            calls = extract_calls_from_code(chunk.content, chunk.file_path)

            for call in calls:
                # Try to resolve the call target
                target_chunk_id = self._resolve_call_target(
                    call, chunk, chunks, symbol_index
                )

                if target_chunk_id:
                    # Create edge if not already seen
                    edge_key = (chunk.chunk_id, target_chunk_id, call.callee_name)
                    if edge_key not in seen_edges:
                        seen_edges.add(edge_key)
                        edges.append(CallEdge(
                            source_chunk_id=chunk.chunk_id,
                            target_chunk_id=target_chunk_id,
                            callee_name=call.callee_name,
                            receiver=call.receiver,
                            line_number=call.line_number,
                        ))

        return edges

    def store_call_graph(self, edges: list[CallEdge]) -> int:
        """
        Store call graph edges in the relationships table.

        Uses relationship_type='calls'.

        Returns the number of edges stored.
        """
        if not edges:
            return 0

        # First, delete existing 'calls' relationships for this repo/branch
        with self.conn.cursor() as cur:
            cur.execute(
                """
                DELETE FROM relationships
                WHERE relationship_type = 'calls'
                  AND source_chunk_id IN (
                      SELECT id FROM chunks WHERE repo_id = %s AND branch = %s
                  )
                """,
                (self.repo_id, self.branch)
            )
            deleted = cur.rowcount
            if deleted > 0:
                print(f"  Deleted {deleted} existing 'calls' relationships")

        # Insert new edges
        inserted = 0
        with self.conn.cursor() as cur:
            for edge in edges:
                try:
                    # Validate that both chunk IDs exist
                    cur.execute(
                        "SELECT COUNT(*) FROM chunks WHERE id = %s OR id = %s",
                        (edge.source_chunk_id, edge.target_chunk_id)
                    )
                    count = cur.fetchone()[0]
                    if count < 2:
                        continue

                    metadata = {
                        "callee_name": edge.callee_name,
                        "line_number": edge.line_number,
                    }
                    if edge.receiver:
                        metadata["receiver"] = edge.receiver

                    cur.execute(
                        """
                        INSERT INTO relationships
                        (source_chunk_id, target_chunk_id, relationship_type, metadata)
                        VALUES (%s, %s, 'calls', %s)
                        ON CONFLICT (source_chunk_id, target_chunk_id, relationship_type)
                        DO UPDATE SET metadata = EXCLUDED.metadata
                        """,
                        (
                            edge.source_chunk_id,
                            edge.target_chunk_id,
                            psycopg.types.json.Json(metadata),
                        )
                    )
                    inserted += 1
                except Exception as e:
                    print(f"  Warning: Failed to insert call edge: {e}")

            self.conn.commit()

        return inserted


# =============================================================================
# Public API
# =============================================================================


def build_and_store_call_graph(
    conn: psycopg.Connection,
    repo_url: str,
    branch: str
) -> dict:
    """
    Build and store the call graph for a repository.

    This is the main entry point for call graph construction.
    Should be called after indexing is complete.

    Args:
        conn: Database connection
        repo_url: Repository URL
        branch: Branch name

    Returns:
        Dictionary with statistics about the call graph
    """
    repo_id = generate_repo_id(repo_url)
    builder = CallGraphBuilder(conn, repo_id, branch)

    print(f"Building call graph for {repo_url}@{branch}...")

    # Build the graph
    edges = builder.build_call_graph()
    print(f"  Found {len(edges)} call edges")

    # Store it
    stored = builder.store_call_graph(edges)
    print(f"  Stored {stored} call relationships")

    return {
        "edges_found": len(edges),
        "edges_stored": stored,
        "repo_id": repo_id,
        "branch": branch,
    }


def get_callers(
    conn: psycopg.Connection,
    repo_id: str,
    branch: str,
    function_name: str
) -> list[dict]:
    """
    Find all chunks that call a specific function.

    Args:
        conn: Database connection
        repo_id: Repository ID
        branch: Branch name
        function_name: Name of the function to find callers for

    Returns:
        List of dictionaries with caller information
    """
    callers = []

    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT
                c.file_path,
                c.line_start,
                c.line_end,
                c.content,
                r.metadata
            FROM relationships r
            JOIN chunks c ON c.id = r.source_chunk_id
            JOIN chunks t ON t.id = r.target_chunk_id
            WHERE r.relationship_type = 'calls'
              AND c.repo_id = %s
              AND c.branch = %s
              AND r.metadata->>'callee_name' = %s
            ORDER BY c.file_path, c.line_start
            """,
            (repo_id, branch, function_name)
        )

        for row in cur.fetchall():
            callers.append({
                "file_path": row[0],
                "line_start": row[1],
                "line_end": row[2],
                "content": row[3],
                "metadata": row[4],
            })

    return callers


def get_callees(
    conn: psycopg.Connection,
    repo_id: str,
    branch: str,
    chunk_id: str
) -> list[dict]:
    """
    Find all functions called by a specific chunk.

    Args:
        conn: Database connection
        repo_id: Repository ID
        branch: Branch name
        chunk_id: ID of the chunk to find callees for

    Returns:
        List of dictionaries with callee information
    """
    callees = []

    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT
                t.file_path,
                t.line_start,
                t.line_end,
                t.symbol_names,
                r.metadata
            FROM relationships r
            JOIN chunks t ON t.id = r.target_chunk_id
            WHERE r.relationship_type = 'calls'
              AND r.source_chunk_id = %s
            ORDER BY t.file_path, t.line_start
            """,
            (chunk_id,)
        )

        for row in cur.fetchall():
            callees.append({
                "file_path": row[0],
                "line_start": row[1],
                "line_end": row[2],
                "symbol_names": row[3],
                "metadata": row[4],
            })

    return callees


# =============================================================================
# CLI Entry Point
# =============================================================================


if __name__ == "__main__":
    import os
    import sys

    database_url = os.environ.get("COCOINDEX_DATABASE_URL") or os.environ.get("DATABASE_URL")
    repo_url = os.environ.get("REPO_URL", "")
    branch = os.environ.get("REPO_BRANCH", "main")

    if not database_url:
        print("Error: DATABASE_URL or COCOINDEX_DATABASE_URL required", file=sys.stderr)
        sys.exit(1)

    if not repo_url:
        print("Error: REPO_URL required", file=sys.stderr)
        sys.exit(1)

    conn = psycopg.connect(database_url)

    try:
        result = build_and_store_call_graph(conn, repo_url, branch)
        print(f"\nCall graph statistics:")
        print(f"  Edges found: {result['edges_found']}")
        print(f"  Edges stored: {result['edges_stored']}")
    finally:
        conn.close()
