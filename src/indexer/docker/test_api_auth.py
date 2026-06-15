#!/usr/bin/env python3
"""
Tests for the local indexer API shared-secret middleware.

Run with: python -m pytest test_api_auth.py -v
Or simply: python test_api_auth.py
"""

import os
import unittest

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api_auth import API_SECRET_ENV, API_SECRET_HEADER, install_indexer_api_auth


class ApiAuthMiddlewareTest(unittest.TestCase):
    def setUp(self):
        self._old_secret = os.environ.get(API_SECRET_ENV)

    def tearDown(self):
        if self._old_secret is None:
            os.environ.pop(API_SECRET_ENV, None)
        else:
            os.environ[API_SECRET_ENV] = self._old_secret

    def make_client(self, expected_secret=None):
        if expected_secret is None:
            os.environ.pop(API_SECRET_ENV, None)
        else:
            os.environ[API_SECRET_ENV] = expected_secret

        app = FastAPI()
        install_indexer_api_auth(app)

        @app.get("/health")
        def health():
            return {"status": "healthy"}

        return TestClient(app)

    def test_missing_header_is_rejected_when_secret_is_configured(self):
        client = self.make_client("test-secret")

        response = client.get("/health")

        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json(), {"detail": "Missing or invalid indexer API secret"})

    def test_wrong_header_is_rejected_when_secret_is_configured(self):
        client = self.make_client("test-secret")

        response = client.get("/health", headers={API_SECRET_HEADER: "wrong"})

        self.assertEqual(response.status_code, 401)

    def test_correct_header_is_allowed_when_secret_is_configured(self):
        client = self.make_client("test-secret")

        response = client.get("/health", headers={API_SECRET_HEADER: "test-secret"})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "healthy"})

    def test_requests_are_allowed_when_no_secret_is_configured(self):
        client = self.make_client()

        response = client.get("/health")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "healthy"})


if __name__ == "__main__":
    unittest.main()
