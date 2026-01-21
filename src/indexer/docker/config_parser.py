#!/usr/bin/env python3
"""
Configuration file detection and parsing.

This module provides intelligent handling of project configuration files:
- Detects config files by filename patterns
- Extracts key metadata (strict mode, lint rules, dependencies)
- Creates structured chunks with chunk_type='config'

Supported config file types:
- TypeScript: tsconfig.json, tsconfig.*.json
- ESLint: eslint.config.*, .eslintrc, .eslintrc.json, .eslintrc.yml
- Prettier: .prettierrc, .prettierrc.json, prettier.config.*
- Package: package.json (extracts key dependencies)
- Python: pyproject.toml, setup.py, setup.cfg, requirements.txt
- Go: go.mod
- Rust: Cargo.toml
- Editor: .editorconfig
- Docker: Dockerfile, docker-compose.yml
- CI/CD: .github/workflows/*, .gitlab-ci.yml
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass
class ConfigMetadata:
    """Metadata extracted from configuration files."""

    config_type: str  # typescript, eslint, prettier, package, python, go, rust, etc.
    strict_mode: bool | None = None
    lint_rules: list[str] = field(default_factory=list)
    dependencies: list[str] = field(default_factory=list)
    dev_dependencies: list[str] = field(default_factory=list)
    target_version: str | None = None
    module_type: str | None = None
    compiler_options: dict[str, Any] = field(default_factory=dict)


@dataclass
class ConfigChunk:
    """A chunk representing a config file with metadata."""

    filename: str
    location: str
    code: str
    start_line: int
    end_line: int
    chunk_type: str = "config"
    symbol_name: str | None = None
    symbol_names: list[str] = field(default_factory=list)
    imports: list[str] = field(default_factory=list)
    exports: list[str] = field(default_factory=list)
    config_metadata: ConfigMetadata | None = None


# Config file patterns with their types
CONFIG_FILE_PATTERNS: dict[str, str] = {
    # TypeScript config
    "tsconfig.json": "typescript",
    "tsconfig.*.json": "typescript",
    "jsconfig.json": "typescript",
    # ESLint config
    "eslint.config.js": "eslint",
    "eslint.config.mjs": "eslint",
    "eslint.config.cjs": "eslint",
    "eslint.config.ts": "eslint",
    ".eslintrc": "eslint",
    ".eslintrc.js": "eslint",
    ".eslintrc.cjs": "eslint",
    ".eslintrc.json": "eslint",
    ".eslintrc.yml": "eslint",
    ".eslintrc.yaml": "eslint",
    # Prettier config
    ".prettierrc": "prettier",
    ".prettierrc.json": "prettier",
    ".prettierrc.yml": "prettier",
    ".prettierrc.yaml": "prettier",
    ".prettierrc.js": "prettier",
    ".prettierrc.cjs": "prettier",
    ".prettierrc.mjs": "prettier",
    "prettier.config.js": "prettier",
    "prettier.config.cjs": "prettier",
    "prettier.config.mjs": "prettier",
    # Package managers
    "package.json": "package",
    "composer.json": "package",
    # Python config
    "pyproject.toml": "python",
    "setup.py": "python",
    "setup.cfg": "python",
    "requirements.txt": "python",
    "Pipfile": "python",
    "tox.ini": "python",
    ".python-version": "python",
    # Go config
    "go.mod": "go",
    # Rust config
    "Cargo.toml": "rust",
    # Editor config
    ".editorconfig": "editor",
    # Docker config
    "Dockerfile": "docker",
    "dockerfile": "docker",
    "docker-compose.yml": "docker",
    "docker-compose.yaml": "docker",
    "compose.yml": "docker",
    "compose.yaml": "docker",
    # CI/CD config
    ".gitlab-ci.yml": "ci",
    ".travis.yml": "ci",
    "Jenkinsfile": "ci",
    "azure-pipelines.yml": "ci",
    ".circleci/config.yml": "ci",
    # Git config
    ".gitignore": "generic",
    ".gitattributes": "generic",
    # Other common configs
    ".npmrc": "generic",
    ".yarnrc": "generic",
    ".nvmrc": "generic",
    "babel.config.js": "generic",
    "babel.config.json": "generic",
    ".babelrc": "generic",
    "webpack.config.js": "generic",
    "vite.config.js": "generic",
    "vite.config.ts": "generic",
    "rollup.config.js": "generic",
    "jest.config.js": "generic",
    "jest.config.ts": "generic",
    "vitest.config.ts": "generic",
    "vitest.config.js": "generic",
    ".env.example": "generic",
    ".env.template": "generic",
}


def is_config_file(filename: str) -> bool:
    """
    Check if a file is a configuration file.

    Args:
        filename: File path (can be relative or absolute)

    Returns:
        True if the file is a recognized config file
    """
    name = Path(filename).name
    parent = Path(filename).parent.name

    # Direct match
    if name in CONFIG_FILE_PATTERNS:
        return True

    # Wildcard patterns for tsconfig.*.json
    if name.startswith("tsconfig.") and name.endswith(".json"):
        return True

    # GitHub workflows
    if ".github/workflows" in filename and (
        filename.endswith(".yml") or filename.endswith(".yaml")
    ):
        return True

    # Check for common config file prefixes/suffixes
    if name.startswith(".") and name.endswith("rc"):
        return True

    if name.endswith(".config.js") or name.endswith(".config.ts"):
        return True

    if name.endswith(".config.mjs") or name.endswith(".config.cjs"):
        return True

    return False


def get_config_type(filename: str) -> str:
    """
    Determine the type of configuration file.

    Args:
        filename: File path

    Returns:
        Config type string (e.g., 'typescript', 'eslint', 'package')
    """
    name = Path(filename).name

    # Direct match
    if name in CONFIG_FILE_PATTERNS:
        return CONFIG_FILE_PATTERNS[name]

    # Wildcard patterns
    if name.startswith("tsconfig.") and name.endswith(".json"):
        return "typescript"

    # GitHub workflows
    if ".github/workflows" in filename:
        return "ci"

    # Generic config patterns
    if name.startswith(".") and name.endswith("rc"):
        return "generic"

    if name.endswith(".config.js") or name.endswith(".config.ts"):
        return "generic"

    return "generic"


def parse_json_safe(content: str) -> dict[str, Any] | None:
    """Safely parse JSON content, handling comments and trailing commas."""
    # Remove single-line comments
    content = re.sub(r"//.*?$", "", content, flags=re.MULTILINE)
    # Remove multi-line comments
    content = re.sub(r"/\*.*?\*/", "", content, flags=re.DOTALL)
    # Remove trailing commas (common in JS config files)
    content = re.sub(r",(\s*[}\]])", r"\1", content)

    try:
        return json.loads(content)
    except json.JSONDecodeError:
        return None


def extract_tsconfig_metadata(content: str) -> ConfigMetadata:
    """Extract metadata from TypeScript configuration."""
    metadata = ConfigMetadata(config_type="typescript")

    data = parse_json_safe(content)
    if not data:
        return metadata

    compiler_opts = data.get("compilerOptions", {})
    metadata.compiler_options = compiler_opts

    # Check for strict mode
    metadata.strict_mode = compiler_opts.get("strict", False)

    # Extract target version
    if "target" in compiler_opts:
        metadata.target_version = compiler_opts["target"]

    # Extract module type
    if "module" in compiler_opts:
        metadata.module_type = compiler_opts["module"]

    return metadata


def extract_eslint_metadata(content: str, filename: str) -> ConfigMetadata:
    """Extract metadata from ESLint configuration."""
    metadata = ConfigMetadata(config_type="eslint")

    # Try JSON format
    if filename.endswith(".json") or filename == ".eslintrc":
        data = parse_json_safe(content)
        if data:
            rules = data.get("rules", {})
            # Extract enabled rules
            for rule, config in rules.items():
                if isinstance(config, str) and config != "off":
                    metadata.lint_rules.append(rule)
                elif isinstance(config, list) and len(config) > 0:
                    if config[0] != "off" and config[0] != 0:
                        metadata.lint_rules.append(rule)

            # Check for strict configurations
            extends = data.get("extends", [])
            if isinstance(extends, str):
                extends = [extends]
            if any("strict" in ext for ext in extends):
                metadata.strict_mode = True

    return metadata


def extract_package_metadata(content: str) -> ConfigMetadata:
    """
    Extract key metadata from package.json.

    Only extracts critical information for LLM context:
    - Key dependencies and their presence
    - Scripts overview
    - Type/module configuration
    """
    metadata = ConfigMetadata(config_type="package")

    data = parse_json_safe(content)
    if not data:
        return metadata

    # Extract dependency names (not versions)
    deps = data.get("dependencies", {})
    if deps:
        # Prioritize key dependencies
        key_deps = [
            "react",
            "vue",
            "angular",
            "svelte",
            "next",
            "nuxt",
            "express",
            "fastify",
            "koa",
            "nest",
            "typescript",
            "webpack",
            "vite",
            "rollup",
            "esbuild",
        ]
        for dep in key_deps:
            if dep in deps:
                metadata.dependencies.append(dep)

        # Add first 10 other dependencies
        other_deps = [d for d in deps.keys() if d not in key_deps][:10]
        metadata.dependencies.extend(other_deps)

    dev_deps = data.get("devDependencies", {})
    if dev_deps:
        # Key dev dependencies
        key_dev_deps = [
            "typescript",
            "eslint",
            "prettier",
            "jest",
            "vitest",
            "mocha",
            "chai",
            "@types/node",
            "ts-node",
            "tsx",
        ]
        for dep in key_dev_deps:
            if dep in dev_deps:
                metadata.dev_dependencies.append(dep)

    # Module type
    if data.get("type") == "module":
        metadata.module_type = "esm"
    elif "main" in data and not data.get("type"):
        metadata.module_type = "commonjs"

    return metadata


def extract_pyproject_metadata(content: str) -> ConfigMetadata:
    """Extract metadata from pyproject.toml."""
    metadata = ConfigMetadata(config_type="python")

    # Simple TOML parsing for key fields
    # Check for Python version - matches requires-python = ">=3.10" or python = ">=3.10"
    version_match = re.search(
        r'(?:requires-python|python)\s*=\s*["\']?[>=<]*(\d+\.\d+)', content, re.IGNORECASE
    )
    if version_match:
        metadata.target_version = version_match.group(1)

    # Check for dependencies
    deps_section = re.search(
        r"\[(?:project\.)?dependencies\](.*?)(?:\[|$)", content, re.DOTALL
    )
    if deps_section:
        deps = re.findall(r'^([a-zA-Z0-9_-]+)', deps_section.group(1), re.MULTILINE)
        metadata.dependencies = deps[:15]  # Limit to 15

    # Check for ruff/black/mypy strict settings
    if "[tool.mypy]" in content:
        if "strict = true" in content:
            metadata.strict_mode = True
    if "[tool.ruff]" in content:
        rules = re.findall(r'select\s*=\s*\[(.*?)\]', content, re.DOTALL)
        if rules:
            metadata.lint_rules = re.findall(r'"([A-Z]+)"', rules[0])

    return metadata


def extract_go_mod_metadata(content: str) -> ConfigMetadata:
    """Extract metadata from go.mod."""
    metadata = ConfigMetadata(config_type="go")

    # Extract Go version
    version_match = re.search(r"^go\s+(\d+\.\d+)", content, re.MULTILINE)
    if version_match:
        metadata.target_version = version_match.group(1)

    # Extract module dependencies
    require_section = re.search(r"require\s*\((.*?)\)", content, re.DOTALL)
    if require_section:
        deps = re.findall(r"^\s*([^\s]+)", require_section.group(1), re.MULTILINE)
        metadata.dependencies = [d for d in deps if d and not d.startswith("//")][:15]
    else:
        # Single-line requires
        deps = re.findall(r"^require\s+([^\s]+)", content, re.MULTILINE)
        metadata.dependencies = deps[:15]

    return metadata


def extract_cargo_metadata(content: str) -> ConfigMetadata:
    """Extract metadata from Cargo.toml."""
    metadata = ConfigMetadata(config_type="rust")

    # Extract Rust edition
    edition_match = re.search(r'^edition\s*=\s*"(\d+)"', content, re.MULTILINE)
    if edition_match:
        metadata.target_version = f"edition {edition_match.group(1)}"

    # Extract dependencies
    deps_section = re.search(r"\[dependencies\](.*?)(?:\[|$)", content, re.DOTALL)
    if deps_section:
        deps = re.findall(r"^([a-zA-Z0-9_-]+)\s*=", deps_section.group(1), re.MULTILINE)
        metadata.dependencies = deps[:15]

    return metadata


def extract_config_metadata(content: str, filename: str) -> ConfigMetadata:
    """
    Extract metadata from a config file based on its type.

    Args:
        content: File content
        filename: File path

    Returns:
        ConfigMetadata with extracted information
    """
    config_type = get_config_type(filename)

    if config_type == "typescript":
        return extract_tsconfig_metadata(content)
    elif config_type == "eslint":
        return extract_eslint_metadata(content, filename)
    elif config_type == "package":
        return extract_package_metadata(content)
    elif config_type == "python":
        return extract_pyproject_metadata(content)
    elif config_type == "go":
        return extract_go_mod_metadata(content)
    elif config_type == "rust":
        return extract_cargo_metadata(content)
    else:
        return ConfigMetadata(config_type=config_type)


def chunk_config_file(content: str, filename: str) -> list[ConfigChunk]:
    """
    Create chunks for a configuration file.

    Config files are typically treated as single chunks since they are
    usually small and semantically cohesive.

    Args:
        content: File content
        filename: File path

    Returns:
        List containing a single ConfigChunk with extracted metadata
    """
    if not content or not content.strip():
        return []

    lines = content.split("\n")
    total_lines = len(lines)

    # Extract metadata
    metadata = extract_config_metadata(content, filename)

    # Create symbol names from important keys
    symbol_names: list[str] = []

    # For config files, symbol names are key configuration keys
    name = Path(filename).name
    if name.startswith("tsconfig"):
        symbol_names.append("tsconfig")
        if metadata.strict_mode:
            symbol_names.append("strict")
        if metadata.target_version:
            symbol_names.append(f"target:{metadata.target_version}")
    elif "eslint" in name.lower():
        symbol_names.append("eslint")
        symbol_names.extend(metadata.lint_rules[:5])  # Top 5 rules
    elif name == "package.json":
        symbol_names.append("package.json")
        symbol_names.extend(metadata.dependencies[:5])  # Top 5 deps
    elif name == "pyproject.toml":
        symbol_names.append("pyproject")
        if metadata.target_version:
            symbol_names.append(f"python:{metadata.target_version}")
    elif name == "go.mod":
        symbol_names.append("go.mod")
        if metadata.target_version:
            symbol_names.append(f"go:{metadata.target_version}")
    elif name == "Cargo.toml":
        symbol_names.append("Cargo.toml")
        if metadata.target_version:
            symbol_names.append(metadata.target_version)

    chunk = ConfigChunk(
        filename=filename,
        location=f"1-{total_lines}",
        code=content,
        start_line=1,
        end_line=total_lines,
        chunk_type="config",
        symbol_name=Path(filename).name,
        symbol_names=symbol_names,
        imports=[],  # Config files don't have imports in the code sense
        exports=[],
        config_metadata=metadata,
    )

    return [chunk]


def metadata_to_dict(metadata: ConfigMetadata) -> dict[str, Any]:
    """Convert ConfigMetadata to a dictionary for serialization."""
    result: dict[str, Any] = {"config_type": metadata.config_type}

    if metadata.strict_mode is not None:
        result["strict_mode"] = metadata.strict_mode
    if metadata.lint_rules:
        result["lint_rules"] = metadata.lint_rules
    if metadata.dependencies:
        result["dependencies"] = metadata.dependencies
    if metadata.dev_dependencies:
        result["dev_dependencies"] = metadata.dev_dependencies
    if metadata.target_version:
        result["target_version"] = metadata.target_version
    if metadata.module_type:
        result["module_type"] = metadata.module_type
    if metadata.compiler_options:
        # Only include key compiler options
        key_opts = ["strict", "target", "module", "lib", "esModuleInterop", "jsx"]
        result["compiler_options"] = {
            k: v for k, v in metadata.compiler_options.items() if k in key_opts
        }

    return result
