#!/usr/bin/env python3
"""
CocoIndex flow for repository file ingestion.

This module defines a CocoIndex flow that:
1. Reads source files from a local repository directory
2. Detects programming language from file extensions
3. Prepares files for downstream chunking and embedding

The flow uses CocoIndex's built-in LocalFile source and DetectProgrammingLanguage
function for robust multi-language support via tree-sitter.

Environment variables:
- COCOINDEX_DATABASE_URL: PostgreSQL connection string (required)
- REPO_PATH: Path to repository to index (default: /repo)
- REPO_URL: Repository URL for identification
- REPO_BRANCH: Branch being indexed (default: main)

Usage:
    # Setup database tables
    cocoindex setup cocoindex_flow.py

    # Run indexing
    cocoindex update cocoindex_flow.py

    # Run with live updates (watch mode)
    cocoindex update -L cocoindex_flow.py
"""

import os
import hashlib

import cocoindex


# Configuration from environment
REPO_PATH = os.environ.get("REPO_PATH", "/repo")
REPO_URL = os.environ.get("REPO_URL", "")
REPO_BRANCH = os.environ.get("REPO_BRANCH", "main")


def generate_repo_id(repo_url: str) -> str:
    """Generate a short unique identifier for a repository URL."""
    return hashlib.sha256(repo_url.encode()).hexdigest()[:16]


# File extensions to include for indexing
# These cover the most common programming languages used in codebases
INCLUDED_PATTERNS = [
    # TypeScript/JavaScript
    "**/*.ts",
    "**/*.tsx",
    "**/*.js",
    "**/*.jsx",
    "**/*.mjs",
    "**/*.cjs",
    # Python
    "**/*.py",
    "**/*.pyi",
    # Systems languages
    "**/*.rs",
    "**/*.go",
    "**/*.c",
    "**/*.cpp",
    "**/*.h",
    "**/*.hpp",
    # JVM languages
    "**/*.java",
    "**/*.kt",
    "**/*.scala",
    # .NET languages
    "**/*.cs",
    "**/*.fs",
    # Other popular languages
    "**/*.rb",
    "**/*.php",
    "**/*.swift",
    # Shell and config
    "**/*.sh",
    "**/*.bash",
    # Markup and data (for context)
    "**/*.md",
    "**/*.json",
    "**/*.yaml",
    "**/*.yml",
    "**/*.toml",
]

# Directories and patterns to exclude from indexing
EXCLUDED_PATTERNS = [
    # Package managers and dependencies
    "**/node_modules/**",
    "**/vendor/**",
    "**/venv/**",
    "**/.venv/**",
    "**/env/**",
    "**/.env/**",
    "**/packages/**/node_modules/**",
    # Build outputs
    "**/dist/**",
    "**/build/**",
    "**/out/**",
    "**/target/**",
    "**/.next/**",
    "**/.nuxt/**",
    "**/coverage/**",
    "**/.nyc_output/**",
    # Version control
    "**/.git/**",
    "**/.svn/**",
    "**/.hg/**",
    # IDE and editor
    "**/.idea/**",
    "**/.vscode/**",
    "**/.vs/**",
    # Cache directories
    "**/__pycache__/**",
    "**/.pytest_cache/**",
    "**/.mypy_cache/**",
    "**/.ruff_cache/**",
    "**/.cache/**",
    # Test snapshots and fixtures (usually not needed for context)
    "**/__snapshots__/**",
    "**/fixtures/**",
    # Lock files (not useful for semantic understanding)
    "**/package-lock.json",
    "**/yarn.lock",
    "**/pnpm-lock.yaml",
    "**/bun.lockb",
    "**/Cargo.lock",
    "**/poetry.lock",
    "**/Pipfile.lock",
    "**/composer.lock",
    "**/Gemfile.lock",
    # Minified/generated files
    "**/*.min.js",
    "**/*.min.css",
    "**/*.bundle.js",
    "**/*.map",
]

# Maximum file size to index (10MB) - skip very large files
MAX_FILE_SIZE = 10_000_000


@cocoindex.flow_def(name="FileIngestion")
def file_ingestion_flow(
    flow_builder: cocoindex.FlowBuilder, data_scope: cocoindex.DataScope
) -> None:
    """
    CocoIndex flow for ingesting repository files.

    This flow reads source files from a local directory, detects their
    programming language using file extension analysis, and prepares
    them for downstream processing (chunking, embedding, export).

    The flow outputs to a 'files' collector that captures:
    - filename: relative path from repo root
    - content: file text content
    - language: detected programming language (or null if unknown)
    - repo_id: unique identifier for the repository
    - repo_url: full repository URL
    - branch: git branch being indexed

    Args:
        flow_builder: CocoIndex flow builder for constructing the pipeline
        data_scope: Data scope for managing flow data
    """
    # Pre-compute repo metadata
    repo_id = generate_repo_id(REPO_URL)

    # Add LocalFile source with pattern-based filtering
    # This efficiently reads only relevant source files
    data_scope["source_files"] = flow_builder.add_source(
        cocoindex.sources.LocalFile(
            path=REPO_PATH,
            binary=False,  # Only text files
            included_patterns=INCLUDED_PATTERNS,
            excluded_patterns=EXCLUDED_PATTERNS,
            max_file_size=MAX_FILE_SIZE,
        )
    )

    # Create collector for processed files
    files_collector = data_scope.add_collector()

    # Process each file from the source
    with data_scope["source_files"].row() as file:
        # Detect programming language from filename extension
        # This uses CocoIndex's tree-sitter integration for accurate detection
        # Returns language name (e.g., "python", "typescript") or null if unknown
        file["language"] = file["filename"].transform(
            cocoindex.functions.DetectProgrammingLanguage()
        )

        # Collect file with metadata
        # This prepares files for downstream chunking and embedding flows
        files_collector.collect(
            filename=file["filename"],
            content=file["content"],
            language=file["language"],
            repo_id=repo_id,
            repo_url=REPO_URL,
            branch=REPO_BRANCH,
        )

    # Export collected files to Postgres
    # The 'files' table stores file-level metadata for incremental updates
    files_collector.export(
        "ingested_files",
        cocoindex.storages.Postgres(),
        primary_key_fields=["repo_id", "branch", "filename"],
    )


# Entry point for CLI usage
if __name__ == "__main__":
    import sys

    # Initialize CocoIndex with environment-based configuration
    cocoindex.init()

    # Print flow information for debugging
    print(f"CocoIndex FileIngestion Flow")
    print(f"  Repository: {REPO_URL}")
    print(f"  Branch: {REPO_BRANCH}")
    print(f"  Path: {REPO_PATH}")
    print(f"  Repo ID: {generate_repo_id(REPO_URL)}")
    print()
    print("To run this flow, use:")
    print("  cocoindex setup cocoindex_flow.py    # Setup tables")
    print("  cocoindex update cocoindex_flow.py   # Run indexing")
    print()

    sys.exit(0)
