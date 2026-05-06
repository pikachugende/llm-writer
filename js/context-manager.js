/* ========================================================
   context-manager.js — Smart context window management
   
   Handles:
   - Extracting relevant text around the cursor
   - Background summarization of older text
   - Building optimized prompts for the LLM
   ======================================================== */

import { CONFIG } from "./config.js";

export class ContextManager {
  constructor(llmEngine) {
    this.llm = llmEngine;
    this._summary = "";
    this._summarizedUpTo = 0; // char index up to which we've summarized
    this._isSummarizing = false;
    this._lastSummaryTrigger = 0;

    // Restore summary from localStorage
    try {
      const saved = localStorage.getItem(CONFIG.localStorageSummaryKey);
      if (saved) {
        const parsed = JSON.parse(saved);
        this._summary = parsed.summary || "";
        this._summarizedUpTo = parsed.summarizedUpTo || 0;
      }
    } catch (_) {}

  }

  /**
   * Build the system prompt based on completion type.
   */
  getSystemPrompt(type) {
    if (type === "word") {
      return "Return JSON only: {\"completion\":\"<full word>\"}.";
    }
    return "Return JSON only: {\"completion\":\"<continuation>\"}.";
  }

  /**
   * Build the user prompt with smart context.
   * @param {string} fullText - entire document text
   * @param {number} cursorPos - cursor position in the text
   * @param {string} type - "word" or "multiword"
   */
  buildPrompt(fullText, cursorPos, type) {
    const textBeforeCursor = fullText.substring(0, cursorPos);

    // Determine how much recent context to include
    let recentText;
    let prefix = "";

    if (textBeforeCursor.length <= CONFIG.recentContextChars) {
      // Short document — use everything
      recentText = textBeforeCursor;
    } else {
      // Long document — use summary + recent window
      recentText = textBeforeCursor.slice(-CONFIG.recentContextChars);

      // Find a clean break point (paragraph or sentence boundary)
      const breakIdx = recentText.indexOf("\n");
      if (breakIdx > 0 && breakIdx < 200) {
        recentText = recentText.slice(breakIdx + 1);
      }

      if (this._summary) {
        prefix = `[Document context summary: ${this._summary}]\n\n---\n\n`;
      }
    }

    if (type === "word") {
      // Extract the partial word being typed
      const partialWord = this._getPartialWord(textBeforeCursor);
      const contextBefore = textBeforeCursor.slice(
        -(Math.min(500, textBeforeCursor.length))
      );
      return `${prefix}Here is the recent text:\n"""${contextBefore}"""\n\nThe user started a word that begins with "${partialWord}". Output the full word as JSON:`;
    }

    // Multi-word completion
    // Determine appropriate continuation length based on context
    const lastSentences = this._getLastSentences(recentText, 3);
    return `${prefix}Continue this text:\n"""${lastSentences}"""\n\nContinue:`;
  }

  /**
   * Trigger background summarization if needed.
   */
  async maybeSummarize(fullText) {
    if (!this.llm.ready || this._isSummarizing) return;
    if (fullText.length < CONFIG.summarizationThreshold) return;

    // Only re-summarize if enough new text has been written
    const newTextSince = fullText.length - this._lastSummaryTrigger;
    if (this._summary && newTextSince < CONFIG.reSummarizeInterval) return;

    this._isSummarizing = true;
    this._lastSummaryTrigger = fullText.length;

    try {
      // Summarize the older portion (everything except recent window)
      const olderText = fullText.slice(
        0,
        Math.max(0, fullText.length - CONFIG.recentContextChars)
      );

      if (olderText.length < 200) {
        this._isSummarizing = false;
        return;
      }

      // Take a representative sample if very long
      let textToSummarize = olderText;
      if (olderText.length > 6000) {
        // Take start + end portions
        const start = olderText.slice(0, 3000);
        const end = olderText.slice(-3000);
        textToSummarize = start + "\n[...]\n" + end;
      }

      const summary = await this.llm.generate(
        "You are a summarization assistant. Produce a concise summary of the given text in 2-3 sentences. Focus on the main topics, key points, and writing style. This summary will be used as context for text completion.",
        `Summarize this text:\n"""${textToSummarize}"""`,
        { maxTokens: 100, temperature: 0.3 }
      );

      if (summary && summary.length > 10) {
        this._summary = summary;
        this._summarizedUpTo = olderText.length;

        // Persist summary
        try {
          localStorage.setItem(
            CONFIG.localStorageSummaryKey,
            JSON.stringify({
              summary: this._summary,
              summarizedUpTo: this._summarizedUpTo,
            })
          );
        } catch (_) {}
      }
    } catch (err) {
      console.warn("Summarization failed:", err);
    } finally {
      this._isSummarizing = false;
    }
  }

  /**
   * Clear the cached summary (e.g., when document is cleared).
   */
  clearSummary() {
    this._summary = "";
    this._summarizedUpTo = 0;
    this._lastSummaryTrigger = 0;
    try {
      localStorage.removeItem(CONFIG.localStorageSummaryKey);
    } catch (_) {}
  }

  // ── Private helpers ──────────────────────────────────────

  _getPartialWord(text) {
    // Walk backwards from end to find the start of the current word
    let i = text.length - 1;
    while (i >= 0 && /\S/.test(text[i])) {
      i--;
    }
    return text.slice(i + 1);
  }

  _getLastSentences(text, count) {
    // Get the last N sentences for context
    const trimmed = text.trimEnd();
    const sentences = trimmed.split(/(?<=[.!?])\s+/);
    const lastN = sentences.slice(-count);
    return lastN.join(" ");
  }
}
