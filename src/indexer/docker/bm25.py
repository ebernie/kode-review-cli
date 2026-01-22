"""
BM25 keyword search implementation for code search.

This module provides BM25 (Best Matching 25) scoring for keyword search,
which complements vector similarity search with exact term matching.

BM25 is particularly effective for:
- Exact identifier matches (function names, class names)
- Technical terms that vector models may not capture well
- Rare but important keywords

Key features:
- Handles camelCase and snake_case variations
- Boosts exact function/class name matches by 3x
- Uses PostgreSQL full-text search with custom ranking
"""

import re
from dataclasses import dataclass
from typing import Optional


@dataclass
class KeywordMatch:
    """A code chunk matched by keyword search."""
    chunk_id: str
    file_path: str
    content: str
    line_start: int
    line_end: int
    chunk_type: Optional[str]
    symbol_names: list[str]
    bm25_score: float
    exact_match_boost: float  # Multiplier for exact symbol matches
    final_score: float  # bm25_score * exact_match_boost
    repo_url: str
    branch: str


def normalize_identifier(identifier: str) -> list[str]:
    """
    Normalize an identifier to handle camelCase and snake_case variations.

    Args:
        identifier: The identifier to normalize (e.g., 'getUserName', 'get_user_name')

    Returns:
        List of normalized variations for matching
    """
    variations = [identifier.lower()]

    # Split camelCase: getUserName -> ['get', 'user', 'name']
    camel_split = re.sub(r'([a-z])([A-Z])', r'\1 \2', identifier)
    camel_parts = camel_split.lower().split()
    if len(camel_parts) > 1:
        variations.extend(camel_parts)
        # Also add snake_case version
        variations.append('_'.join(camel_parts))

    # Split snake_case: get_user_name -> ['get', 'user', 'name']
    snake_parts = identifier.lower().split('_')
    if len(snake_parts) > 1:
        variations.extend(snake_parts)
        # Also add camelCase version
        camel_version = snake_parts[0] + ''.join(p.capitalize() for p in snake_parts[1:])
        variations.append(camel_version.lower())

    # Remove duplicates while preserving order
    seen = set()
    unique_variations = []
    for v in variations:
        if v not in seen and v:
            seen.add(v)
            unique_variations.append(v)

    return unique_variations


def build_tsquery(query: str) -> str:
    """
    Build a PostgreSQL tsquery from a search query.

    Handles:
    - Multiple words (OR by default)
    - camelCase/snake_case normalization
    - Special characters in code identifiers

    Args:
        query: The search query

    Returns:
        PostgreSQL tsquery string
    """
    # Split query into tokens
    tokens = re.split(r'\s+', query.strip())

    # Normalize each token and build query terms
    all_terms = []
    for token in tokens:
        if not token:
            continue

        # Get all variations of this token
        variations = normalize_identifier(token)

        # Create OR group for variations
        if len(variations) > 1:
            term_group = '(' + ' | '.join(variations) + ')'
        else:
            term_group = variations[0] if variations else token.lower()

        all_terms.append(term_group)

    # Join terms with OR (any term match is relevant)
    # Use & for AND if you want stricter matching
    return ' | '.join(all_terms) if all_terms else query.lower()


def calculate_exact_match_boost(
    query: str,
    symbol_names: list[str],
    exact_match_multiplier: float = 3.0
) -> float:
    """
    Calculate the boost multiplier for exact symbol name matches.

    If the query exactly matches a function/class name in the chunk,
    apply a 3x boost to prioritize exact identifier matches.

    Args:
        query: The search query
        symbol_names: List of symbol names defined in the chunk
        exact_match_multiplier: Multiplier for exact matches (default: 3.0)

    Returns:
        Boost multiplier (1.0 for no match, exact_match_multiplier for exact match)
    """
    if not symbol_names:
        return 1.0

    # Normalize query for comparison
    query_normalized = query.lower().strip()
    query_variations = set(normalize_identifier(query))

    for symbol in symbol_names:
        symbol_lower = symbol.lower()
        symbol_variations = set(normalize_identifier(symbol))

        # Check for exact match
        if query_normalized == symbol_lower:
            return exact_match_multiplier

        # Check if any variation matches
        if query_variations & symbol_variations:
            # Partial match gets a smaller boost
            return exact_match_multiplier * 0.7

    return 1.0


# BM25 parameters (can be tuned)
BM25_K1 = 1.2  # Term frequency saturation parameter
BM25_B = 0.75  # Document length normalization parameter


def bm25_score_sql(
    query_terms: list[str],
    content_column: str = "content",
    tsv_column: str = "content_tsv"
) -> str:
    """
    Generate SQL for BM25-style scoring using PostgreSQL ts_rank.

    PostgreSQL's ts_rank_cd (cover density) is similar to BM25 in that it
    considers term proximity. We use it with normalization for document length.

    Args:
        query_terms: List of search terms
        content_column: Name of the content column
        tsv_column: Name of the tsvector column

    Returns:
        SQL expression for BM25-style scoring
    """
    # Use ts_rank_cd with normalization option 1 (divide by 1 + log(doc length))
    # This approximates BM25's document length normalization
    return f"ts_rank_cd({tsv_column}, query, 1)"
