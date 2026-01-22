#!/usr/bin/env python3
"""
Tests for the call graph builder module.

Run with: python -m pytest test_call_graph.py -v
Or simply: python test_call_graph.py

Note: These tests are designed to run inside the Docker container where
all dependencies (tree-sitter, psycopg, etc.) are installed. For local
testing without Docker, only the AST extraction tests will work if
tree-sitter is installed.
"""

import unittest

# Import only what we need for testing - these don't require psycopg
try:
    from call_graph import (
        extract_calls_from_code,
        extract_definitions_from_code,
        is_supported_language,
        get_call_config,
        FunctionCall,
        FunctionDefinition,
    )
    IMPORTS_AVAILABLE = True
except ImportError as e:
    # For environments without all dependencies
    IMPORTS_AVAILABLE = False
    import sys
    print(f"Warning: Some imports not available: {e}", file=sys.stderr)
    print("Run tests inside Docker or install dependencies.", file=sys.stderr)


@unittest.skipUnless(IMPORTS_AVAILABLE, "Dependencies not available")
class TestLanguageSupport(unittest.TestCase):
    """Test language detection for call graph extraction."""

    def test_typescript_supported(self):
        self.assertTrue(is_supported_language("test.ts"))
        self.assertTrue(is_supported_language("test.tsx"))
        self.assertTrue(is_supported_language("test.mts"))

    def test_javascript_supported(self):
        self.assertTrue(is_supported_language("test.js"))
        self.assertTrue(is_supported_language("test.jsx"))
        self.assertTrue(is_supported_language("test.mjs"))

    def test_python_supported(self):
        self.assertTrue(is_supported_language("test.py"))

    def test_go_supported(self):
        self.assertTrue(is_supported_language("test.go"))

    def test_java_supported(self):
        self.assertTrue(is_supported_language("test.java"))

    def test_rust_supported(self):
        self.assertTrue(is_supported_language("test.rs"))

    def test_unsupported_languages(self):
        self.assertFalse(is_supported_language("test.rb"))  # Ruby
        self.assertFalse(is_supported_language("test.swift"))  # Swift
        self.assertFalse(is_supported_language("test.kt"))  # Kotlin

    def test_config_exists_for_supported(self):
        self.assertIsNotNone(get_call_config("test.ts"))
        self.assertIsNotNone(get_call_config("test.js"))
        self.assertIsNotNone(get_call_config("test.py"))


@unittest.skipUnless(IMPORTS_AVAILABLE, "Dependencies not available")
class TestDirectFunctionCalls(unittest.TestCase):
    """Test extraction of direct function calls."""

    def test_simple_function_call(self):
        code = '''
function greet() {
    console.log("Hello");
}

function main() {
    greet();
}
'''
        calls = extract_calls_from_code(code, "test.ts")
        # Should find: console.log() and greet()
        call_names = [c.callee_name for c in calls]
        self.assertIn("greet", call_names)
        self.assertIn("log", call_names)

    def test_multiple_function_calls(self):
        code = '''
function a() { return 1; }
function b() { return 2; }
function c() { return 3; }

function main() {
    a();
    b();
    c();
}
'''
        calls = extract_calls_from_code(code, "test.ts")
        call_names = [c.callee_name for c in calls if not c.is_method_call]
        self.assertIn("a", call_names)
        self.assertIn("b", call_names)
        self.assertIn("c", call_names)

    def test_nested_function_calls(self):
        code = '''
function outer(x) {
    return inner(transform(x));
}
'''
        calls = extract_calls_from_code(code, "test.ts")
        call_names = [c.callee_name for c in calls]
        self.assertIn("inner", call_names)
        self.assertIn("transform", call_names)

    def test_function_call_in_arrow_function(self):
        code = '''
const fn = () => {
    helper();
    return processData();
};
'''
        calls = extract_calls_from_code(code, "test.ts")
        call_names = [c.callee_name for c in calls]
        self.assertIn("helper", call_names)
        self.assertIn("processData", call_names)

    def test_function_call_with_arguments(self):
        code = '''
function process(data: string, options: Options) {
    return transform(data, validate(options));
}
'''
        calls = extract_calls_from_code(code, "test.ts")
        call_names = [c.callee_name for c in calls]
        self.assertIn("transform", call_names)
        self.assertIn("validate", call_names)


@unittest.skipUnless(IMPORTS_AVAILABLE, "Dependencies not available")
class TestMethodCalls(unittest.TestCase):
    """Test extraction of method calls (obj.method())."""

    def test_this_method_call(self):
        code = '''
class MyClass {
    private helper() {
        return 42;
    }

    public doWork() {
        return this.helper();
    }
}
'''
        calls = extract_calls_from_code(code, "test.ts")
        helper_calls = [c for c in calls if c.callee_name == "helper"]
        self.assertEqual(len(helper_calls), 1)
        self.assertEqual(helper_calls[0].receiver, "this")
        self.assertTrue(helper_calls[0].is_method_call)

    def test_object_method_call(self):
        code = '''
function process(service: Service) {
    const result = service.getData();
    return service.transform(result);
}
'''
        calls = extract_calls_from_code(code, "test.ts")
        method_calls = [c for c in calls if c.is_method_call]

        # Should have getData and transform as method calls
        method_names = [c.callee_name for c in method_calls]
        self.assertIn("getData", method_names)
        self.assertIn("transform", method_names)

        # Receiver should be "service"
        for call in method_calls:
            if call.callee_name in ["getData", "transform"]:
                self.assertEqual(call.receiver, "service")

    def test_static_method_call(self):
        code = '''
function createUser() {
    return UserFactory.create("test");
}
'''
        calls = extract_calls_from_code(code, "test.ts")
        create_calls = [c for c in calls if c.callee_name == "create"]
        self.assertEqual(len(create_calls), 1)
        self.assertEqual(create_calls[0].receiver, "UserFactory")
        self.assertTrue(create_calls[0].is_method_call)

    def test_chained_method_calls(self):
        code = '''
function buildQuery() {
    return db.select().from("users").where("active", true);
}
'''
        calls = extract_calls_from_code(code, "test.ts")
        call_names = [c.callee_name for c in calls]
        self.assertIn("select", call_names)
        self.assertIn("from", call_names)
        self.assertIn("where", call_names)

    def test_method_call_on_property(self):
        code = '''
class Service {
    private api: ApiClient;

    async fetch() {
        return this.api.get("/data");
    }
}
'''
        calls = extract_calls_from_code(code, "test.ts")
        get_calls = [c for c in calls if c.callee_name == "get"]
        self.assertEqual(len(get_calls), 1)
        self.assertTrue(get_calls[0].is_method_call)


@unittest.skipUnless(IMPORTS_AVAILABLE, "Dependencies not available")
class TestConsoleAndBuiltins(unittest.TestCase):
    """Test handling of console methods and built-in functions."""

    def test_console_log(self):
        code = '''
function debug(msg: string) {
    console.log(msg);
    console.error("Error!");
    console.warn("Warning!");
}
'''
        calls = extract_calls_from_code(code, "test.ts")
        console_calls = [c for c in calls if c.receiver == "console"]
        self.assertEqual(len(console_calls), 3)

        call_names = [c.callee_name for c in console_calls]
        self.assertIn("log", call_names)
        self.assertIn("error", call_names)
        self.assertIn("warn", call_names)

    def test_array_methods(self):
        code = '''
function process(items: string[]) {
    return items
        .filter(x => x.length > 0)
        .map(x => x.toUpperCase())
        .join(", ");
}
'''
        calls = extract_calls_from_code(code, "test.ts")
        call_names = [c.callee_name for c in calls]
        self.assertIn("filter", call_names)
        self.assertIn("map", call_names)
        self.assertIn("join", call_names)


@unittest.skipUnless(IMPORTS_AVAILABLE, "Dependencies not available")
class TestFunctionDefinitions(unittest.TestCase):
    """Test extraction of function and method definitions."""

    def test_function_declaration(self):
        code = '''
function greet(name: string): string {
    return `Hello, ${name}!`;
}

function farewell(name: string): string {
    return `Goodbye, ${name}!`;
}
'''
        defs = extract_definitions_from_code(code, "test.ts")
        names = [d.name for d in defs]
        self.assertIn("greet", names)
        self.assertIn("farewell", names)
        self.assertFalse(any(d.is_method for d in defs))

    def test_class_methods(self):
        code = '''
class Calculator {
    add(a: number, b: number): number {
        return a + b;
    }

    subtract(a: number, b: number): number {
        return a - b;
    }
}
'''
        defs = extract_definitions_from_code(code, "test.ts")
        method_defs = [d for d in defs if d.is_method]
        names = [d.name for d in method_defs]
        self.assertIn("add", names)
        self.assertIn("subtract", names)

        # All methods should have class_name set
        for d in method_defs:
            self.assertEqual(d.class_name, "Calculator")

    def test_mixed_functions_and_methods(self):
        code = '''
function helper() {
    return 42;
}

class Service {
    process() {
        return helper();
    }
}

function main() {
    const svc = new Service();
    svc.process();
}
'''
        defs = extract_definitions_from_code(code, "test.ts")
        function_defs = [d for d in defs if not d.is_method]
        method_defs = [d for d in defs if d.is_method]

        self.assertEqual(len(function_defs), 2)  # helper, main
        self.assertEqual(len(method_defs), 1)  # process

        func_names = [d.name for d in function_defs]
        self.assertIn("helper", func_names)
        self.assertIn("main", func_names)

        method_names = [d.name for d in method_defs]
        self.assertIn("process", method_names)


@unittest.skipUnless(IMPORTS_AVAILABLE, "Dependencies not available")
class TestJavaScriptCalls(unittest.TestCase):
    """Test call extraction from JavaScript code."""

    def test_commonjs_style(self):
        code = '''
const fs = require('fs');

function readFile(path) {
    return fs.readFileSync(path, 'utf-8');
}

module.exports = { readFile };
'''
        calls = extract_calls_from_code(code, "test.js")
        call_names = [c.callee_name for c in calls]
        self.assertIn("require", call_names)
        self.assertIn("readFileSync", call_names)

    def test_esm_style(self):
        code = '''
import { useState } from 'react';

function Counter() {
    const [count, setCount] = useState(0);
    return count;
}

export default Counter;
'''
        calls = extract_calls_from_code(code, "test.jsx")
        call_names = [c.callee_name for c in calls]
        self.assertIn("useState", call_names)


@unittest.skipUnless(IMPORTS_AVAILABLE, "Dependencies not available")
class TestLineNumbers(unittest.TestCase):
    """Test that line numbers are correctly captured."""

    def test_line_numbers_for_calls(self):
        code = '''function main() {
    foo();
    bar();
    baz();
}'''
        calls = extract_calls_from_code(code, "test.ts")
        foo_call = next((c for c in calls if c.callee_name == "foo"), None)
        bar_call = next((c for c in calls if c.callee_name == "bar"), None)
        baz_call = next((c for c in calls if c.callee_name == "baz"), None)

        self.assertIsNotNone(foo_call)
        self.assertIsNotNone(bar_call)
        self.assertIsNotNone(baz_call)

        # Lines should be in order
        self.assertLess(foo_call.line_number, bar_call.line_number)
        self.assertLess(bar_call.line_number, baz_call.line_number)


@unittest.skipUnless(IMPORTS_AVAILABLE, "Dependencies not available")
class TestEdgeCases(unittest.TestCase):
    """Test edge cases and error handling."""

    def test_empty_code(self):
        calls = extract_calls_from_code("", "test.ts")
        self.assertEqual(len(calls), 0)

    def test_no_calls(self):
        code = '''
const x = 1;
const y = 2;
const z = x + y;
'''
        calls = extract_calls_from_code(code, "test.ts")
        self.assertEqual(len(calls), 0)

    def test_unsupported_language(self):
        code = '''
class Hello
  def greet
    puts "Hello"
  end
end
'''
        # Ruby is not supported
        calls = extract_calls_from_code(code, "test.rb")
        self.assertEqual(len(calls), 0)

    def test_syntax_error_partial_extraction(self):
        # Invalid syntax - missing closing brace
        code = '''
function broken() {
    foo();
'''
        # Should still extract what it can or return empty
        calls = extract_calls_from_code(code, "test.ts")
        # Even with syntax errors, tree-sitter should parse partially
        # The result depends on tree-sitter's error recovery

    def test_anonymous_function_call(self):
        code = '''
(function() {
    console.log("IIFE");
})();
'''
        calls = extract_calls_from_code(code, "test.ts")
        # Should detect this as a dynamic/anonymous call
        anonymous_calls = [c for c in calls if c.callee_name == "<anonymous>"]
        # IIFE detection may vary based on implementation


@unittest.skipUnless(IMPORTS_AVAILABLE, "Dependencies not available")
class TestCallResolutionPatterns(unittest.TestCase):
    """Test various patterns for call resolution."""

    def test_async_await_calls(self):
        code = '''
async function fetchData() {
    const response = await fetch("/api/data");
    const data = await response.json();
    return processData(data);
}
'''
        calls = extract_calls_from_code(code, "test.ts")
        call_names = [c.callee_name for c in calls]
        self.assertIn("fetch", call_names)
        self.assertIn("json", call_names)
        self.assertIn("processData", call_names)

    def test_callback_pattern(self):
        code = '''
function process(items: string[], callback: Function) {
    items.forEach(item => {
        callback(item);
        transform(item);
    });
}
'''
        calls = extract_calls_from_code(code, "test.ts")
        call_names = [c.callee_name for c in calls]
        self.assertIn("forEach", call_names)
        self.assertIn("callback", call_names)
        self.assertIn("transform", call_names)

    def test_constructor_call(self):
        code = '''
function createService() {
    const service = new MyService();
    service.init();
    return service;
}
'''
        calls = extract_calls_from_code(code, "test.ts")
        # "new MyService()" is a call expression in tree-sitter
        call_names = [c.callee_name for c in calls]
        self.assertIn("init", call_names)

    def test_optional_chaining(self):
        code = '''
function safeCall(obj?: Service) {
    return obj?.getData?.();
}
'''
        calls = extract_calls_from_code(code, "test.ts")
        # Optional chaining may or may not be captured as calls
        # depending on tree-sitter's handling


@unittest.skipUnless(IMPORTS_AVAILABLE, "Dependencies not available")
class TestTypeScriptSpecific(unittest.TestCase):
    """Test TypeScript-specific patterns."""

    def test_generic_function_call(self):
        code = '''
function process() {
    const result = transform<string>(data);
    return parse<number[]>(result);
}
'''
        calls = extract_calls_from_code(code, "test.ts")
        call_names = [c.callee_name for c in calls]
        self.assertIn("transform", call_names)
        self.assertIn("parse", call_names)

    def test_type_assertion_with_call(self):
        code = '''
function getValue() {
    const x = (getData() as string).trim();
    return x;
}
'''
        calls = extract_calls_from_code(code, "test.ts")
        call_names = [c.callee_name for c in calls]
        self.assertIn("getData", call_names)
        self.assertIn("trim", call_names)

    def test_interface_method_call(self):
        code = '''
interface DataService {
    fetch(): Promise<Data>;
}

function process(service: DataService) {
    return service.fetch();
}
'''
        calls = extract_calls_from_code(code, "test.ts")
        fetch_calls = [c for c in calls if c.callee_name == "fetch"]
        self.assertEqual(len(fetch_calls), 1)
        self.assertEqual(fetch_calls[0].receiver, "service")


# =============================================================================
# Python Call Graph Tests
# =============================================================================


@unittest.skipUnless(IMPORTS_AVAILABLE, "Dependencies not available")
class TestPythonDirectFunctionCalls(unittest.TestCase):
    """Test extraction of direct function calls in Python."""

    def test_simple_function_call(self):
        code = '''
def greet():
    print("Hello")

def main():
    greet()
'''
        calls = extract_calls_from_code(code, "test.py")
        call_names = [c.callee_name for c in calls]
        self.assertIn("greet", call_names)
        self.assertIn("print", call_names)

    def test_multiple_function_calls(self):
        code = '''
def a():
    return 1

def b():
    return 2

def c():
    return 3

def main():
    a()
    b()
    c()
'''
        calls = extract_calls_from_code(code, "test.py")
        call_names = [c.callee_name for c in calls if not c.is_method_call]
        self.assertIn("a", call_names)
        self.assertIn("b", call_names)
        self.assertIn("c", call_names)

    def test_nested_function_calls(self):
        code = '''
def outer(x):
    return inner(transform(x))
'''
        calls = extract_calls_from_code(code, "test.py")
        call_names = [c.callee_name for c in calls]
        self.assertIn("inner", call_names)
        self.assertIn("transform", call_names)

    def test_function_call_with_arguments(self):
        code = '''
def process(data, options):
    return transform(data, validate(options))
'''
        calls = extract_calls_from_code(code, "test.py")
        call_names = [c.callee_name for c in calls]
        self.assertIn("transform", call_names)
        self.assertIn("validate", call_names)


@unittest.skipUnless(IMPORTS_AVAILABLE, "Dependencies not available")
class TestPythonMethodCalls(unittest.TestCase):
    """Test extraction of method calls in Python (obj.method())."""

    def test_self_method_call(self):
        code = '''
class MyClass:
    def helper(self):
        return 42

    def do_work(self):
        return self.helper()
'''
        calls = extract_calls_from_code(code, "test.py")
        helper_calls = [c for c in calls if c.callee_name == "helper"]
        self.assertEqual(len(helper_calls), 1)
        self.assertEqual(helper_calls[0].receiver, "self")
        self.assertTrue(helper_calls[0].is_method_call)

    def test_object_method_call(self):
        code = '''
def process(service):
    result = service.get_data()
    return service.transform(result)
'''
        calls = extract_calls_from_code(code, "test.py")
        method_calls = [c for c in calls if c.is_method_call]

        method_names = [c.callee_name for c in method_calls]
        self.assertIn("get_data", method_names)
        self.assertIn("transform", method_names)

        for call in method_calls:
            if call.callee_name in ["get_data", "transform"]:
                self.assertEqual(call.receiver, "service")

    def test_static_method_call(self):
        code = '''
def create_user():
    return UserFactory.create("test")
'''
        calls = extract_calls_from_code(code, "test.py")
        create_calls = [c for c in calls if c.callee_name == "create"]
        self.assertEqual(len(create_calls), 1)
        self.assertEqual(create_calls[0].receiver, "UserFactory")
        self.assertTrue(create_calls[0].is_method_call)

    def test_chained_method_calls(self):
        code = '''
def build_query():
    return db.select().from_table("users").where("active", True)
'''
        calls = extract_calls_from_code(code, "test.py")
        call_names = [c.callee_name for c in calls]
        self.assertIn("select", call_names)
        self.assertIn("from_table", call_names)
        self.assertIn("where", call_names)


@unittest.skipUnless(IMPORTS_AVAILABLE, "Dependencies not available")
class TestPythonClassMethods(unittest.TestCase):
    """Test extraction of class methods with cls and decorators."""

    def test_classmethod_call(self):
        code = '''
class MyClass:
    @classmethod
    def create(cls, name):
        return cls(name)

    @classmethod
    def factory(cls):
        return cls.create("default")
'''
        calls = extract_calls_from_code(code, "test.py")
        create_calls = [c for c in calls if c.callee_name == "create"]
        self.assertEqual(len(create_calls), 1)
        # cls.create() should be treated like self.method()
        self.assertEqual(create_calls[0].receiver, "self")  # normalized to "self"

    def test_staticmethod_call(self):
        code = '''
class Utility:
    @staticmethod
    def helper(x):
        return x * 2

    def process(self, value):
        return Utility.helper(value)
'''
        calls = extract_calls_from_code(code, "test.py")
        helper_calls = [c for c in calls if c.callee_name == "helper"]
        self.assertEqual(len(helper_calls), 1)
        self.assertEqual(helper_calls[0].receiver, "Utility")


@unittest.skipUnless(IMPORTS_AVAILABLE, "Dependencies not available")
class TestPythonSuperCalls(unittest.TestCase):
    """Test extraction of super() calls for inheritance."""

    def test_super_init_call(self):
        code = '''
class Child(Parent):
    def __init__(self, name):
        super().__init__(name)
        self.name = name
'''
        calls = extract_calls_from_code(code, "test.py")
        # super() call
        super_calls = [c for c in calls if c.callee_name == "super"]
        self.assertEqual(len(super_calls), 1)
        self.assertTrue(super_calls[0].is_dynamic)  # super() is dynamic

        # super().__init__ call
        init_calls = [c for c in calls if c.callee_name == "__init__"]
        self.assertEqual(len(init_calls), 1)
        self.assertEqual(init_calls[0].receiver, "super")
        self.assertTrue(init_calls[0].is_dynamic)  # super().method() is dynamic

    def test_super_method_call(self):
        code = '''
class Child(Parent):
    def do_work(self):
        result = super().do_work()
        return result + self.extra_work()
'''
        calls = extract_calls_from_code(code, "test.py")
        do_work_calls = [c for c in calls if c.callee_name == "do_work"]
        # One from super().do_work()
        super_do_work = [c for c in do_work_calls if c.receiver == "super"]
        self.assertEqual(len(super_do_work), 1)


@unittest.skipUnless(IMPORTS_AVAILABLE, "Dependencies not available")
class TestPythonFunctionDefinitions(unittest.TestCase):
    """Test extraction of function and method definitions in Python."""

    def test_function_declaration(self):
        code = '''
def greet(name):
    return f"Hello, {name}!"

def farewell(name):
    return f"Goodbye, {name}!"
'''
        defs = extract_definitions_from_code(code, "test.py")
        names = [d.name for d in defs]
        self.assertIn("greet", names)
        self.assertIn("farewell", names)
        self.assertFalse(any(d.is_method for d in defs))

    def test_class_methods(self):
        code = '''
class Calculator:
    def add(self, a, b):
        return a + b

    def subtract(self, a, b):
        return a - b
'''
        defs = extract_definitions_from_code(code, "test.py")
        method_defs = [d for d in defs if d.is_method]
        names = [d.name for d in method_defs]
        self.assertIn("add", names)
        self.assertIn("subtract", names)

        for d in method_defs:
            self.assertEqual(d.class_name, "Calculator")

    def test_mixed_functions_and_methods(self):
        code = '''
def helper():
    return 42

class Service:
    def process(self):
        return helper()

def main():
    svc = Service()
    svc.process()
'''
        defs = extract_definitions_from_code(code, "test.py")
        function_defs = [d for d in defs if not d.is_method]
        method_defs = [d for d in defs if d.is_method]

        self.assertEqual(len(function_defs), 2)  # helper, main
        self.assertEqual(len(method_defs), 1)  # process

        func_names = [d.name for d in function_defs]
        self.assertIn("helper", func_names)
        self.assertIn("main", func_names)

        method_names = [d.name for d in method_defs]
        self.assertIn("process", method_names)


@unittest.skipUnless(IMPORTS_AVAILABLE, "Dependencies not available")
class TestPythonAsyncCalls(unittest.TestCase):
    """Test extraction of async/await patterns in Python."""

    def test_async_await_calls(self):
        code = '''
async def fetch_data():
    response = await http_client.get("/api/data")
    data = await response.json()
    return process_data(data)
'''
        calls = extract_calls_from_code(code, "test.py")
        call_names = [c.callee_name for c in calls]
        self.assertIn("get", call_names)
        self.assertIn("json", call_names)
        self.assertIn("process_data", call_names)


@unittest.skipUnless(IMPORTS_AVAILABLE, "Dependencies not available")
class TestPythonDecoratorPatterns(unittest.TestCase):
    """Test handling of decorated functions."""

    def test_decorated_function_calls(self):
        code = '''
@decorator
def my_func():
    helper()
    return result()
'''
        calls = extract_calls_from_code(code, "test.py")
        call_names = [c.callee_name for c in calls]
        # decorator is a call too
        self.assertIn("decorator", call_names)
        self.assertIn("helper", call_names)
        self.assertIn("result", call_names)

    def test_decorator_with_arguments(self):
        code = '''
@app.route("/api")
def endpoint():
    return process_request()
'''
        calls = extract_calls_from_code(code, "test.py")
        call_names = [c.callee_name for c in calls]
        self.assertIn("route", call_names)
        self.assertIn("process_request", call_names)


@unittest.skipUnless(IMPORTS_AVAILABLE, "Dependencies not available")
class TestPythonModuleCalls(unittest.TestCase):
    """Test module-level function calls."""

    def test_module_function_call(self):
        code = '''
import os

def get_path():
    return os.path.join("/home", "user")
'''
        calls = extract_calls_from_code(code, "test.py")
        # os.path.join - nested attribute access
        join_calls = [c for c in calls if c.callee_name == "join"]
        self.assertEqual(len(join_calls), 1)

    def test_from_import_call(self):
        code = '''
from pathlib import Path

def get_home():
    return Path.home()
'''
        calls = extract_calls_from_code(code, "test.py")
        home_calls = [c for c in calls if c.callee_name == "home"]
        self.assertEqual(len(home_calls), 1)
        self.assertEqual(home_calls[0].receiver, "Path")


@unittest.skipUnless(IMPORTS_AVAILABLE, "Dependencies not available")
class TestPythonLineNumbers(unittest.TestCase):
    """Test that line numbers are correctly captured for Python."""

    def test_line_numbers_for_calls(self):
        code = '''def main():
    foo()
    bar()
    baz()
'''
        calls = extract_calls_from_code(code, "test.py")
        foo_call = next((c for c in calls if c.callee_name == "foo"), None)
        bar_call = next((c for c in calls if c.callee_name == "bar"), None)
        baz_call = next((c for c in calls if c.callee_name == "baz"), None)

        self.assertIsNotNone(foo_call)
        self.assertIsNotNone(bar_call)
        self.assertIsNotNone(baz_call)

        # Lines should be in order
        self.assertLess(foo_call.line_number, bar_call.line_number)
        self.assertLess(bar_call.line_number, baz_call.line_number)


@unittest.skipUnless(IMPORTS_AVAILABLE, "Dependencies not available")
class TestPythonEdgeCases(unittest.TestCase):
    """Test edge cases and error handling for Python."""

    def test_empty_code(self):
        calls = extract_calls_from_code("", "test.py")
        self.assertEqual(len(calls), 0)

    def test_no_calls(self):
        code = '''
x = 1
y = 2
z = x + y
'''
        calls = extract_calls_from_code(code, "test.py")
        self.assertEqual(len(calls), 0)

    def test_lambda_call(self):
        code = '''
fn = lambda x: x * 2
result = fn(5)
'''
        calls = extract_calls_from_code(code, "test.py")
        fn_calls = [c for c in calls if c.callee_name == "fn"]
        self.assertEqual(len(fn_calls), 1)

    def test_comprehension_calls(self):
        code = '''
def process(items):
    return [transform(x) for x in items if validate(x)]
'''
        calls = extract_calls_from_code(code, "test.py")
        call_names = [c.callee_name for c in calls]
        self.assertIn("transform", call_names)
        self.assertIn("validate", call_names)

    def test_dynamic_dispatch_flag(self):
        """Test that dynamic dispatch is properly flagged."""
        code = '''
def process(obj):
    return get_handler().process(obj)
'''
        calls = extract_calls_from_code(code, "test.py")
        process_calls = [c for c in calls if c.callee_name == "process"]
        # get_handler().process() should be flagged as dynamic
        dynamic_calls = [c for c in process_calls if c.is_dynamic]
        self.assertEqual(len(dynamic_calls), 1)
        self.assertEqual(dynamic_calls[0].receiver, "<call_result>")


# =============================================================================
# Go Call Graph Tests
# =============================================================================


@unittest.skipUnless(IMPORTS_AVAILABLE, "Dependencies not available")
class TestGoDirectFunctionCalls(unittest.TestCase):
    """Test extraction of direct function calls in Go."""

    def test_simple_function_call(self):
        code = '''
package main

func greet() {
    fmt.Println("Hello")
}

func main() {
    greet()
}
'''
        calls = extract_calls_from_code(code, "test.go")
        call_names = [c.callee_name for c in calls]
        self.assertIn("greet", call_names)
        self.assertIn("Println", call_names)

    def test_multiple_function_calls(self):
        code = '''
package main

func a() int { return 1 }
func b() int { return 2 }
func c() int { return 3 }

func main() {
    a()
    b()
    c()
}
'''
        calls = extract_calls_from_code(code, "test.go")
        call_names = [c.callee_name for c in calls if not c.is_method_call]
        self.assertIn("a", call_names)
        self.assertIn("b", call_names)
        self.assertIn("c", call_names)

    def test_nested_function_calls(self):
        code = '''
package main

func outer(x int) int {
    return inner(transform(x))
}
'''
        calls = extract_calls_from_code(code, "test.go")
        call_names = [c.callee_name for c in calls]
        self.assertIn("inner", call_names)
        self.assertIn("transform", call_names)


@unittest.skipUnless(IMPORTS_AVAILABLE, "Dependencies not available")
class TestGoMethodCalls(unittest.TestCase):
    """Test extraction of method calls in Go."""

    def test_method_on_receiver(self):
        code = '''
package main

type Service struct{}

func (s *Service) Process() {
    s.helper()
}

func (s *Service) helper() {}
'''
        calls = extract_calls_from_code(code, "test.go")
        helper_calls = [c for c in calls if c.callee_name == "helper"]
        self.assertEqual(len(helper_calls), 1)
        self.assertEqual(helper_calls[0].receiver, "s")
        self.assertTrue(helper_calls[0].is_method_call)

    def test_package_function_call(self):
        code = '''
package main

import "strings"

func process(s string) string {
    return strings.ToUpper(s)
}
'''
        calls = extract_calls_from_code(code, "test.go")
        upper_calls = [c for c in calls if c.callee_name == "ToUpper"]
        self.assertEqual(len(upper_calls), 1)
        self.assertEqual(upper_calls[0].receiver, "strings")

    def test_chained_method_calls(self):
        code = '''
package main

func buildQuery() {
    db.Table("users").Where("active", true).Find(&results)
}
'''
        calls = extract_calls_from_code(code, "test.go")
        call_names = [c.callee_name for c in calls]
        self.assertIn("Table", call_names)
        self.assertIn("Where", call_names)
        self.assertIn("Find", call_names)


@unittest.skipUnless(IMPORTS_AVAILABLE, "Dependencies not available")
class TestGoInterfaceCalls(unittest.TestCase):
    """Test extraction of interface method calls in Go."""

    def test_interface_method_call(self):
        code = '''
package main

type Reader interface {
    Read(p []byte) (n int, err error)
}

func process(r Reader) {
    r.Read(buffer)
}
'''
        calls = extract_calls_from_code(code, "test.go")
        read_calls = [c for c in calls if c.callee_name == "Read"]
        self.assertEqual(len(read_calls), 1)
        self.assertEqual(read_calls[0].receiver, "r")

    def test_type_assertion_call(self):
        code = '''
package main

func process(i interface{}) {
    if v, ok := i.(Stringer); ok {
        v.String()
    }
}
'''
        calls = extract_calls_from_code(code, "test.go")
        string_calls = [c for c in calls if c.callee_name == "String"]
        self.assertEqual(len(string_calls), 1)


@unittest.skipUnless(IMPORTS_AVAILABLE, "Dependencies not available")
class TestGoEdgeCases(unittest.TestCase):
    """Test edge cases for Go call extraction."""

    def test_empty_code(self):
        calls = extract_calls_from_code("", "test.go")
        self.assertEqual(len(calls), 0)

    def test_deferred_call(self):
        code = '''
package main

func process() {
    defer cleanup()
    doWork()
}
'''
        calls = extract_calls_from_code(code, "test.go")
        call_names = [c.callee_name for c in calls]
        self.assertIn("cleanup", call_names)
        self.assertIn("doWork", call_names)

    def test_go_routine_call(self):
        code = '''
package main

func process() {
    go worker()
    go handler.Process()
}
'''
        calls = extract_calls_from_code(code, "test.go")
        call_names = [c.callee_name for c in calls]
        self.assertIn("worker", call_names)
        self.assertIn("Process", call_names)

    def test_anonymous_function_call(self):
        code = '''
package main

func main() {
    func() {
        fmt.Println("Hello")
    }()
}
'''
        calls = extract_calls_from_code(code, "test.go")
        # Should detect anonymous function call
        anon_calls = [c for c in calls if c.callee_name == "<anonymous>"]
        # May or may not capture this depending on implementation


# =============================================================================
# Java Call Graph Tests
# =============================================================================


@unittest.skipUnless(IMPORTS_AVAILABLE, "Dependencies not available")
class TestJavaDirectMethodCalls(unittest.TestCase):
    """Test extraction of direct method calls in Java."""

    def test_simple_method_call(self):
        code = '''
public class Main {
    public void greet() {
        System.out.println("Hello");
    }

    public void main() {
        greet();
    }
}
'''
        calls = extract_calls_from_code(code, "test.java")
        call_names = [c.callee_name for c in calls]
        self.assertIn("greet", call_names)
        self.assertIn("println", call_names)

    def test_multiple_method_calls(self):
        code = '''
public class Main {
    void a() {}
    void b() {}
    void c() {}

    void main() {
        a();
        b();
        c();
    }
}
'''
        calls = extract_calls_from_code(code, "test.java")
        call_names = [c.callee_name for c in calls]
        self.assertIn("a", call_names)
        self.assertIn("b", call_names)
        self.assertIn("c", call_names)


@unittest.skipUnless(IMPORTS_AVAILABLE, "Dependencies not available")
class TestJavaMethodCallPatterns(unittest.TestCase):
    """Test various Java method call patterns."""

    def test_this_method_call(self):
        code = '''
public class Service {
    private void helper() {}

    public void process() {
        this.helper();
    }
}
'''
        calls = extract_calls_from_code(code, "test.java")
        helper_calls = [c for c in calls if c.callee_name == "helper"]
        self.assertEqual(len(helper_calls), 1)
        self.assertEqual(helper_calls[0].receiver, "this")
        self.assertTrue(helper_calls[0].is_method_call)

    def test_static_method_call(self):
        code = '''
public class Main {
    public void process() {
        String result = String.valueOf(42);
        int num = Integer.parseInt("123");
    }
}
'''
        calls = extract_calls_from_code(code, "test.java")
        call_names = [c.callee_name for c in calls]
        self.assertIn("valueOf", call_names)
        self.assertIn("parseInt", call_names)

    def test_object_method_call(self):
        code = '''
public class Main {
    public void process(Service service) {
        service.getData();
        service.transform();
    }
}
'''
        calls = extract_calls_from_code(code, "test.java")
        method_calls = [c for c in calls if c.receiver == "service"]
        self.assertEqual(len(method_calls), 2)


@unittest.skipUnless(IMPORTS_AVAILABLE, "Dependencies not available")
class TestJavaSuperCalls(unittest.TestCase):
    """Test extraction of super method calls in Java."""

    def test_super_constructor_call(self):
        code = '''
public class Child extends Parent {
    public Child(String name) {
        super(name);
    }
}
'''
        # Note: super() in constructor may be captured differently
        calls = extract_calls_from_code(code, "test.java")
        # The exact handling depends on tree-sitter-java

    def test_super_method_call(self):
        code = '''
public class Child extends Parent {
    @Override
    public void process() {
        super.process();
        doMoreWork();
    }
}
'''
        calls = extract_calls_from_code(code, "test.java")
        process_calls = [c for c in calls if c.callee_name == "process"]
        super_calls = [c for c in process_calls if c.receiver == "super"]
        self.assertEqual(len(super_calls), 1)
        self.assertTrue(super_calls[0].is_dynamic)


@unittest.skipUnless(IMPORTS_AVAILABLE, "Dependencies not available")
class TestJavaChainedCalls(unittest.TestCase):
    """Test extraction of chained method calls in Java."""

    def test_builder_pattern(self):
        code = '''
public class Main {
    public void build() {
        new Builder()
            .setName("test")
            .setValue(42)
            .build();
    }
}
'''
        calls = extract_calls_from_code(code, "test.java")
        call_names = [c.callee_name for c in calls]
        self.assertIn("setName", call_names)
        self.assertIn("setValue", call_names)
        self.assertIn("build", call_names)

    def test_stream_operations(self):
        code = '''
public class Main {
    public void process(List<String> items) {
        items.stream()
            .filter(x -> x.length() > 0)
            .map(String::toUpperCase)
            .collect(Collectors.toList());
    }
}
'''
        calls = extract_calls_from_code(code, "test.java")
        call_names = [c.callee_name for c in calls]
        self.assertIn("stream", call_names)
        self.assertIn("filter", call_names)
        self.assertIn("collect", call_names)


@unittest.skipUnless(IMPORTS_AVAILABLE, "Dependencies not available")
class TestJavaEdgeCases(unittest.TestCase):
    """Test edge cases for Java call extraction."""

    def test_empty_code(self):
        calls = extract_calls_from_code("", "test.java")
        self.assertEqual(len(calls), 0)

    def test_constructor_call(self):
        code = '''
public class Main {
    public void create() {
        Service service = new Service();
        service.init();
    }
}
'''
        calls = extract_calls_from_code(code, "test.java")
        init_calls = [c for c in calls if c.callee_name == "init"]
        self.assertEqual(len(init_calls), 1)

    def test_lambda_method_call(self):
        code = '''
public class Main {
    public void process() {
        Runnable r = () -> helper();
    }
}
'''
        calls = extract_calls_from_code(code, "test.java")
        helper_calls = [c for c in calls if c.callee_name == "helper"]
        self.assertEqual(len(helper_calls), 1)


# =============================================================================
# Rust Call Graph Tests
# =============================================================================


@unittest.skipUnless(IMPORTS_AVAILABLE, "Dependencies not available")
class TestRustDirectFunctionCalls(unittest.TestCase):
    """Test extraction of direct function calls in Rust."""

    def test_simple_function_call(self):
        code = '''
fn greet() {
    println!("Hello");
}

fn main() {
    greet();
}
'''
        calls = extract_calls_from_code(code, "test.rs")
        call_names = [c.callee_name for c in calls]
        self.assertIn("greet", call_names)

    def test_multiple_function_calls(self):
        code = '''
fn a() -> i32 { 1 }
fn b() -> i32 { 2 }
fn c() -> i32 { 3 }

fn main() {
    a();
    b();
    c();
}
'''
        calls = extract_calls_from_code(code, "test.rs")
        call_names = [c.callee_name for c in calls if not c.is_method_call]
        self.assertIn("a", call_names)
        self.assertIn("b", call_names)
        self.assertIn("c", call_names)

    def test_nested_function_calls(self):
        code = '''
fn outer(x: i32) -> i32 {
    inner(transform(x))
}
'''
        calls = extract_calls_from_code(code, "test.rs")
        call_names = [c.callee_name for c in calls]
        self.assertIn("inner", call_names)
        self.assertIn("transform", call_names)


@unittest.skipUnless(IMPORTS_AVAILABLE, "Dependencies not available")
class TestRustMethodCalls(unittest.TestCase):
    """Test extraction of method calls in Rust."""

    def test_self_method_call(self):
        code = '''
impl Service {
    fn helper(&self) -> i32 {
        42
    }

    fn process(&self) {
        self.helper();
    }
}
'''
        calls = extract_calls_from_code(code, "test.rs")
        helper_calls = [c for c in calls if c.callee_name == "helper"]
        self.assertEqual(len(helper_calls), 1)
        self.assertEqual(helper_calls[0].receiver, "self")
        self.assertTrue(helper_calls[0].is_method_call)

    def test_object_method_call(self):
        code = '''
fn process(service: &Service) {
    service.get_data();
    service.transform();
}
'''
        calls = extract_calls_from_code(code, "test.rs")
        method_calls = [c for c in calls if c.receiver == "service"]
        self.assertEqual(len(method_calls), 2)

    def test_associated_function_call(self):
        code = '''
fn create() -> Service {
    Service::new()
}
'''
        calls = extract_calls_from_code(code, "test.rs")
        new_calls = [c for c in calls if c.callee_name == "new"]
        self.assertEqual(len(new_calls), 1)
        self.assertEqual(new_calls[0].receiver, "Service")


@unittest.skipUnless(IMPORTS_AVAILABLE, "Dependencies not available")
class TestRustTraitCalls(unittest.TestCase):
    """Test extraction of trait method calls in Rust."""

    def test_trait_method_call(self):
        code = '''
fn process<T: Display>(item: &T) {
    item.to_string();
}
'''
        calls = extract_calls_from_code(code, "test.rs")
        to_string_calls = [c for c in calls if c.callee_name == "to_string"]
        self.assertEqual(len(to_string_calls), 1)

    def test_impl_trait_call(self):
        code = '''
fn process(item: impl Iterator<Item = i32>) {
    item.next();
    item.collect::<Vec<_>>();
}
'''
        calls = extract_calls_from_code(code, "test.rs")
        call_names = [c.callee_name for c in calls]
        self.assertIn("next", call_names)
        self.assertIn("collect", call_names)


@unittest.skipUnless(IMPORTS_AVAILABLE, "Dependencies not available")
class TestRustChainedCalls(unittest.TestCase):
    """Test extraction of chained method calls in Rust."""

    def test_iterator_chain(self):
        code = '''
fn process(items: Vec<i32>) {
    items.iter()
        .filter(|x| **x > 0)
        .map(|x| x * 2)
        .collect::<Vec<_>>();
}
'''
        calls = extract_calls_from_code(code, "test.rs")
        call_names = [c.callee_name for c in calls]
        self.assertIn("iter", call_names)
        self.assertIn("filter", call_names)
        self.assertIn("map", call_names)
        self.assertIn("collect", call_names)

    def test_option_chain(self):
        code = '''
fn process(opt: Option<String>) -> Option<i32> {
    opt.map(|s| s.len())
       .filter(|&n| n > 0)
       .and_then(|n| Some(n * 2))
}
'''
        calls = extract_calls_from_code(code, "test.rs")
        call_names = [c.callee_name for c in calls]
        self.assertIn("map", call_names)
        self.assertIn("filter", call_names)
        self.assertIn("and_then", call_names)


@unittest.skipUnless(IMPORTS_AVAILABLE, "Dependencies not available")
class TestRustEdgeCases(unittest.TestCase):
    """Test edge cases for Rust call extraction."""

    def test_empty_code(self):
        calls = extract_calls_from_code("", "test.rs")
        self.assertEqual(len(calls), 0)

    def test_closure_call(self):
        code = '''
fn main() {
    let add = |a, b| a + b;
    add(1, 2);
}
'''
        calls = extract_calls_from_code(code, "test.rs")
        add_calls = [c for c in calls if c.callee_name == "add"]
        self.assertEqual(len(add_calls), 1)

    def test_async_await_call(self):
        code = '''
async fn fetch_data() {
    let response = client.get("/api").await;
    response.json().await
}
'''
        calls = extract_calls_from_code(code, "test.rs")
        call_names = [c.callee_name for c in calls]
        self.assertIn("get", call_names)
        self.assertIn("json", call_names)

    def test_try_operator_call(self):
        code = '''
fn process() -> Result<(), Error> {
    let data = read_file()?;
    process_data(data)?;
    Ok(())
}
'''
        calls = extract_calls_from_code(code, "test.rs")
        call_names = [c.callee_name for c in calls]
        self.assertIn("read_file", call_names)
        self.assertIn("process_data", call_names)
        self.assertIn("Ok", call_names)

    def test_generic_function_call(self):
        code = '''
fn process<T>() {
    parse::<T>(data);
    Vec::<i32>::new();
}
'''
        calls = extract_calls_from_code(code, "test.rs")
        call_names = [c.callee_name for c in calls]
        self.assertIn("parse", call_names)
        self.assertIn("new", call_names)

    def test_module_function_call(self):
        code = '''
fn process() {
    std::fs::read_to_string("file.txt");
    io::stdin().read_line(&mut buffer);
}
'''
        calls = extract_calls_from_code(code, "test.rs")
        call_names = [c.callee_name for c in calls]
        self.assertIn("read_to_string", call_names)
        self.assertIn("read_line", call_names)


@unittest.skipUnless(IMPORTS_AVAILABLE, "Dependencies not available")
class TestRustDefinitions(unittest.TestCase):
    """Test extraction of function definitions in Rust."""

    def test_function_definitions(self):
        code = '''
fn greet(name: &str) -> String {
    format!("Hello, {}!", name)
}

fn farewell(name: &str) -> String {
    format!("Goodbye, {}!", name)
}
'''
        defs = extract_definitions_from_code(code, "test.rs")
        names = [d.name for d in defs]
        self.assertIn("greet", names)
        self.assertIn("farewell", names)


@unittest.skipUnless(IMPORTS_AVAILABLE, "Dependencies not available")
class TestGoDefinitions(unittest.TestCase):
    """Test extraction of function definitions in Go."""

    def test_function_definitions(self):
        code = '''
package main

func greet(name string) string {
    return "Hello, " + name
}

func farewell(name string) string {
    return "Goodbye, " + name
}
'''
        defs = extract_definitions_from_code(code, "test.go")
        names = [d.name for d in defs]
        self.assertIn("greet", names)
        self.assertIn("farewell", names)


@unittest.skipUnless(IMPORTS_AVAILABLE, "Dependencies not available")
class TestJavaDefinitions(unittest.TestCase):
    """Test extraction of method definitions in Java."""

    def test_method_definitions(self):
        code = '''
public class Greeter {
    public String greet(String name) {
        return "Hello, " + name;
    }

    public String farewell(String name) {
        return "Goodbye, " + name;
    }
}
'''
        defs = extract_definitions_from_code(code, "test.java")
        method_defs = [d for d in defs if d.is_method]
        names = [d.name for d in method_defs]
        self.assertIn("greet", names)
        self.assertIn("farewell", names)


if __name__ == "__main__":
    unittest.main(verbosity=2)
