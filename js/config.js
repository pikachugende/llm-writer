/* ========================================================
   config.js — Model & app configuration
   
   Change the model IDs here to swap models.
   When Gemma 4 E2B becomes available in Web-LLM, 
   just update the model_id strings below.
   ======================================================== */

export const CONFIG = {
  // ── Model Configuration ──────────────────────────────────
  // Both word and multi-word completion use the same model by default.
  // You can set them to different model IDs if desired.
  wordCompletionModel: "gemma-4-E2B-it-q4f16_1-MLC",
  multiWordCompletionModel: "gemma-4-E2B-it-q4f16_1-MLC",

  // ── Completion Settings ──────────────────────────────────
  // Number of alternative suggestions to generate
  suggestionCount: 3,

  // Temperature per suggestion variant (lower = more deterministic)
  temperatures: [0.25, 0.6, 1.0],

  // Max tokens for word completion (just finish the word)
  wordMaxTokens: 12,
  // Max tokens for multi-word completion (contextual)
  multiWordMaxTokens: 40,

  // Debounce delays (ms)
  wordDebounceMs: 400,
  multiWordDebounceMs: 500,

  // Minimum characters typed in a word before triggering word completion
  minWordChars: 2,

  // ── Context Window Management ────────────────────────────
  // Max characters of recent text to send to the LLM
  recentContextChars: 3000,
  // When document exceeds this many chars, trigger background summarization
  summarizationThreshold: 4000,
  // Max chars for the summary itself
  summaryMaxChars: 500,
  // How often to re-summarize (in characters of new text written)
  reSummarizeInterval: 2000,

  // ── Auto-save ────────────────────────────────────────────
  autoSaveIntervalMs: 3000,
  localStorageKey: "llm_writer_content",
  localStorageSummaryKey: "llm_writer_summary",
};
