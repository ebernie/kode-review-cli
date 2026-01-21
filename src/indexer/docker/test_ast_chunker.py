#!/usr/bin/env python3
"""
Tests for the AST-based code chunking module.

Run with: python -m pytest test_ast_chunker.py -v
Or simply: python test_ast_chunker.py
"""

import unittest
from ast_chunker import (
    chunk_code_ast,
    chunk_with_fallback,
    get_language_config,
    CodeChunk,
    NESTED_FUNCTION_SIZE_THRESHOLD,
)


class TestLanguageConfig(unittest.TestCase):
    """Test language configuration detection."""

    def test_python_config(self):
        config = get_language_config("test.py")
        self.assertIsNotNone(config)
        self.assertIn("function_definition", config["function_types"])
        self.assertIn("class_definition", config["class_types"])

    def test_typescript_config(self):
        config = get_language_config("test.ts")
        self.assertIsNotNone(config)
        self.assertIn("function_declaration", config["function_types"])
        self.assertIn("class_declaration", config["class_types"])

    def test_tsx_config(self):
        config = get_language_config("component.tsx")
        self.assertIsNotNone(config)

    def test_unsupported_extension(self):
        config = get_language_config("test.xyz")
        self.assertIsNone(config)

    def test_markdown_fallback(self):
        # Markdown is not in our AST config, should return None
        config = get_language_config("README.md")
        self.assertIsNone(config)


class TestPythonChunking(unittest.TestCase):
    """Test AST-based chunking for Python code."""

    def test_single_function(self):
        code = '''def hello():
    """Say hello."""
    print("Hello, world!")
'''
        chunks = chunk_code_ast(code, "test.py")
        self.assertEqual(len(chunks), 1)
        self.assertEqual(chunks[0].chunk_type, "function")
        self.assertEqual(chunks[0].symbol_name, "hello")
        self.assertIn("def hello", chunks[0].code)

    def test_multiple_functions(self):
        code = '''def foo():
    return 1

def bar():
    return 2

def baz():
    return 3
'''
        chunks = chunk_code_ast(code, "test.py")
        function_chunks = [c for c in chunks if c.chunk_type == "function"]
        self.assertEqual(len(function_chunks), 3)
        names = {c.symbol_name for c in function_chunks}
        self.assertEqual(names, {"foo", "bar", "baz"})

    def test_class_with_methods(self):
        code = '''class Calculator:
    """A simple calculator."""

    def add(self, a, b):
        return a + b

    def subtract(self, a, b):
        return a - b
'''
        chunks = chunk_code_ast(code, "test.py")
        class_chunks = [c for c in chunks if c.chunk_type == "class"]
        self.assertEqual(len(class_chunks), 1)
        self.assertEqual(class_chunks[0].symbol_name, "Calculator")
        # The class chunk should contain both methods
        self.assertIn("def add", class_chunks[0].code)
        self.assertIn("def subtract", class_chunks[0].code)

    def test_function_with_docstring(self):
        code = '''def greet(name):
    """
    Greet a person by name.

    Args:
        name: The person's name

    Returns:
        A greeting string
    """
    return f"Hello, {name}!"
'''
        chunks = chunk_code_ast(code, "test.py")
        self.assertEqual(len(chunks), 1)
        self.assertIn('"""', chunks[0].code)
        self.assertIn("Args:", chunks[0].code)

    def test_function_never_split(self):
        # Create a function that's longer than typical chunk size
        lines = ["def long_function():"]
        for i in range(100):
            lines.append(f"    x_{i} = {i}")
        lines.append("    return x_99")
        code = "\n".join(lines)

        chunks = chunk_code_ast(code, "test.py")
        function_chunks = [c for c in chunks if c.chunk_type == "function"]
        self.assertEqual(len(function_chunks), 1)
        # The entire function should be in one chunk
        self.assertIn("def long_function", function_chunks[0].code)
        self.assertIn("return x_99", function_chunks[0].code)

    def test_module_level_code(self):
        code = '''import os
import sys

CONSTANT = 42

def my_func():
    pass
'''
        chunks = chunk_code_ast(code, "test.py")
        # Should have the function and module-level code
        self.assertTrue(any(c.chunk_type == "function" for c in chunks))
        self.assertTrue(any("import os" in c.code for c in chunks))


class TestNestedFunctions(unittest.TestCase):
    """Test handling of nested functions."""

    def test_small_nested_included_in_parent(self):
        # Nested function smaller than threshold should stay in parent
        code = '''def outer():
    def inner():
        return 1
    return inner()
'''
        chunks = chunk_code_ast(code, "test.py")
        outer_chunks = [c for c in chunks if c.symbol_name == "outer"]
        self.assertEqual(len(outer_chunks), 1)
        # Inner function should be included in outer
        self.assertIn("def inner", outer_chunks[0].code)

    def test_large_nested_separated(self):
        # Create a nested function larger than threshold (50 lines)
        inner_lines = ["    def large_inner():"]
        for i in range(55):
            inner_lines.append(f"        x_{i} = {i}")
        inner_lines.append("        return x_54")

        code = f'''def outer():
{chr(10).join(inner_lines)}
    return large_inner()
'''
        chunks = chunk_code_ast(code, "test.py")
        # Should have both outer and large_inner as separate chunks
        names = {c.symbol_name for c in chunks if c.symbol_name}
        self.assertIn("outer", names)
        # The large inner function should be extracted separately
        large_inner_chunks = [c for c in chunks if c.symbol_name == "large_inner"]
        if large_inner_chunks:
            self.assertTrue(len(large_inner_chunks[0].code.split("\n")) >= 50)


class TestTypeScriptChunking(unittest.TestCase):
    """Test AST-based chunking for TypeScript code."""

    def test_function_declaration(self):
        code = '''function greet(name: string): string {
    return `Hello, ${name}!`;
}
'''
        chunks = chunk_code_ast(code, "test.ts")
        self.assertEqual(len(chunks), 1)
        self.assertEqual(chunks[0].chunk_type, "function")

    def test_arrow_function(self):
        code = '''const add = (a: number, b: number): number => {
    return a + b;
};
'''
        chunks = chunk_code_ast(code, "test.ts")
        # Arrow functions should be captured
        self.assertTrue(any("=>" in c.code for c in chunks))

    def test_class_declaration(self):
        code = '''class UserService {
    private users: User[] = [];

    addUser(user: User): void {
        this.users.push(user);
    }

    getUser(id: string): User | undefined {
        return this.users.find(u => u.id === id);
    }
}
'''
        chunks = chunk_code_ast(code, "test.ts")
        class_chunks = [c for c in chunks if c.chunk_type == "class"]
        self.assertEqual(len(class_chunks), 1)
        self.assertEqual(class_chunks[0].symbol_name, "UserService")

    def test_interface_declaration(self):
        code = '''interface User {
    id: string;
    name: string;
    email: string;
}
'''
        chunks = chunk_code_ast(code, "test.ts")
        interface_chunks = [c for c in chunks if c.chunk_type == "interface"]
        self.assertEqual(len(interface_chunks), 1)


class TestFallbackChunking(unittest.TestCase):
    """Test line-based fallback chunking."""

    def test_small_file(self):
        code = "line 1\nline 2\nline 3"
        chunks = chunk_with_fallback(code, "test.md")
        self.assertEqual(len(chunks), 1)
        self.assertEqual(chunks[0].start_line, 1)
        self.assertEqual(chunks[0].end_line, 3)

    def test_large_file_chunking(self):
        # Create a file with more than 500 lines
        lines = [f"line {i}" for i in range(600)]
        code = "\n".join(lines)
        chunks = chunk_with_fallback(code, "test.md", max_lines=500)
        self.assertGreater(len(chunks), 1)
        # Each chunk should have at most 500 lines
        for chunk in chunks:
            line_count = chunk.end_line - chunk.start_line + 1
            self.assertLessEqual(line_count, 500)

    def test_unsupported_language_uses_fallback(self):
        code = "Some markdown content\n" * 100
        chunks = chunk_code_ast(code, "README.md")
        self.assertGreater(len(chunks), 0)
        # Should use fallback since .md is not in our AST config
        self.assertEqual(chunks[0].chunk_type, "other")


class TestEdgeCases(unittest.TestCase):
    """Test edge cases and error handling."""

    def test_empty_content(self):
        chunks = chunk_code_ast("", "test.py")
        self.assertEqual(len(chunks), 0)

    def test_whitespace_only(self):
        chunks = chunk_code_ast("   \n\n   ", "test.py")
        self.assertEqual(len(chunks), 0)

    def test_syntax_error_fallback(self):
        # Invalid Python syntax
        code = "def broken(\nreturn 1"
        chunks = chunk_code_ast(code, "test.py")
        # Should still produce chunks (either partial AST or fallback)
        self.assertGreater(len(chunks), 0)

    def test_line_numbers_correct(self):
        code = '''

def foo():
    pass

def bar():
    pass
'''
        chunks = chunk_code_ast(code, "test.py")
        foo_chunk = next((c for c in chunks if c.symbol_name == "foo"), None)
        bar_chunk = next((c for c in chunks if c.symbol_name == "bar"), None)

        if foo_chunk and bar_chunk:
            # bar should start after foo ends
            self.assertGreater(bar_chunk.start_line, foo_chunk.end_line)


class TestGoChunking(unittest.TestCase):
    """Test AST-based chunking for Go code."""

    def test_function(self):
        code = '''func Hello(name string) string {
    return "Hello, " + name
}
'''
        chunks = chunk_code_ast(code, "test.go")
        func_chunks = [c for c in chunks if c.chunk_type == "function"]
        self.assertEqual(len(func_chunks), 1)

    def test_method(self):
        code = '''func (s *Server) Start() error {
    return s.listener.Listen()
}
'''
        chunks = chunk_code_ast(code, "test.go")
        self.assertGreater(len(chunks), 0)


class TestRustChunking(unittest.TestCase):
    """Test AST-based chunking for Rust code."""

    def test_function(self):
        code = '''fn greet(name: &str) -> String {
    format!("Hello, {}!", name)
}
'''
        chunks = chunk_code_ast(code, "test.rs")
        func_chunks = [c for c in chunks if c.chunk_type == "function"]
        self.assertEqual(len(func_chunks), 1)

    def test_impl_block(self):
        code = '''impl Calculator {
    fn new() -> Self {
        Calculator { value: 0 }
    }

    fn add(&mut self, n: i32) {
        self.value += n;
    }
}
'''
        chunks = chunk_code_ast(code, "test.rs")
        # Should capture the impl block as a class-like construct
        class_chunks = [c for c in chunks if c.chunk_type == "class"]
        self.assertGreater(len(class_chunks), 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
