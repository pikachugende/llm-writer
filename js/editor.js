/* ========================================================
   editor.js — Editor UI component
   
   Handles:
   - Textarea ↔ backdrop sync (ghost text overlay)
   - Scroll synchronization
   - Keyboard shortcuts (Tab, Escape, Alt+↑/↓)
   - Auto-save to localStorage
   ======================================================== */

import { CONFIG } from "./config.js";

export class Editor {
  constructor(completionEngine) {
    this.completion = completionEngine;

    // DOM elements
    this.textarea = document.getElementById("editor");
    this.backdrop = document.getElementById("editor-backdrop");
    this.backdropPre = document.getElementById("backdrop-pre");
    this.saveStatus = document.getElementById("save-status");
    this.wordCountEl = document.getElementById("word-count");
    this.aiStatusEl = document.getElementById("ai-status");
    this.suggestionIndicator = document.getElementById("suggestion-indicator");
    this.suggestionIndex = document.getElementById("suggestion-index");
    this.suggestionTotal = document.getElementById("suggestion-total");

    // State
    this._isDirty = false;
    this._autoSaveTimer = null;
    this._currentGhost = "";

    this._init();
  }

  _init() {
    // Restore saved content
    this._restoreContent();

    // Wire up events
    this.textarea.addEventListener("input", () => this._onInput());
    this.textarea.addEventListener("scroll", () => this._syncScroll());
    this.textarea.addEventListener("keydown", (e) => this._onKeyDown(e));
    this.textarea.addEventListener("mouseup", () => this._onCursorMove());
    this.textarea.addEventListener("focus", () => this._updateBackdrop());

    // Wire up completion callbacks
    this.completion.onGhostUpdate = (ghost) => this._setGhost(ghost);
    this.completion.onStatusChange = (status) => this._setAIStatus(status);
    this.completion.onSuggestionMeta = (meta) => this._setSuggestionMeta(meta);

    // Initial render
    this._updateBackdrop();
    this._updateWordCount();

    // Auto-save interval
    this._autoSaveTimer = setInterval(() => this._autoSave(), CONFIG.autoSaveIntervalMs);

    // Save on page unload
    window.addEventListener("beforeunload", () => this._autoSave());

    // Focus the editor
    this.textarea.focus();
  }

  // ── Event handlers ─────────────────────────────────────

  _onInput() {
    this._isDirty = true;
    this.saveStatus.textContent = "Unsaved";
    this.saveStatus.classList.add("unsaved");

    this._updateBackdrop();
    this._updateWordCount();

    // Trigger completion engine
    const text = this.textarea.value;
    const cursor = this.textarea.selectionStart;
    this.completion.handleTextChange(text, cursor);
  }

  _onCursorMove() {
    const text = this.textarea.value;
    const cursor = this.textarea.selectionStart;

    // If cursor is not at end, dismiss suggestions
    if (cursor !== text.length) {
      this.completion.dismiss();
    }
  }

  _onKeyDown(e) {
    // ── Tab: Accept suggestion ──
    if (e.key === "Tab" && this._currentGhost) {
      e.preventDefault();
      const insertion = this.completion.accept();
      if (insertion) {
        this._insertText(insertion);
      }
      return;
    }

    // ── Escape: Dismiss suggestion ──
    if (e.key === "Escape" && this._currentGhost) {
      e.preventDefault();
      this.completion.dismiss();
      return;
    }

    // ── Alt+ArrowDown: Next suggestion ──
    if (e.key === "ArrowDown" && e.altKey && this.completion.suggestions.length > 0) {
      e.preventDefault();
      this.completion.next();
      return;
    }

    // ── Alt+ArrowUp: Previous suggestion ──
    if (e.key === "ArrowUp" && e.altKey && this.completion.suggestions.length > 0) {
      e.preventDefault();
      this.completion.prev();
      return;
    }

    // Any other key dismisses current suggestions (will re-trigger via input event)
    if (this._currentGhost && !e.altKey && !e.ctrlKey && !e.metaKey && e.key.length === 1) {
      this.completion.dismiss();
    }
  }

  // ── Ghost text rendering ────────────────────────────────

  _setGhost(ghost) {
    this._currentGhost = ghost;
    this._updateBackdrop();
  }

  _updateBackdrop() {
    const text = this.textarea.value;
    const escaped = this._escapeHTML(text);

    if (this._currentGhost) {
      this.backdropPre.innerHTML =
        escaped +
        `<span class="ghost-text">${this._escapeHTML(this._currentGhost)}</span>`;
    } else {
      this.backdropPre.innerHTML = escaped;
    }

    // Ensure backdrop stays in sync with textarea scroll
    this._syncScroll();
  }

  _syncScroll() {
    this.backdropPre.style.transform = `translateY(-${this.textarea.scrollTop}px)`;
  }

  // ── Text insertion ──────────────────────────────────────

  _insertText(text) {
    const start = this.textarea.selectionStart;
    const end = this.textarea.selectionEnd;
    const before = this.textarea.value.substring(0, start);
    const after = this.textarea.value.substring(end);

    this.textarea.value = before + text + after;
    const newPos = start + text.length;
    this.textarea.selectionStart = newPos;
    this.textarea.selectionEnd = newPos;

    // Trigger input handling
    this._onInput();
  }

  // ── Status updates ──────────────────────────────────────

  _setAIStatus(status) {
    const dot = this.aiStatusEl.querySelector(".ai-dot");
    const label = this.aiStatusEl;

    if (status === "generating") {
      dot.className = "ai-dot generating";
      label.innerHTML = `<span class="ai-dot generating"></span> Thinking...`;
    } else {
      dot.className = "ai-dot";
      label.innerHTML = `<span class="ai-dot"></span> AI Ready`;
    }
  }

  _setSuggestionMeta({ index, total, visible }) {
    this.suggestionIndicator.hidden = !visible;
    if (visible) {
      this.suggestionIndex.textContent = index;
      this.suggestionTotal.textContent = total;
    }
  }

  _updateWordCount() {
    const text = this.textarea.value.trim();
    const words = text ? text.split(/\s+/).length : 0;
    this.wordCountEl.textContent = `${words} word${words !== 1 ? "s" : ""}`;
  }

  // ── Auto-save ───────────────────────────────────────────

  _autoSave() {
    if (!this._isDirty) return;
    try {
      localStorage.setItem(CONFIG.localStorageKey, this.textarea.value);
      this._isDirty = false;
      this.saveStatus.textContent = "Saved";
      this.saveStatus.classList.remove("unsaved");
    } catch (err) {
      console.warn("Auto-save failed:", err);
    }
  }

  _restoreContent() {
    try {
      const saved = localStorage.getItem(CONFIG.localStorageKey);
      if (saved) {
        this.textarea.value = saved;
      }
    } catch (_) {}
  }

  // ── Utilities ───────────────────────────────────────────

  _escapeHTML(text) {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
}
