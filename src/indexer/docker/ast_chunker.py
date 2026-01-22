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

# Config file detection
from config_parser import is_config_file, chunk_config_file, ConfigChunk

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
    chunk_type: str = "other"  # function, class, method, module, interface, other
    symbol_name: str | None = None  # Primary symbol (backward compatibility)
    symbol_names: list[str] = field(default_factory=list)  # All symbols defined in this chunk
    imports: list[str] = field(default_factory=list)  # Import paths/modules
    exports: list[str] = field(default_factory=list)  # Exported symbol names


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
# Note: In tree-sitter 0.21+, language bindings return PyCapsule objects that must be
# wrapped with Language() for use with Parser
LANGUAGE_CONFIG: dict[str, dict] = {
    # Python
    ".py": {
        "language": Language(tree_sitter_python.language()),
        "function_types": ["function_definition"],
        "class_types": ["class_definition"],
        "method_types": ["function_definition"],  # Python methods are just functions inside classes
        "comment_types": ["comment"],
        "docstring_types": ["expression_statement"],  # Docstrings are expression statements with strings
        "name_field": "name",
        "import_types": ["import_statement", "import_from_statement"],
        "export_types": [],  # Python uses __all__ for exports, handled specially
    },
    # JavaScript/TypeScript
    ".js": {
        "language": Language(tree_sitter_javascript.language()),
        "function_types": ["function_declaration", "arrow_function", "function_expression", "generator_function_declaration"],
        "class_types": ["class_declaration", "class"],
        "method_types": ["method_definition"],
        "comment_types": ["comment"],
        "docstring_types": [],
        "name_field": "name",
        "import_types": ["import_statement"],
        "export_types": ["export_statement"],
    },
    ".jsx": {
        "language": Language(tree_sitter_javascript.language()),
        "function_types": ["function_declaration", "arrow_function", "function_expression", "generator_function_declaration"],
        "class_types": ["class_declaration", "class"],
        "method_types": ["method_definition"],
        "comment_types": ["comment"],
        "docstring_types": [],
        "name_field": "name",
        "import_types": ["import_statement"],
        "export_types": ["export_statement"],
    },
    ".ts": {
        "language": Language(tree_sitter_typescript.language_typescript()),
        "function_types": ["function_declaration", "arrow_function", "function_expression", "generator_function_declaration"],
        "class_types": ["class_declaration"],
        "method_types": ["method_definition", "public_field_definition"],
        "interface_types": ["interface_declaration", "type_alias_declaration"],
        "comment_types": ["comment"],
        "docstring_types": [],
        "name_field": "name",
        "import_types": ["import_statement"],
        "export_types": ["export_statement"],
    },
    ".tsx": {
        "language": Language(tree_sitter_typescript.language_tsx()),
        "function_types": ["function_declaration", "arrow_function", "function_expression", "generator_function_declaration"],
        "class_types": ["class_declaration"],
        "method_types": ["method_definition", "public_field_definition"],
        "interface_types": ["interface_declaration", "type_alias_declaration"],
        "comment_types": ["comment"],
        "docstring_types": [],
        "name_field": "name",
        "import_types": ["import_statement"],
        "export_types": ["export_statement"],
    },
    # Go
    ".go": {
        "language": Language(tree_sitter_go.language()),
        "function_types": ["function_declaration"],
        "class_types": ["type_declaration"],  # Go uses type declarations for structs
        "method_types": ["method_declaration"],
        "comment_types": ["comment"],
        "docstring_types": [],
        "name_field": "name",
        "import_types": ["import_declaration"],
        "export_types": [],  # Go exports via capitalization
    },
    # Rust
    ".rs": {
        "language": Language(tree_sitter_rust.language()),
        "function_types": ["function_item"],
        "class_types": ["struct_item", "enum_item", "impl_item", "trait_item"],
        "method_types": ["function_item"],  # Methods in Rust are functions inside impl blocks
        "comment_types": ["line_comment", "block_comment"],
        "docstring_types": ["line_comment"],  # Doc comments in Rust are /// or //!
        "name_field": "name",
        "import_types": ["use_declaration"],
        "export_types": [],  # Rust uses pub keyword, detected differently
    },
    # Java
    ".java": {
        "language": Language(tree_sitter_java.language()),
        "function_types": [],  # Java doesn't have standalone functions
        "class_types": ["class_declaration", "interface_declaration", "enum_declaration"],
        "method_types": ["method_declaration", "constructor_declaration"],
        "comment_types": ["line_comment", "block_comment"],
        "docstring_types": ["block_comment"],  # Javadoc
        "name_field": "name",
        "import_types": ["import_declaration"],
        "export_types": [],  # Java uses public keyword
    },
    # C/C++
    ".c": {
        "language": Language(tree_sitter_c.language()),
        "function_types": ["function_definition"],
        "class_types": ["struct_specifier", "union_specifier", "enum_specifier"],
        "method_types": [],
        "comment_types": ["comment"],
        "docstring_types": ["comment"],
        "name_field": "declarator",
        "import_types": ["preproc_include"],
        "export_types": [],  # C uses header files
    },
    ".h": {
        "language": Language(tree_sitter_c.language()),
        "function_types": ["function_definition", "declaration"],
        "class_types": ["struct_specifier", "union_specifier", "enum_specifier"],
        "method_types": [],
        "comment_types": ["comment"],
        "docstring_types": ["comment"],
        "name_field": "declarator",
        "import_types": ["preproc_include"],
        "export_types": [],  # C uses header files
    },
    ".cpp": {
        "language": Language(tree_sitter_cpp.language()),
        "function_types": ["function_definition"],
        "class_types": ["class_specifier", "struct_specifier", "enum_specifier"],
        "method_types": ["function_definition"],
        "comment_types": ["comment"],
        "docstring_types": ["comment"],
        "name_field": "declarator",
        "import_types": ["preproc_include"],
        "export_types": [],  # C++ uses header files
    },
    ".hpp": {
        "language": Language(tree_sitter_cpp.language()),
        "function_types": ["function_definition", "declaration"],
        "class_types": ["class_specifier", "struct_specifier", "enum_specifier"],
        "method_types": ["function_definition"],
        "comment_types": ["comment"],
        "docstring_types": ["comment"],
        "name_field": "declarator",
        "import_types": ["preproc_include"],
        "export_types": [],  # C++ uses header files
    },
    # Ruby
    ".rb": {
        "language": Language(tree_sitter_ruby.language()),
        "function_types": ["method", "singleton_method"],
        "class_types": ["class", "module"],
        "method_types": ["method", "singleton_method"],
        "comment_types": ["comment"],
        "docstring_types": [],
        "name_field": "name",
        "import_types": ["call"],  # require/require_relative are method calls
        "export_types": [],  # Ruby uses module_function or public
    },
    # PHP
    ".php": {
        "language": Language(tree_sitter_php.language_php()),
        "function_types": ["function_definition"],
        "class_types": ["class_declaration", "interface_declaration", "trait_declaration"],
        "method_types": ["method_declaration"],
        "comment_types": ["comment"],
        "docstring_types": ["comment"],
        "name_field": "name",
        "import_types": ["namespace_use_declaration"],
        "export_types": [],  # PHP uses namespaces
    },
    # C#
    ".cs": {
        "language": Language(tree_sitter_c_sharp.language()),
        "function_types": [],  # C# doesn't have standalone functions
        "class_types": ["class_declaration", "interface_declaration", "struct_declaration", "enum_declaration"],
        "method_types": ["method_declaration", "constructor_declaration"],
        "comment_types": ["comment"],
        "docstring_types": ["comment"],  # XML doc comments
        "name_field": "name",
        "import_types": ["using_directive"],
        "export_types": [],  # C# uses public keyword
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


def extract_imports(node: Node, source_bytes: bytes, config: dict) -> list[str]:
    """
    Extract import statements from the AST root node.

    Returns a list of module/file paths being imported.
    Attempts to resolve relative imports to file paths where possible.
    """
    import_types = config.get("import_types", [])
    if not import_types:
        return []

    imports: list[str] = []

    def traverse_for_imports(n: Node) -> None:
        if n.type in import_types:
            # Extract the import path based on language
            import_text = source_bytes[n.start_byte:n.end_byte].decode("utf-8", errors="ignore")
            import_path = _parse_import_path(n, import_text, config)
            if import_path:
                imports.extend(import_path if isinstance(import_path, list) else [import_path])
        else:
            for child in n.children:
                traverse_for_imports(child)

    traverse_for_imports(node)
    return list(set(imports))  # Deduplicate


def _parse_import_path(node: Node, import_text: str, config: dict) -> list[str] | str | None:
    """
    Parse import path from import statement text.

    Handles language-specific import syntax:
    - Python: import foo, from foo import bar
    - JavaScript/TypeScript: import x from 'path'
    - Go: import "path/to/pkg"
    - Rust: use crate::module
    - Java: import com.package.Class
    - C/C++: #include <header.h> or #include "header.h"
    """
    import re

    # JavaScript/TypeScript: import x from 'path' or import 'path'
    # Check this FIRST before Python, because both use "import_statement" type
    # but JS/TS has a "source" child node while Python doesn't
    if node.type == "import_statement":
        # Try JS/TS style first - look for the source string node
        source_node = node.child_by_field_name("source")
        if source_node:
            path = source_node.text.decode("utf-8", errors="ignore").strip("'\"")
            return path

        # Try regex for JS/TS style: import ... from 'path' or import 'path'
        match = re.search(r'from\s+[\'"]([^\'"]+)[\'"]', import_text)
        if match:
            return match.group(1)
        match = re.search(r'import\s+[\'"]([^\'"]+)[\'"]', import_text)
        if match:
            return match.group(1)

        # Python style: import foo, bar (no quotes, no 'from' keyword with quotes)
        # Only match if there are no quotes in the import text (Python style)
        if "'" not in import_text and '"' not in import_text:
            match = re.search(r'import\s+([^\n]+)', import_text)
            if match:
                modules = [m.strip().split(' as ')[0].strip() for m in match.group(1).split(',')]
                return modules

    # Python: from foo import bar
    elif node.type == "import_from_statement":
        match = re.search(r'from\s+([\w.]+)', import_text)
        if match:
            return match.group(1)

    # Go: import "path" or import ( "path1" "path2" )
    elif node.type == "import_declaration":
        matches = re.findall(r'[\'"]([^\'"]+)[\'"]', import_text)
        return matches if matches else None

    # Rust: use crate::foo::bar or use std::collections::HashMap
    elif node.type == "use_declaration":
        match = re.search(r'use\s+([^;{]+)', import_text)
        if match:
            path = match.group(1).strip()
            # Handle {a, b} syntax
            if '{' in path:
                base = path.split('{')[0].rstrip(':')
                return base
            return path

    # Java: import com.example.Class
    elif node.type == "import_declaration":
        match = re.search(r'import\s+(?:static\s+)?([^;\s]+)', import_text)
        if match:
            return match.group(1)

    # C/C++: #include <header.h> or #include "header.h"
    elif node.type == "preproc_include":
        match = re.search(r'#include\s*[<"]([^>"]+)[>"]', import_text)
        if match:
            return match.group(1)

    # PHP: use Namespace\Class
    elif node.type == "namespace_use_declaration":
        match = re.search(r'use\s+([^;,\s]+)', import_text)
        if match:
            return match.group(1)

    # C#: using Namespace
    elif node.type == "using_directive":
        match = re.search(r'using\s+(?:static\s+)?([^;=\s]+)', import_text)
        if match:
            return match.group(1)

    # Ruby: require/require_relative
    elif node.type == "call":
        if 'require' in import_text:
            match = re.search(r'require(?:_relative)?\s*[\(]?\s*[\'"]([^\'"]+)[\'"]', import_text)
            if match:
                return match.group(1)

    return None


def extract_exports(node: Node, source_bytes: bytes, config: dict, filename: str) -> list[str]:
    """
    Extract exported symbol names from the AST root node.

    Returns a list of symbol names that are exported from this file.
    """
    export_types = config.get("export_types", [])
    exports: list[str] = []

    def traverse_for_exports(n: Node) -> None:
        if n.type in export_types:
            export_text = source_bytes[n.start_byte:n.end_byte].decode("utf-8", errors="ignore")
            exported = _parse_export_symbols(n, export_text, config)
            if exported:
                exports.extend(exported if isinstance(exported, list) else [exported])
        else:
            for child in n.children:
                traverse_for_exports(child)

    if export_types:
        traverse_for_exports(node)

    # Handle Python's __all__ for exports
    ext = Path(filename).suffix.lower()
    if ext == ".py":
        py_exports = _extract_python_all(source_bytes)
        exports.extend(py_exports)

    return list(set(exports))  # Deduplicate


def _parse_export_symbols(node: Node, export_text: str, config: dict) -> list[str] | None:
    """
    Parse exported symbol names from export statement.

    Handles language-specific export syntax:
    - JavaScript/TypeScript: export { a, b }, export default X, export function foo()
    """
    import re

    # JavaScript/TypeScript exports
    if node.type == "export_statement":
        symbols = []

        # export default X
        if "export default" in export_text:
            # Try to find the identifier after default
            match = re.search(r'export\s+default\s+(?:class|function)?\s*(\w+)', export_text)
            if match:
                symbols.append(match.group(1))
            else:
                symbols.append("default")
            return symbols

        # export { a, b, c }
        match = re.search(r'export\s*\{([^}]+)\}', export_text)
        if match:
            items = match.group(1).split(',')
            for item in items:
                item = item.strip()
                # Handle "foo as bar" syntax - export the local name
                if ' as ' in item:
                    item = item.split(' as ')[0].strip()
                if item:
                    symbols.append(item)
            return symbols

        # export function foo() or export class Bar or export const x
        match = re.search(r'export\s+(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+(\w+)', export_text)
        if match:
            symbols.append(match.group(1))
            return symbols

        # export * from './module' - re-export (we note it as star export)
        if 'export *' in export_text:
            match = re.search(r'from\s+[\'"]([^\'"]+)[\'"]', export_text)
            if match:
                return [f"* from {match.group(1)}"]

    return None


def _extract_python_all(source_bytes: bytes) -> list[str]:
    """
    Extract symbols from Python's __all__ = [...] declaration.
    """
    import re

    content = source_bytes.decode("utf-8", errors="ignore")
    # Match __all__ = ['a', 'b', 'c'] or __all__ = ["a", "b", "c"]
    match = re.search(r'__all__\s*=\s*\[([^\]]+)\]', content)
    if match:
        items = match.group(1)
        # Extract quoted strings
        symbols = re.findall(r'[\'"]([^\'"]+)[\'"]', items)
        return symbols
    return []


def extract_all_symbols_from_chunk(
    node: Node,
    source_bytes: bytes,
    config: dict,
    start_line: int,
    end_line: int
) -> list[str]:
    """
    Extract all symbol names (functions, classes, methods) defined within a line range.

    This traverses the AST and collects names of all definitions within the chunk boundaries.
    """
    function_types = config.get("function_types", [])
    class_types = config.get("class_types", [])
    method_types = config.get("method_types", [])
    interface_types = config.get("interface_types", [])

    symbols: list[str] = []

    def traverse(n: Node) -> None:
        node_start = n.start_point[0] + 1  # Convert to 1-indexed
        node_end = n.end_point[0] + 1

        # Skip nodes completely outside our range
        if node_end < start_line or node_start > end_line:
            return

        # Check if this is a symbol-defining node
        if n.type in function_types or n.type in class_types or n.type in method_types:
            name = get_node_name(n, config)
            if name:
                symbols.append(name)

        if interface_types and n.type in interface_types:
            name = get_node_name(n, config)
            if name:
                symbols.append(name)

        # Recurse into children
        for child in n.children:
            traverse(child)

    traverse(node)
    return list(dict.fromkeys(symbols))  # Deduplicate while preserving order


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
    Now includes symbol_names, imports, and exports for each chunk.
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

    # Extract file-level imports and exports once
    file_imports = extract_imports(tree.root_node, source_bytes, config)
    file_exports = extract_exports(tree.root_node, source_bytes, config, filename)

    # Extract all top-level semantic units
    semantic_units = list(extract_semantic_units(tree.root_node, source_bytes, config))

    if not semantic_units:
        # No semantic units found, return the whole file as a single chunk
        # Extract any symbols defined at module level
        all_symbols = extract_all_symbols_from_chunk(
            tree.root_node, source_bytes, config, 1, total_lines
        )
        return [CodeChunk(
            filename=filename,
            location=f"1-{total_lines}",
            code=content,
            start_line=1,
            end_line=total_lines,
            chunk_type="module",
            symbol_name=None,
            symbol_names=all_symbols,
            imports=file_imports,
            exports=file_exports,
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
                    # Get all symbols in this nested chunk
                    nested_symbols = [nested.name] if nested.name else []
                    # For classes, include child method names too
                    for child in nested.children:
                        if child.name:
                            nested_symbols.append(child.name)

                    chunks.append(CodeChunk(
                        filename=filename,
                        location=f"{nested.start_line}-{nested.end_line}",
                        code=nested.content,
                        start_line=nested.start_line,
                        end_line=nested.end_line,
                        chunk_type=nested.node_type,
                        symbol_name=nested.name,
                        symbol_names=nested_symbols,
                        imports=[],  # Nested functions don't have imports
                        exports=[],  # Nested functions don't have exports
                    ))

        # Collect symbols for this unit
        unit_symbols = [unit.name] if unit.name else []

        # For classes, include method names
        if unit.node_type == "class" and unit.children:
            for child in unit.children:
                if child.name:
                    unit_symbols.append(child.name)

        # Add the main unit
        chunks.append(CodeChunk(
            filename=filename,
            location=f"{unit.start_line}-{unit.end_line}",
            code=unit.content,
            start_line=unit.start_line,
            end_line=unit.end_line,
            chunk_type=unit.node_type,
            symbol_name=unit.name,
            symbol_names=unit_symbols,
            imports=[],  # Individual semantic units don't carry imports
            exports=[unit.name] if unit.name and unit.name in file_exports else [],
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
            # Extract symbols defined in this gap (e.g., module-level constants)
            gap_symbols = extract_all_symbols_from_chunk(
                tree.root_node, source_bytes, config, gap_start, gap_end
            )

            chunks.append(CodeChunk(
                filename=filename,
                location=f"{gap_start}-{gap_end}",
                code=gap_content,
                start_line=gap_start,
                end_line=gap_end,
                chunk_type="other",
                symbol_name=None,
                symbol_names=gap_symbols,
                imports=file_imports,  # Module-level code often contains imports
                exports=[],  # Gap code doesn't typically have explicit exports
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

    For configuration files (tsconfig.json, eslint.config.*, pyproject.toml, etc.),
    uses specialized config file handling with chunk_type='config'.

    Args:
        content: The source code content
        filename: The filename (used for extension detection)

    Returns:
        List of CodeChunk objects
    """
    if not content.strip():
        return []

    # Check if this is a config file first
    if is_config_file(filename):
        config_chunks = chunk_config_file(content, filename)
        # Convert ConfigChunk to CodeChunk
        return [
            CodeChunk(
                filename=c.filename,
                location=c.location,
                code=c.code,
                start_line=c.start_line,
                end_line=c.end_line,
                chunk_type=c.chunk_type,
                symbol_name=c.symbol_name,
                symbol_names=c.symbol_names,
                imports=c.imports,
                exports=c.exports,
            )
            for c in config_chunks
        ]

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
