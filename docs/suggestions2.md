# Code Review Context Enhancements & Suggestions

Based on an analysis of the `src/review` directory (specifically `prompt.ts`, `engine.ts`, and `diff.ts`), here is an assessment of how semantic context is currently handled and suggestions for enhancement.

## 1. Enhancing Context: "Related" vs. "Similar"

The current implementation treats `semanticContext` mostly as a block of text found via "semantic search" (likely vector similarity). This is effective for finding *similar* code (e.g., "how did we implement this other button?"), but often misses *related* code (dependencies).

**The index should be used for related code beyond just similarity.** To do this, the context gathering phase should be augmented to include:

*   **Definition Lookups (Go-to-Definition):** If the diff modifies code using a type `User` or a function `calculateTotal()`, the context should include the *definitions* of `User` and `calculateTotal()` from other files. Vector search often misses this; symbol-based lookup is needed.
*   **Usage Lookups (Find References):** If the diff changes a function signature for `fetchData()`, the context should include a few examples of *where `fetchData` is called* in the codebase to check for breaking changes.
*   **Import Chains:** Include the content of files imported by the modified file (shallow depth) to provide immediate execution context.

**Implementation Suggestion:**
Structure `semanticContext` as detailed sections rather than a single blob:

```xml
<related_code>
  <similar_patterns>...</similar_patterns>
  <definitions>...</definitions>
  <callers>...</callers>
</related_code>
```

## 2. Low-Hanging Fruits for Improvement

If semantic context is unavailable or insufficient, here are high-value, low-effort additions to improve the review quality:

*   **Linter/Compiler Output (Highest Value):**
    Run `tsc --noEmit` (for TS) or `eslint` on the changed files *before* the review. Pass any errors/warnings into the prompt.
    *   *Why:* The LLM often "hallucinates" syntax errors or stylistic nitpicks. Real compiler output grounds the review in fact. "The compiler says this variable is unused" is infinitely better than "I think this variable might be unused."

*   **File Tree / Project Structure:**
    Include a simplified ASCII tree of the project structure (e.g., `src/`, `components/`, `utils/`).
    *   *Why:* Helps the LLM understand architectural intent. "Why are you putting a UI component in `src/utils`?" is a valid architectural critique that requires knowing the folder structure.

*   **Configuration Context:**
    Automatically read and include key config files (`package.json`, `tsconfig.json`, `.eslintrc`) if they aren't already in the diff.
    *   *Why:* Helps with dependency questions ("Do we have `lodash` installed?") and rule enforcement ("Are we allowing `any`?").

*   **Test Summary:**
    If tests exist for the modified files, run them and report "Pass/Fail" in the context.
    *   *Why:* If tests pass, the LLM can focus less on "does this work?" and more on "is this maintainable?".

## Summary Recommendation

To make the "index" usage more powerful, move beyond just **Vector Similarity** (searching for code that *looks* like this) to **Graph/Symbol Relations** (searching for code that *connects* to this). Combine this with ground-truth data from linters to significantly reduce hallucinated issues.
