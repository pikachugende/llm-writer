/* ========================================================
   completion-engine.js — Completion orchestration
   
   Handles:
   - Detecting word vs multi-word completion triggers
   - Debouncing requests
   - Managing suggestion state (current index, cycling)
   - Coordinating with LLM engine and context manager
   ======================================================== */

import { CONFIG } from "./config.js";

export class CompletionEngine {
  constructor(llmEngine, contextManager) {
    this.llm = llmEngine;
    this.ctx = contextManager;

    // Current suggestions state
    this.suggestions = [];       // Array of strings
    this.currentIndex = 0;
    this.activeGhost = "";       // Currently displayed ghost text
    this.completionType = null;  // "word" | "multiword" | null
    this.isGenerating = false;

    // Debounce timers
    this._debounceTimer = null;
    this._generationId = 0;      // Incremented to cancel stale generations

    // Callbacks
    this.onGhostUpdate = null;   // (ghostText: string) => void
    this.onStatusChange = null;  // (status: string) => void
    this.onSuggestionMeta = null; // ({ index, total, visible }) => void
  }

  /**
   * Called on every text change in the editor.
   * Detects completion type and triggers generation.
   */
  handleTextChange(fullText, cursorPos) {
    // Only complete when cursor is at end of text
    if (cursorPos !== fullText.length) {
      this.dismiss();
      return;
    }

    const textBeforeCursor = fullText.substring(0, cursorPos);
    if (textBeforeCursor.length === 0) {
      this.dismiss();
      return;
    }

    // Detect completion type
    const lastChar = textBeforeCursor[textBeforeCursor.length - 1];
    const partialWord = this._getPartialWord(textBeforeCursor);

    if (lastChar === " " || lastChar === "\n") {
      // Multi-word: user finished a word (space/newline)
      this._scheduleCompletion(fullText, cursorPos, "multiword", CONFIG.multiWordDebounceMs);
    } else if (partialWord.length >= CONFIG.minWordChars) {
      // Word completion: user is mid-word
      this._scheduleCompletion(fullText, cursorPos, "word", CONFIG.wordDebounceMs);
    } else {
      this.dismiss();
    }
  }

  /**
   * Accept the current suggestion.
   * @returns {string} - text to insert
   */
  accept() {
    if (!this.activeGhost) return "";
    const text = this.activeGhost;
    this.dismiss();
    return text;
  }

  /**
   * Cycle to the next suggestion.
   */
  next() {
    if (this.suggestions.length === 0) return;
    this.currentIndex = (this.currentIndex + 1) % this.suggestions.length;
    this._showCurrent();
  }

  /**
   * Cycle to the previous suggestion.
   */
  prev() {
    if (this.suggestions.length === 0) return;
    this.currentIndex =
      (this.currentIndex - 1 + this.suggestions.length) % this.suggestions.length;
    this._showCurrent();
  }

  /**
   * Dismiss all suggestions.
   */
  dismiss() {
    this._cancelPending();
    this.suggestions = [];
    this.currentIndex = 0;
    this.activeGhost = "";
    this.completionType = null;
    this.isGenerating = false;
    this._emitGhost("");
    this._emitMeta({ index: 0, total: 0, visible: false });
  }

  // ── Private ──────────────────────────────────────────────

  _scheduleCompletion(fullText, cursorPos, type, delayMs) {
    clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => {
      this._triggerCompletion(fullText, cursorPos, type);
    }, delayMs);
  }

  async _triggerCompletion(fullText, cursorPos, type) {
    // Cancel any previous generation
    this._cancelPending();

    const genId = ++this._generationId;
    this.isGenerating = true;
    this.completionType = type;
    this._emitStatus("generating");

    console.debug("Completion request", {
      type,
      cursorPos,
      textLength: fullText.length,
    });

    const systemPrompt = this.ctx.getSystemPrompt(type);
    const userPrompt = this.ctx.buildPrompt(fullText, cursorPos, type);

    const maxTokens =
      type === "word" ? CONFIG.wordMaxTokens : CONFIG.multiWordMaxTokens;

    // Stop sequences
    const stop = type === "word" ? [" ", "\n", ".", ",", "!", "?", ";", ":"] : ["\n\n"];

    try {
      const variants = await this.llm.generateVariants(
        systemPrompt,
        userPrompt,
        { count: CONFIG.suggestionCount, maxTokens, stop },
        // onFirst callback — show immediately
        (firstResult) => {
          if (genId !== this._generationId) return; // stale
          const cleaned = this._cleanSuggestion(firstResult, fullText, type);
          if (cleaned) {
            this.suggestions = [cleaned];
            this.currentIndex = 0;
            this._showCurrent();
          }
        }
      );

      // If generation was superseded, discard
      if (genId !== this._generationId) return;

      // Clean & deduplicate all variants
      const cleaned = variants
        .map((v) => this._cleanSuggestion(v, fullText, type))
        .filter((v) => v && v.length > 0);

      // Deduplicate
      const unique = [...new Set(cleaned)];

      if (unique.length > 0) {
        this.suggestions = unique;
        this.currentIndex = 0;
        this._showCurrent();
      } else {
        console.warn("No suggestions after cleaning", {
          type,
          raw: variants,
          cleaned,
        });
      }
    } catch (err) {
      if (genId !== this._generationId) return;
      console.warn("Completion failed:", err);
    } finally {
      if (genId === this._generationId) {
        this.isGenerating = false;
        this._emitStatus("ready");
      }
    }

    // Trigger background summarization (non-blocking)
    this.ctx.maybeSummarize(fullText);
  }

  _cancelPending() {
    clearTimeout(this._debounceTimer);
    this._generationId++;
    if (this.isGenerating) {
      this.llm.cancel();
      this.isGenerating = false;
      this._emitStatus("ready");
    }
  }

  _showCurrent() {
    const suggestion = this.suggestions[this.currentIndex] || "";
    this.activeGhost = suggestion;
    this._emitGhost(suggestion);
    this._emitMeta({
      index: this.currentIndex + 1,
      total: this.suggestions.length,
      visible: this.suggestions.length > 0,
    });
  }

  /**
   * Clean up model output:
   * - Remove repeated text from the document
   * - Remove quotes, extra whitespace
   * - For word completion, extract just the remaining chars
   */
  _cleanSuggestion(raw, fullText, type) {
    if (!raw) return "";

    let cleaned = raw
      .replace(/^["'`]+|["'`]+$/g, "") // Remove surrounding quotes
      .replace(/\n+/g, " ")            // Collapse newlines to spaces
      .trim();

    if (type === "word") {
      // The model should output just the remaining letters
      // Remove any leading/trailing whitespace or punctuation artifacts
      cleaned = cleaned.split(/\s/)[0] || ""; // Take just the first "word"

      // If the model repeated the partial word, strip it
      const partialWord = this._getPartialWord(fullText);
      if (cleaned.toLowerCase().startsWith(partialWord.toLowerCase())) {
        cleaned = cleaned.slice(partialWord.length);
      }
    } else {
      // Multi-word: ensure it doesn't repeat the ending of the text
      const lastWords = fullText.trimEnd().split(/\s+/).slice(-3).join(" ");
      if (cleaned.startsWith(lastWords)) {
        cleaned = cleaned.slice(lastWords.length).trimStart();
      }
    }

    return cleaned;
  }

  _getPartialWord(text) {
    let i = text.length - 1;
    while (i >= 0 && /\S/.test(text[i])) {
      i--;
    }
    return text.slice(i + 1);
  }

  _emitGhost(text) {
    if (this.onGhostUpdate) this.onGhostUpdate(text);
  }

  _emitStatus(status) {
    if (this.onStatusChange) this.onStatusChange(status);
  }

  _emitMeta(meta) {
    if (this.onSuggestionMeta) this.onSuggestionMeta(meta);
  }
}
