#!/usr/bin/env python3
"""
Tests for the configuration file detection and parsing module.

Run with: python -m pytest test_config_parser.py -v
Or simply: python test_config_parser.py
"""

import unittest
from config_parser import (
    is_config_file,
    get_config_type,
    chunk_config_file,
    extract_config_metadata,
    extract_tsconfig_metadata,
    extract_eslint_metadata,
    extract_package_metadata,
    extract_pyproject_metadata,
    extract_go_mod_metadata,
    extract_cargo_metadata,
    metadata_to_dict,
    ConfigMetadata,
)


class TestConfigFileDetection(unittest.TestCase):
    """Test configuration file detection."""

    def test_tsconfig_json(self):
        self.assertTrue(is_config_file("tsconfig.json"))
        self.assertTrue(is_config_file("./tsconfig.json"))
        self.assertTrue(is_config_file("project/tsconfig.json"))
        self.assertTrue(is_config_file("tsconfig.build.json"))
        self.assertTrue(is_config_file("tsconfig.app.json"))

    def test_eslint_configs(self):
        self.assertTrue(is_config_file("eslint.config.js"))
        self.assertTrue(is_config_file("eslint.config.mjs"))
        self.assertTrue(is_config_file("eslint.config.cjs"))
        self.assertTrue(is_config_file("eslint.config.ts"))
        self.assertTrue(is_config_file(".eslintrc"))
        self.assertTrue(is_config_file(".eslintrc.json"))
        self.assertTrue(is_config_file(".eslintrc.yml"))

    def test_prettier_configs(self):
        self.assertTrue(is_config_file(".prettierrc"))
        self.assertTrue(is_config_file(".prettierrc.json"))
        self.assertTrue(is_config_file(".prettierrc.yml"))
        self.assertTrue(is_config_file("prettier.config.js"))
        self.assertTrue(is_config_file("prettier.config.mjs"))

    def test_package_json(self):
        self.assertTrue(is_config_file("package.json"))
        self.assertTrue(is_config_file("./package.json"))
        self.assertTrue(is_config_file("packages/core/package.json"))

    def test_python_configs(self):
        self.assertTrue(is_config_file("pyproject.toml"))
        self.assertTrue(is_config_file("setup.py"))
        self.assertTrue(is_config_file("setup.cfg"))
        self.assertTrue(is_config_file("requirements.txt"))
        self.assertTrue(is_config_file("Pipfile"))
        self.assertTrue(is_config_file("tox.ini"))
        self.assertTrue(is_config_file(".python-version"))

    def test_go_config(self):
        self.assertTrue(is_config_file("go.mod"))
        self.assertTrue(is_config_file("./go.mod"))

    def test_rust_config(self):
        self.assertTrue(is_config_file("Cargo.toml"))
        self.assertTrue(is_config_file("./Cargo.toml"))

    def test_docker_configs(self):
        self.assertTrue(is_config_file("Dockerfile"))
        self.assertTrue(is_config_file("docker-compose.yml"))
        self.assertTrue(is_config_file("docker-compose.yaml"))
        self.assertTrue(is_config_file("compose.yml"))

    def test_ci_configs(self):
        self.assertTrue(is_config_file(".gitlab-ci.yml"))
        self.assertTrue(is_config_file(".travis.yml"))
        self.assertTrue(is_config_file("Jenkinsfile"))
        self.assertTrue(is_config_file(".github/workflows/ci.yml"))
        self.assertTrue(is_config_file(".github/workflows/test.yaml"))

    def test_generic_configs(self):
        self.assertTrue(is_config_file(".editorconfig"))
        self.assertTrue(is_config_file(".npmrc"))
        self.assertTrue(is_config_file(".nvmrc"))
        self.assertTrue(is_config_file("babel.config.js"))
        self.assertTrue(is_config_file("webpack.config.js"))
        self.assertTrue(is_config_file("vite.config.ts"))
        self.assertTrue(is_config_file("jest.config.js"))
        self.assertTrue(is_config_file("vitest.config.ts"))

    def test_rc_files(self):
        # Generic *rc files should be detected
        self.assertTrue(is_config_file(".babelrc"))
        self.assertTrue(is_config_file(".npmrc"))

    def test_non_config_files(self):
        self.assertFalse(is_config_file("index.ts"))
        self.assertFalse(is_config_file("main.py"))
        self.assertFalse(is_config_file("README.md"))
        self.assertFalse(is_config_file("utils.js"))


class TestGetConfigType(unittest.TestCase):
    """Test configuration type detection."""

    def test_typescript_type(self):
        self.assertEqual(get_config_type("tsconfig.json"), "typescript")
        self.assertEqual(get_config_type("tsconfig.build.json"), "typescript")
        self.assertEqual(get_config_type("jsconfig.json"), "typescript")

    def test_eslint_type(self):
        self.assertEqual(get_config_type("eslint.config.js"), "eslint")
        self.assertEqual(get_config_type(".eslintrc"), "eslint")
        self.assertEqual(get_config_type(".eslintrc.json"), "eslint")

    def test_prettier_type(self):
        self.assertEqual(get_config_type(".prettierrc"), "prettier")
        self.assertEqual(get_config_type("prettier.config.js"), "prettier")

    def test_package_type(self):
        self.assertEqual(get_config_type("package.json"), "package")
        self.assertEqual(get_config_type("composer.json"), "package")

    def test_python_type(self):
        self.assertEqual(get_config_type("pyproject.toml"), "python")
        self.assertEqual(get_config_type("setup.py"), "python")
        self.assertEqual(get_config_type("requirements.txt"), "python")

    def test_go_type(self):
        self.assertEqual(get_config_type("go.mod"), "go")

    def test_rust_type(self):
        self.assertEqual(get_config_type("Cargo.toml"), "rust")

    def test_docker_type(self):
        self.assertEqual(get_config_type("Dockerfile"), "docker")
        self.assertEqual(get_config_type("docker-compose.yml"), "docker")

    def test_ci_type(self):
        self.assertEqual(get_config_type(".gitlab-ci.yml"), "ci")
        self.assertEqual(get_config_type(".github/workflows/ci.yml"), "ci")


class TestTsconfigMetadataExtraction(unittest.TestCase):
    """Test TypeScript config metadata extraction."""

    def test_strict_mode_enabled(self):
        content = '''{
            "compilerOptions": {
                "strict": true,
                "target": "ES2022",
                "module": "NodeNext"
            }
        }'''
        metadata = extract_tsconfig_metadata(content)
        self.assertEqual(metadata.config_type, "typescript")
        self.assertTrue(metadata.strict_mode)
        self.assertEqual(metadata.target_version, "ES2022")
        self.assertEqual(metadata.module_type, "NodeNext")

    def test_strict_mode_disabled(self):
        content = '''{
            "compilerOptions": {
                "strict": false,
                "target": "ES5"
            }
        }'''
        metadata = extract_tsconfig_metadata(content)
        self.assertFalse(metadata.strict_mode)
        self.assertEqual(metadata.target_version, "ES5")

    def test_with_comments(self):
        content = '''{
            // This is a comment
            "compilerOptions": {
                "strict": true,
                /* Another comment */
                "target": "ES2020"
            }
        }'''
        metadata = extract_tsconfig_metadata(content)
        self.assertTrue(metadata.strict_mode)
        self.assertEqual(metadata.target_version, "ES2020")

    def test_trailing_comma(self):
        content = '''{
            "compilerOptions": {
                "strict": true,
                "target": "ES2022",
            },
        }'''
        metadata = extract_tsconfig_metadata(content)
        self.assertTrue(metadata.strict_mode)


class TestEslintMetadataExtraction(unittest.TestCase):
    """Test ESLint config metadata extraction."""

    def test_rules_extraction(self):
        content = '''{
            "rules": {
                "no-unused-vars": "error",
                "no-console": "warn",
                "eqeqeq": ["error", "always"],
                "semi": "off"
            }
        }'''
        metadata = extract_eslint_metadata(content, ".eslintrc.json")
        self.assertEqual(metadata.config_type, "eslint")
        self.assertIn("no-unused-vars", metadata.lint_rules)
        self.assertIn("no-console", metadata.lint_rules)
        self.assertIn("eqeqeq", metadata.lint_rules)
        # "off" rules should not be included
        self.assertNotIn("semi", metadata.lint_rules)

    def test_strict_extends(self):
        content = '''{
            "extends": ["eslint:recommended", "plugin:@typescript-eslint/strict"]
        }'''
        metadata = extract_eslint_metadata(content, ".eslintrc.json")
        self.assertTrue(metadata.strict_mode)


class TestPackageMetadataExtraction(unittest.TestCase):
    """Test package.json metadata extraction."""

    def test_dependencies_extraction(self):
        content = '''{
            "dependencies": {
                "react": "^18.0.0",
                "express": "^4.18.0",
                "lodash": "^4.17.0"
            },
            "devDependencies": {
                "typescript": "^5.0.0",
                "eslint": "^8.0.0",
                "jest": "^29.0.0"
            },
            "type": "module"
        }'''
        metadata = extract_package_metadata(content)
        self.assertEqual(metadata.config_type, "package")
        self.assertIn("react", metadata.dependencies)
        self.assertIn("express", metadata.dependencies)
        self.assertIn("typescript", metadata.dev_dependencies)
        self.assertIn("eslint", metadata.dev_dependencies)
        self.assertIn("jest", metadata.dev_dependencies)
        self.assertEqual(metadata.module_type, "esm")

    def test_commonjs_detection(self):
        content = '''{
            "main": "index.js",
            "dependencies": {}
        }'''
        metadata = extract_package_metadata(content)
        self.assertEqual(metadata.module_type, "commonjs")


class TestPyprojectMetadataExtraction(unittest.TestCase):
    """Test pyproject.toml metadata extraction."""

    def test_python_version_extraction(self):
        content = '''[project]
name = "myproject"
requires-python = ">=3.10"

[project.dependencies]
fastapi = "^0.100.0"
pydantic = "^2.0.0"

[tool.mypy]
strict = true

[tool.ruff]
select = ["E", "W", "F"]
'''
        metadata = extract_pyproject_metadata(content)
        self.assertEqual(metadata.config_type, "python")
        self.assertEqual(metadata.target_version, "3.10")
        self.assertTrue(metadata.strict_mode)
        self.assertIn("E", metadata.lint_rules)
        self.assertIn("W", metadata.lint_rules)


class TestGoModMetadataExtraction(unittest.TestCase):
    """Test go.mod metadata extraction."""

    def test_go_version_extraction(self):
        content = '''module github.com/example/myapp

go 1.21

require (
    github.com/gin-gonic/gin v1.9.1
    github.com/spf13/cobra v1.7.0
)
'''
        metadata = extract_go_mod_metadata(content)
        self.assertEqual(metadata.config_type, "go")
        self.assertEqual(metadata.target_version, "1.21")
        self.assertIn("github.com/gin-gonic/gin", metadata.dependencies)


class TestCargoMetadataExtraction(unittest.TestCase):
    """Test Cargo.toml metadata extraction."""

    def test_rust_edition_extraction(self):
        content = '''[package]
name = "myapp"
version = "0.1.0"
edition = "2021"

[dependencies]
tokio = "1.28"
serde = "1.0"
'''
        metadata = extract_cargo_metadata(content)
        self.assertEqual(metadata.config_type, "rust")
        self.assertEqual(metadata.target_version, "edition 2021")
        self.assertIn("tokio", metadata.dependencies)
        self.assertIn("serde", metadata.dependencies)


class TestChunkConfigFile(unittest.TestCase):
    """Test config file chunking."""

    def test_tsconfig_chunking(self):
        content = '''{
            "compilerOptions": {
                "strict": true,
                "target": "ES2022"
            }
        }'''
        chunks = chunk_config_file(content, "tsconfig.json")
        self.assertEqual(len(chunks), 1)
        self.assertEqual(chunks[0].chunk_type, "config")
        self.assertEqual(chunks[0].symbol_name, "tsconfig.json")
        self.assertIn("tsconfig", chunks[0].symbol_names)
        self.assertIn("strict", chunks[0].symbol_names)

    def test_package_json_chunking(self):
        content = '''{
            "name": "myapp",
            "dependencies": {
                "react": "^18.0.0",
                "express": "^4.18.0"
            }
        }'''
        chunks = chunk_config_file(content, "package.json")
        self.assertEqual(len(chunks), 1)
        self.assertEqual(chunks[0].chunk_type, "config")
        self.assertIn("package.json", chunks[0].symbol_names)
        self.assertIn("react", chunks[0].symbol_names)
        self.assertIn("express", chunks[0].symbol_names)

    def test_empty_content(self):
        chunks = chunk_config_file("", "tsconfig.json")
        self.assertEqual(len(chunks), 0)

    def test_whitespace_only(self):
        chunks = chunk_config_file("   \n\n   ", "package.json")
        self.assertEqual(len(chunks), 0)

    def test_line_numbers(self):
        content = '''line1
line2
line3
line4
line5'''
        chunks = chunk_config_file(content, "config.json")
        self.assertEqual(len(chunks), 1)
        self.assertEqual(chunks[0].start_line, 1)
        self.assertEqual(chunks[0].end_line, 5)


class TestMetadataToDict(unittest.TestCase):
    """Test metadata serialization."""

    def test_full_metadata_serialization(self):
        metadata = ConfigMetadata(
            config_type="typescript",
            strict_mode=True,
            lint_rules=["no-unused-vars"],
            dependencies=["react"],
            dev_dependencies=["typescript"],
            target_version="ES2022",
            module_type="esm",
            compiler_options={"strict": True, "target": "ES2022", "obscure_option": True},
        )
        result = metadata_to_dict(metadata)

        self.assertEqual(result["config_type"], "typescript")
        self.assertTrue(result["strict_mode"])
        self.assertEqual(result["lint_rules"], ["no-unused-vars"])
        self.assertEqual(result["target_version"], "ES2022")
        # Only key compiler options should be included
        self.assertIn("strict", result["compiler_options"])
        self.assertIn("target", result["compiler_options"])
        self.assertNotIn("obscure_option", result["compiler_options"])

    def test_minimal_metadata_serialization(self):
        metadata = ConfigMetadata(config_type="generic")
        result = metadata_to_dict(metadata)

        self.assertEqual(result["config_type"], "generic")
        # Empty lists/None values should not be in result
        self.assertNotIn("strict_mode", result)
        self.assertNotIn("lint_rules", result)


def requires_tree_sitter(test_func):
    """Decorator to skip tests that require tree-sitter when it's not available."""
    try:
        import tree_sitter_python
        return test_func
    except ImportError:
        return unittest.skip("tree-sitter not available (runs in Docker)")(test_func)


class TestIntegrationWithAstChunker(unittest.TestCase):
    """Integration tests with ast_chunker.

    These tests require tree-sitter which is only available in the Docker environment.
    They will be skipped when run locally without tree-sitter installed.
    """

    @requires_tree_sitter
    def test_config_file_through_ast_chunker(self):
        """Test that config files are properly handled through the main entry point."""
        from ast_chunker import chunk_code_ast

        content = '''{
            "compilerOptions": {
                "strict": true,
                "target": "ES2022"
            }
        }'''
        chunks = chunk_code_ast(content, "tsconfig.json")

        self.assertEqual(len(chunks), 1)
        self.assertEqual(chunks[0].chunk_type, "config")
        self.assertIn("tsconfig", chunks[0].symbol_names)

    @requires_tree_sitter
    def test_non_config_json_uses_fallback(self):
        """Non-config JSON files should use fallback chunking."""
        from ast_chunker import chunk_code_ast

        content = '''{"data": [1, 2, 3]}'''
        chunks = chunk_code_ast(content, "data.json")

        # data.json is not a config file, should use fallback
        self.assertEqual(len(chunks), 1)
        self.assertEqual(chunks[0].chunk_type, "other")

    @requires_tree_sitter
    def test_pyproject_through_ast_chunker(self):
        """Test pyproject.toml detection."""
        from ast_chunker import chunk_code_ast

        content = '''[project]
name = "myproject"
requires-python = ">=3.10"
'''
        chunks = chunk_code_ast(content, "pyproject.toml")

        self.assertEqual(len(chunks), 1)
        self.assertEqual(chunks[0].chunk_type, "config")
        self.assertIn("pyproject", chunks[0].symbol_names)


if __name__ == "__main__":
    unittest.main(verbosity=2)
