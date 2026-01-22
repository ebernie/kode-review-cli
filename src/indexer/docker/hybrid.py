"""
Hybrid search implementation combining vector similarity and BM25 keyword search.

This module provides Reciprocal Rank Fusion (RRF) to combine results from:
- Vector similarity search (semantic understanding)
- BM25 keyword search (exact term matching)

RRF Formula: score = sum(1 / (k + rank)) for each result across all rankings
Where k is a constant (typically 60) that determines how much to favor top results.

Key features:
- Configurable weighting between vector and keyword search (default: 60% vector, 40% keyword)
- Support for quoted phrases for exact matching
- Fallback to pure vector search if keyword search returns nothing
- Handles deduplication when same chunk appears in both result sets
"""

import re
from dataclasses import dataclass, field
from typing import Optional


# Default RRF constant - higher values give more weight to lower-ranked results
RRF_K = 60

# Default weighting: 60% vector, 40% keyword
DEFAULT_VECTOR_WEIGHT = 0.6
DEFAULT_KEYWORD_WEIGHT = 0.4


@dataclass
class HybridMatch:
    """A code chunk from hybrid search with combined scoring."""
    chunk_id: str
    file_path: str
    content: str
    line_start: int
    line_end: int
    chunk_type: Optional[str]
    symbol_names: list[str]
    repo_url: Optional[str]
    branch: Optional[str]

    # Scoring breakdown
    vector_score: float  # Original cosine similarity (0-1)
    vector_rank: Optional[int]  # Rank in vector results (1-indexed, None if not in vector results)
    keyword_score: float  # BM25 score with exact match boost
    keyword_rank: Optional[int]  # Rank in keyword results (1-indexed, None if not in keyword results)
    rrf_score: float  # Combined RRF score

    # Source tracking
    sources: list[str] = field(default_factory=list)  # ['vector', 'keyword'] or subset


@dataclass
class HybridSearchConfig:
    """Configuration for hybrid search behavior."""
    vector_weight: float = DEFAULT_VECTOR_WEIGHT
    keyword_weight: float = DEFAULT_KEYWORD_WEIGHT
    rrf_k: int = RRF_K
    fallback_to_vector: bool = True  # If keyword returns nothing, use pure vector

    def __post_init__(self):
        # Normalize weights to sum to 1.0
        total = self.vector_weight + self.keyword_weight
        if total > 0:
            self.vector_weight = self.vector_weight / total
            self.keyword_weight = self.keyword_weight / total


def extract_quoted_phrases(query: str) -> tuple[list[str], str]:
    """
    Extract quoted phrases from a query for exact matching.

    Args:
        query: Search query that may contain quoted phrases

    Returns:
        Tuple of (list of quoted phrases, remaining query without quotes)

    Example:
        >>> extract_quoted_phrases('find "getUserById" in auth')
        (['getUserById'], 'find  in auth')
    """
    # Match both single and double quoted strings
    pattern = r'"([^"]+)"|\'([^\']+)\''

    phrases = []
    for match in re.finditer(pattern, query):
        # Get the matched group (either double or single quotes)
        phrase = match.group(1) or match.group(2)
        if phrase:
            phrases.append(phrase)

    # Remove quoted parts from query
    remaining = re.sub(pattern, '', query).strip()
    # Clean up extra whitespace
    remaining = re.sub(r'\s+', ' ', remaining)

    return phrases, remaining


def calculate_rrf_score(
    rank: Optional[int],
    weight: float,
    k: int = RRF_K
) -> float:
    """
    Calculate the RRF contribution for a single ranking.

    Args:
        rank: Position in the ranking (1-indexed), None if not present
        weight: Weight for this ranking source
        k: RRF constant (higher = more even distribution)

    Returns:
        RRF contribution score
    """
    if rank is None:
        return 0.0

    # RRF formula: weight / (k + rank)
    return weight / (k + rank)


def combine_results(
    vector_results: list[dict],
    keyword_results: list[dict],
    config: HybridSearchConfig,
    limit: int = 10
) -> list[HybridMatch]:
    """
    Combine vector and keyword search results using Reciprocal Rank Fusion.

    This function:
    1. Creates a unified index of all chunks by ID
    2. Assigns ranks from each source (1-indexed)
    3. Computes RRF score: weighted_sum(1/(k + rank))
    4. Returns sorted, deduplicated results

    Args:
        vector_results: Results from vector similarity search
                       Expected fields: id/chunk_id, file_path/filename, code/content,
                                       start_line/line_start, end_line/line_end,
                                       chunk_type, symbol_names, repo_url, branch, score
        keyword_results: Results from BM25 keyword search
                        Expected fields: same as vector, plus bm25_score, exact_match_boost, final_score
        config: Hybrid search configuration
        limit: Maximum results to return

    Returns:
        List of HybridMatch objects sorted by RRF score (descending)
    """
    # Build unified result map by chunk identifier
    # Key: (file_path, line_start, line_end) or chunk_id if available
    results_map: dict[str, HybridMatch] = {}

    # Process vector results (assign ranks 1, 2, 3, ...)
    for rank, result in enumerate(vector_results, start=1):
        # Handle different field naming conventions
        chunk_id = result.get('id') or result.get('chunk_id') or ''
        file_path = result.get('file_path') or result.get('filename') or ''
        content = result.get('content') or result.get('code') or ''
        line_start = result.get('line_start') or result.get('start_line') or 0
        line_end = result.get('line_end') or result.get('end_line') or 0

        # Create a unique key for deduplication
        # Use chunk_id if available, otherwise use file+lines
        if chunk_id:
            key = chunk_id
        else:
            key = f"{file_path}:{line_start}:{line_end}"

        vector_score = result.get('score') or 0.0

        if key not in results_map:
            results_map[key] = HybridMatch(
                chunk_id=chunk_id,
                file_path=file_path,
                content=content,
                line_start=line_start,
                line_end=line_end,
                chunk_type=result.get('chunk_type'),
                symbol_names=result.get('symbol_names') or [],
                repo_url=result.get('repo_url'),
                branch=result.get('branch'),
                vector_score=vector_score,
                vector_rank=rank,
                keyword_score=0.0,
                keyword_rank=None,
                rrf_score=0.0,
                sources=['vector'],
            )
        else:
            # Update existing entry with vector info
            results_map[key].vector_score = vector_score
            results_map[key].vector_rank = rank
            if 'vector' not in results_map[key].sources:
                results_map[key].sources.append('vector')

    # Process keyword results (assign ranks 1, 2, 3, ...)
    for rank, result in enumerate(keyword_results, start=1):
        # Handle different field naming conventions
        chunk_id = result.get('id') or result.get('chunk_id') or ''
        file_path = result.get('file_path') or result.get('filename') or ''
        content = result.get('content') or result.get('code') or ''
        line_start = result.get('line_start') or result.get('start_line') or 0
        line_end = result.get('line_end') or result.get('end_line') or 0

        # Create a unique key for deduplication
        if chunk_id:
            key = chunk_id
        else:
            key = f"{file_path}:{line_start}:{line_end}"

        keyword_score = result.get('final_score') or result.get('bm25_score') or 0.0

        if key not in results_map:
            results_map[key] = HybridMatch(
                chunk_id=chunk_id,
                file_path=file_path,
                content=content,
                line_start=line_start,
                line_end=line_end,
                chunk_type=result.get('chunk_type'),
                symbol_names=result.get('symbol_names') or [],
                repo_url=result.get('repo_url'),
                branch=result.get('branch'),
                vector_score=0.0,
                vector_rank=None,
                keyword_score=keyword_score,
                keyword_rank=rank,
                rrf_score=0.0,
                sources=['keyword'],
            )
        else:
            # Update existing entry with keyword info
            results_map[key].keyword_score = keyword_score
            results_map[key].keyword_rank = rank
            if 'keyword' not in results_map[key].sources:
                results_map[key].sources.append('keyword')

    # Calculate RRF scores for all results
    for match in results_map.values():
        vector_contribution = calculate_rrf_score(
            match.vector_rank,
            config.vector_weight,
            config.rrf_k
        )
        keyword_contribution = calculate_rrf_score(
            match.keyword_rank,
            config.keyword_weight,
            config.rrf_k
        )
        match.rrf_score = vector_contribution + keyword_contribution

    # Sort by RRF score (descending) and return top results
    sorted_results = sorted(
        results_map.values(),
        key=lambda x: x.rrf_score,
        reverse=True
    )

    return sorted_results[:limit]


def build_exact_phrase_query(phrases: list[str]) -> str:
    """
    Build a PostgreSQL tsquery for exact phrase matching.

    Args:
        phrases: List of phrases to match exactly

    Returns:
        PostgreSQL tsquery string for phrase matching

    Example:
        >>> build_exact_phrase_query(['getUserById'])
        "getuserbyid"
    """
    if not phrases:
        return ""

    # For exact phrases, we use the raw phrase (lowercased)
    # PostgreSQL's phraseto_tsquery handles multi-word phrases
    queries = []
    for phrase in phrases:
        # For single words, just lowercase
        # For multi-word phrases, join with <-> for adjacency
        words = phrase.lower().split()
        if len(words) == 1:
            queries.append(words[0])
        else:
            # Use <-> for phrase search (adjacent words)
            queries.append(' <-> '.join(words))

    # Combine multiple phrases with AND
    return ' & '.join(f'({q})' for q in queries) if queries else ""


def should_use_keyword_search(query: str) -> bool:
    """
    Determine if the query would benefit from keyword search.

    Keyword search is particularly useful for:
    - Short, specific identifiers (function names, class names)
    - Queries with special code characters (dots, underscores)
    - Quoted exact phrases

    Args:
        query: The search query

    Returns:
        True if keyword search should be included
    """
    # Always include keyword search for now, but this function
    # can be extended to optimize based on query characteristics

    # Check for code-like patterns
    has_code_chars = bool(re.search(r'[._]', query))
    has_camel_case = bool(re.search(r'[a-z][A-Z]', query))
    has_quotes = bool(re.search(r'["\']', query))
    is_short = len(query.split()) <= 3

    # If it looks like code, keyword search is valuable
    return has_code_chars or has_camel_case or has_quotes or is_short
