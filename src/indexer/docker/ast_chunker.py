#!/usr/bin/env python3
"""
AST-based code chunking using tree-sitter.

This module provides intelligent code chunking that respects function/class boundaries,
keeping semantic units together for better embedding quality.

Key features:
- Never splits a function or class across chunks
- Includes docstrings/comments with their associated code
- Handles nested functions (includes in parent or separates based on size threshold)
- Falls back to line-based chunking for non-parseable files
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Generator

# Tree-sitter imports
import tree_sitter_python
import tree_sitter_javascript
import tree_sitter_typescript
import tree_sitter_go
import tree_sitter_rust
import tree_sitter_java
import tree_sitter_c
import tree_sitter_cpp
import tree_sitter_ruby
import tree_sitter_php
import tree_sitter_c_sharp
from tree_sitter import Language, Parser, Node

# Configuration
NESTED_FUNCTION_SIZE_THRESHOLD = int(os.environ.get("NESTED_FUNCTION_THRESHOLD", "50"))
FALLBACK_MAX_LINES = int(os.environ.get("FALLBACK_MAX_LINES", "500"))
FALLBACK_OVERLAP_LINES = int(os.environ.get("FALLBACK_OVERLAP_LINES", "50"))


@dataclass
class CodeChunk:
    """A chunk of code with metadata."""
    filename: str
    location: str
    code: str
    start_line: int
    end_line: int
    chunk_type: str = "other"  # function, class, method, module, other
    symbol_name: str | None = None


@dataclass
class ASTNode:
    """Represents a parsed AST node with relevant metadata."""
    node_type: str
    name: str | None
    start_line: int
    end_line: int
    start_byte: int
    end_byte: int
    content: str
    children: list[ASTNode] = field(default_factory=list)
    leading_comments: str = ""

    @property
    def line_count(self) -> int:
        return self.end_line - self.start_line + 1


# Language configuration: maps file extensions to tree-sitter languages and node types
LANGUAGE_CONFIG: dict[str, dict] = {
    # Python
    ".py": {
        "language": tree_sitter_python.language(),
        "function_types": ["function_definition"],
        "class_types": ["class_definition"],
        "method_types": ["function_definition"],  # Python methods are just functions inside classes
        "comment_types": ["comment"],
        "docstring_types": ["expression_statement"],  # Docstrings are expression statements with strings
        "name_field": "name",
    },
    # JavaScript/TypeScript
    ".js": {
        "language": tree_sitter_javascript.language(),
        "function_types": ["function_declaration", "arrow_function", "function_expression", "generator_function_declaration"],
        "class_types": ["class_declaration", "class"],
        "method_types": ["method_definition"],
        "comment_types": ["comment"],
        "docstring_types": [],
        "name_field": "name",
    },
    ".jsx": {
        "language": tree_sitter_javascript.language(),
        "function_types": ["function_declaration", "arrow_function", "function_expression", "generator_function_declaration"],
        "class_types": ["class_declaration", "class"],
        "method_types": ["method_definition"],
        "comment_types": ["comment"],
        "docstring_types": [],
        "name_field": "name",
    },
    ".ts": {
        "language": tree_sitter_typescript.language_typescript(),
        "function_types": ["function_declaration", "arrow_function", "function_expression", "generator_function_declaration"],
        "class_types": ["class_declaration"],
        "method_types": ["method_definition", "public_field_definition"],
        "interface_types": ["interface_declaration", "type_alias_declaration"],
        "comment_types": ["comment"],
        "docstring_types": [],
        "name_field": "name",
    },
    ".tsx": {
        "language": tree_sitter_typescript.language_tsx(),
        "function_types": ["function_declaration", "arrow_function", "function_expression", "generator_function_declaration"],
        "class_types": ["class_declaration"],
        "method_types": ["method_definition", "public_field_definition"],
        "interface_types": ["interface_declaration", "type_alias_declaration"],
        "comment_types": ["comment"],
        "docstring_types": [],
        "name_field": "name",
    },
    # Go
    ".go": {
        "language": tree_sitter_go.language(),
        "function_types": ["function_declaration"],
        "class_types": ["type_declaration"],  # Go uses type declarations for structs
        "method_types": ["method_declaration"],
        "comment_types": ["comment"],
        "docstring_types": [],
        "name_field": "name",
    },
    # Rust
    ".rs": {
        "language": tree_sitter_rust.language(),
        "function_types": ["function_item"],
        "class_types": ["struct_item", "enum_item", "impl_item", "trait_item"],
        "method_types": ["function_item"],  # Methods in Rust are functions inside impl blocks
        "comment_types": ["line_comment", "block_comment"],
        "docstring_types": ["line_comment"],  # Doc comments in Rust are /// or //!
        "name_field": "name",
    },
    # Java
    ".java": {
        "language": tree_sitter_java.language(),
        "function_types": [],  # Java doesn't have standalone functions
        "class_types": ["class_declaration", "interface_declaration", "enum_declaration"],
        "method_types": ["method_declaration", "constructor_declaration"],
        "comment_types": ["line_comment", "block_comment"],
        "docstring_types": ["block_comment"],  # Javadoc
        "name_field": "name",
    },
    # C/C++
    ".c": {
        "language": tree_sitter_c.language(),
        "function_types": ["function_definition"],
        "class_types": ["struct_specifier", "union_specifier", "enum_specifier"],
        "method_types": [],
        "comment_types": ["comment"],
        "docstring_types": ["comment"],
        "name_field": "declarator",
    },
    ".h": {
        "language": tree_sitter_c.language(),
        "function_types": ["function_definition", "declaration"],
        "class_types": ["struct_specifier", "union_specifier", "enum_specifier"],
        "method_types": [],
        "comment_types": ["comment"],
        "docstring_types": ["comment"],
        "name_field": "declarator",
    },
    ".cpp": {
        "language": tree_sitter_cpp.language(),
        "function_types": ["function_definition"],
        "class_types": ["class_specifier", "struct_specifier", "enum_specifier"],
        "method_types": ["function_definition"],
        "comment_types": ["comment"],
        "docstring_types": ["comment"],
        "name_field": "declarator",
    },
    ".hpp": {
        "language": tree_sitter_cpp.language(),
        "function_types": ["function_definition", "declaration"],
        "class_types": ["class_specifier", "struct_specifier", "enum_specifier"],
        "method_types": ["function_definition"],
        "comment_types": ["comment"],
        "docstring_types": ["comment"],
        "name_field": "declarator",
    },
    # Ruby
    ".rb": {
        "language": tree_sitter_ruby.language(),
        "function_types": ["method", "singleton_method"],
        "class_types": ["class", "module"],
        "method_types": ["method", "singleton_method"],
        "comment_types": ["comment"],
        "docstring_types": [],
        "name_field": "name",
    },
    # PHP
    ".php": {
        "language": tree_sitter_php.language_php(),
        "function_types": ["function_definition"],
        "class_types": ["class_declaration", "interface_declaration", "trait_declaration"],
        "method_types": ["method_declaration"],
        "comment_types": ["comment"],
        "docstring_types": ["comment"],
        "name_field": "name",
    },
    # C#
    ".cs": {
        "language": tree_sitter_c_sharp.language(),
        "function_types": [],  # C# doesn't have standalone functions
        "class_types": ["class_declaration", "interface_declaration", "struct_declaration", "enum_declaration"],
        "method_types": ["method_declaration", "constructor_declaration"],
        "comment_types": ["comment"],
        "docstring_types": ["comment"],  # XML doc comments
        "name_field": "name",
    },
}


def get_language_config(filename: str) -> dict | None:
    """Get the language configuration for a file based on its extension."""
    ext = Path(filename).suffix.lower()
    return LANGUAGE_CONFIG.get(ext)


def create_parser(language: Language) -> Parser:
    """Create a tree-sitter parser for the given language."""
    parser = Parser(language)
    return parser


def get_node_name(node: Node, config: dict) -> str | None:
    """Extract the name from a node based on language configuration."""
    name_field = config.get("name_field", "name")

    # Try to get name from the named field
    name_node = node.child_by_field_name(name_field)
    if name_node:
        return name_node.text.decode("utf-8") if name_node.text else None

    # For some languages (like C), we need to traverse differently
    if name_field == "declarator":
        declarator = node.child_by_field_name("declarator")
        if declarator:
            # Handle function declarators
            if declarator.type == "function_declarator":
                inner_declarator = declarator.child_by_field_name("declarator")
                if inner_declarator:
                    return inner_declarator.text.decode("utf-8") if inner_declarator.text else None
            return declarator.text.decode("utf-8") if declarator.text else None

    return None


def get_leading_comments(node: Node, source_bytes: bytes, config: dict) -> str:
    """Extract comments that immediately precede a node (docstrings/documentation)."""
    comment_types = config.get("comment_types", [])
    docstring_types = config.get("docstring_types", [])

    comments = []
    current = node.prev_named_sibling

    while current:
        if current.type in comment_types or current.type in docstring_types:
            # Check if this comment is on the line immediately before or same line as previous comment
            comment_end_line = current.end_point[0]
            next_start_line = node.start_point[0] if not comments else comments[-1].start_point[0]

            # Allow up to 1 blank line between comment and code
            if next_start_line - comment_end_line <= 2:
                comments.insert(0, current)
                current = current.prev_named_sibling
            else:
                break
        else:
            break

    if not comments:
        return ""

    # Extract comment text
    comment_parts = []
    for c in comments:
        text = source_bytes[c.start_byte:c.end_byte].decode("utf-8", errors="ignore")
        comment_parts.append(text)

    return "\n".join(comment_parts) + "\n"


def is_nested_function(node: Node, config: dict) -> bool:
    """Check if a function node is nested inside another function or class."""
    function_types = config.get("function_types", [])
    class_types = config.get("class_types", [])
    method_types = config.get("method_types", [])

    parent = node.parent
    while parent:
        if parent.type in function_types:
            return True
        # Methods inside classes are not considered nested
        if parent.type in class_types:
            return False
        parent = parent.parent

    return False


def extract_semantic_units(
    node: Node,
    source_bytes: bytes,
    config: dict,
    parent_is_class: bool = False
) -> Generator[ASTNode, None, None]:
    """
    Recursively extract semantic units (functions, classes, methods) from the AST.

    This function traverses the tree and yields ASTNode objects for each
    semantic boundary (function, class, method, interface, etc.).
    """
    function_types = config.get("function_types", [])
    class_types = config.get("class_types", [])
    method_types = config.get("method_types", [])
    interface_types = config.get("interface_types", [])

    # Determine node type
    is_function = node.type in function_types
    is_class = node.type in class_types
    is_method = node.type in method_types and parent_is_class
    is_interface = node.type in interface_types if interface_types else False

    if is_function or is_class or is_method or is_interface:
        # Get leading comments/docstrings
        leading_comments = get_leading_comments(node, source_bytes, config)

        # Calculate line range including leading comments
        if leading_comments:
            comment_lines = leading_comments.count("\n")
            start_line = node.start_point[0] + 1 - comment_lines
        else:
            start_line = node.start_point[0] + 1  # Convert to 1-indexed

        end_line = node.end_point[0] + 1

        # Determine chunk type
        if is_class:
            chunk_type = "class"
        elif is_interface:
            chunk_type = "interface"
        elif is_method:
            chunk_type = "method"
        else:
            chunk_type = "function"

        # Create the AST node
        content = source_bytes[node.start_byte:node.end_byte].decode("utf-8", errors="ignore")
        full_content = leading_comments + content

        ast_node = ASTNode(
            node_type=chunk_type,
            name=get_node_name(node, config),
            start_line=start_line,
            end_line=end_line,
            start_byte=node.start_byte,
            end_byte=node.end_byte,
            content=full_content,
            leading_comments=leading_comments,
        )

        # For classes, we need to also extract nested methods/functions
        if is_class:
            for child in node.children:
                for nested in extract_semantic_units(child, source_bytes, config, parent_is_class=True):
                    ast_node.children.append(nested)

        yield ast_node
    else:
        # Not a semantic unit, recurse into children
        for child in node.children:
            yield from extract_semantic_units(child, source_bytes, config, parent_is_class=parent_is_class)


def should_separate_nested(nested: ASTNode, parent: ASTNode) -> bool:
    """
    Determine if a nested function should be extracted separately.

    Based on the acceptance criteria:
    - Handle nested functions (include in parent or separate based on size threshold of 50 lines)
    """
    return nested.line_count >= NESTED_FUNCTION_SIZE_THRESHOLD


def chunk_with_ast(content: str, filename: str, config: dict) -> list[CodeChunk]:
    """
    Chunk code using AST-based function/class boundary detection.

    Returns a list of CodeChunk objects, each representing a semantic unit.
    """
    source_bytes = content.encode("utf-8")
    language = config["language"]

    parser = create_parser(language)
    tree = parser.parse(source_bytes)

    if tree.root_node.has_error:
        # Tree has parsing errors, but we can still try to extract what we can
        pass

    chunks: list[CodeChunk] = []
    lines = content.split("\n")
    total_lines = len(lines)

    # Extract all top-level semantic units
    semantic_units = list(extract_semantic_units(tree.root_node, source_bytes, config))

    if not semantic_units:
        # No semantic units found, return the whole file as a single chunk
        return [CodeChunk(
            filename=filename,
            location=f"1-{total_lines}",
            code=content,
            start_line=1,
            end_line=total_lines,
            chunk_type="module",
            symbol_name=None,
        )]

    # Sort units by start line
    semantic_units.sort(key=lambda x: x.start_line)

    # Track which lines are covered by semantic units
    covered_ranges: list[tuple[int, int]] = []

    for unit in semantic_units:
        # Handle nested functions/methods
        if unit.children:
            large_nested = [c for c in unit.children if should_separate_nested(c, unit)]

            if large_nested:
                # Extract large nested functions separately
                for nested in large_nested:
                    chunks.append(CodeChunk(
                        filename=filename,
                        location=f"{nested.start_line}-{nested.end_line}",
                        code=nested.content,
                        start_line=nested.start_line,
                        end_line=nested.end_line,
                        chunk_type=nested.node_type,
                        symbol_name=nested.name,
                    ))

        # Add the main unit
        chunks.append(CodeChunk(
            filename=filename,
            location=f"{unit.start_line}-{unit.end_line}",
            code=unit.content,
            start_line=unit.start_line,
            end_line=unit.end_line,
            chunk_type=unit.node_type,
            symbol_name=unit.name,
        ))

        covered_ranges.append((unit.start_line, unit.end_line))

    # Find gaps (module-level code, imports, etc.) and chunk them
    covered_ranges.sort()
    gaps = find_uncovered_ranges(covered_ranges, total_lines)

    for gap_start, gap_end in gaps:
        gap_lines = lines[gap_start - 1:gap_end]  # Convert to 0-indexed for slicing
        gap_content = "\n".join(gap_lines)

        # Only include non-empty gaps
        if gap_content.strip():
            chunks.append(CodeChunk(
                filename=filename,
                location=f"{gap_start}-{gap_end}",
                code=gap_content,
                start_line=gap_start,
                end_line=gap_end,
                chunk_type="other",
                symbol_name=None,
            ))

    # Sort chunks by start line for consistent output
    chunks.sort(key=lambda c: c.start_line)

    return chunks


def find_uncovered_ranges(
    covered: list[tuple[int, int]],
    total_lines: int
) -> list[tuple[int, int]]:
    """Find line ranges not covered by any semantic unit."""
    if not covered:
        return [(1, total_lines)]

    gaps = []
    current_pos = 1

    for start, end in covered:
        if current_pos < start:
            gaps.append((current_pos, start - 1))
        current_pos = max(current_pos, end + 1)

    if current_pos <= total_lines:
        gaps.append((current_pos, total_lines))

    return gaps


def chunk_with_fallback(
    content: str,
    filename: str,
    max_lines: int = FALLBACK_MAX_LINES,
    overlap_lines: int = FALLBACK_OVERLAP_LINES
) -> list[CodeChunk]:
    """
    Line-based fallback chunking for files that can't be parsed.

    Uses a maximum of 500 lines per chunk with overlap for context.
    """
    lines = content.split("\n")
    total_lines = len(lines)

    if total_lines <= max_lines:
        return [CodeChunk(
            filename=filename,
            location=f"1-{total_lines}",
            code=content,
            start_line=1,
            end_line=total_lines,
            chunk_type="other",
            symbol_name=None,
        )]

    chunks = []
    start = 0

    while start < total_lines:
        end = min(start + max_lines, total_lines)
        chunk_lines = lines[start:end]

        chunks.append(CodeChunk(
            filename=filename,
            location=f"{start + 1}-{end}",  # 1-indexed
            code="\n".join(chunk_lines),
            start_line=start + 1,
            end_line=end,
            chunk_type="other",
            symbol_name=None,
        ))

        # Move forward, accounting for overlap
        start = end - overlap_lines if end < total_lines else total_lines

    return chunks


def chunk_code_ast(content: str, filename: str) -> list[CodeChunk]:
    """
    Main entry point for AST-based code chunking.

    Attempts to use AST-based chunking if the language is supported,
    otherwise falls back to line-based chunking.

    Args:
        content: The source code content
        filename: The filename (used for extension detection)

    Returns:
        List of CodeChunk objects
    """
    if not content.strip():
        return []

    config = get_language_config(filename)

    if config is None:
        # Language not supported, use fallback
        return chunk_with_fallback(content, filename)

    try:
        chunks = chunk_with_ast(content, filename, config)
        if chunks:
            return chunks
        # AST parsing succeeded but no chunks found, use fallback
        return chunk_with_fallback(content, filename)
    except Exception as e:
        # AST parsing failed, use fallback
        print(f"  Warning: AST parsing failed for {filename}: {e}, using line-based fallback")
        return chunk_with_fallback(content, filename)


# Export the main function with an alias matching the existing interface
def chunk_code(content: str, filename: str, chunk_size: int = 1000, overlap: int = 300) -> list[CodeChunk]:
    """
    Backward-compatible interface for code chunking.

    This function now uses AST-based chunking by default.
    The chunk_size and overlap parameters are kept for backward compatibility
    but are only used in the line-based fallback.
    """
    return chunk_code_ast(content, filename)
