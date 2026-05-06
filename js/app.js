/* ========================================================
   app.js — Main application entry point
   
   Bootstraps the app:
   1. Check WebGPU support
   2. Load the LLM model (with progress UI)
   3. Initialize editor + completion engine
   ======================================================== */

import { LLMEngine } from "./llm-engine.js";
import { ContextManager } from "./context-manager.js";
import { CompletionEngine } from "./completion-engine.js";
import { Editor } from "./editor.js";

async function main() {
  const loadingScreen = document.getElementById("loading-screen");
  const errorScreen = document.getElementById("error-screen");
  const editorScreen = document.getElementById("editor-screen");
  const progressFill = document.getElementById("progress-fill");
  const progressText = document.getElementById("progress-text");
  const errorMessage = document.getElementById("error-message");

  // ── Step 1: Check WebGPU ─────────────────────────────────
  const debugInfo = document.getElementById("debug-info");
  const errorDetails = document.getElementById("error-details");
  const errorTitle = document.querySelector("#error-screen .loading-title");

  const buildEnvDebug = () => (
    `protocol = ${window.location.protocol}, isSecureContext = ${window.isSecureContext}, ` +
    `crossOriginIsolated = ${window.crossOriginIsolated}, navigator.gpu = ${typeof navigator.gpu}`
  );

  if (debugInfo) {
    debugInfo.textContent = buildEnvDebug();
  }

  function showError(msg, debug, isWebGpuError = true) {
    loadingScreen.hidden = true;
    errorScreen.hidden = false;
    if (errorMessage) {
      errorMessage.textContent = msg;
    } else if (errorTitle) {
      errorTitle.textContent = msg;
    }
    
    if (!isWebGpuError) {
      errorTitle.textContent = "AI Engine Error";
      if (errorDetails) {
        // Hide the WebGPU troubleshooting steps
        const steps = errorDetails.querySelectorAll(".error-step-title, .error-steps");
        steps.forEach(el => el.hidden = true);
      }
    } else {
      errorTitle.textContent = "WebGPU Not Available";
    }

    if (debugInfo) debugInfo.textContent = debug || buildEnvDebug();

    console.error("Startup error:", msg, debug || buildEnvDebug());
  }

  if (!window.isSecureContext) {
    showError(
      "LLM Writer must be opened from a secure origin.",
      `protocol = ${window.location.protocol}, crossOriginIsolated = ${window.crossOriginIsolated}, navigator.gpu = ${typeof navigator.gpu}`
    );
    return;
  }

  if (!navigator.gpu) {
    showError(
      "Your browser does not support WebGPU.",
      `navigator.gpu = ${typeof navigator.gpu}, protocol = ${window.location.protocol}, crossOriginIsolated = ${window.crossOriginIsolated}, userAgent = ${navigator.userAgent}`
    );
    return;
  }

  try {
    let adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      adapter = await navigator.gpu.requestAdapter({ forceFallbackAdapter: true });
    }

    if (!adapter) {
      showError(
        "WebGPU is available, but no compatible GPU adapter was found.",
        "requestAdapter() returned null twice, including a fallback request. Check that Chrome was restarted after enabling WebGPU, that the page is not opened from file://, and that your GPU drivers are up to date."
      );
      return;
    }

    if (adapter.isFallbackAdapter) {
      console.warn("Using WebGPU fallback adapter.");
    }

    if (adapter.features && !adapter.features.has("shader-f16")) {
      showError(
        "Your GPU supports WebGPU, but it is missing a feature required by this model.",
        "adapter.features does not include shader-f16. Try a different GPU, update your drivers, or choose a model that does not require f16 support.",
        false
      );
      return;
    }

    // Log adapter info for debugging
    try {
      const info = await adapter.requestAdapterInfo();
      console.log("WebGPU adapter:", info);
    } catch (_) {}
  } catch (err) {
    showError(
      `WebGPU adapter error: ${err.message}`,
      `requestAdapter() threw: ${err.message}`
    );
    return;
  }

  // ── Step 2: Load LLM ────────────────────────────────────
  progressText.textContent = "Initializing AI engine...";

  const llm = new LLMEngine();

  try {
    await llm.init((progress) => {
      const pct = Math.round((progress.progress || 0) * 100);
      progressFill.style.width = `${pct}%`;

      // Shorten the progress text for display
      let displayText = progress.text || "";
      if (displayText.length > 80) {
        displayText = displayText.substring(0, 77) + "...";
      }
      progressText.textContent = displayText || `Loading model... ${pct}%`;
    });
  } catch (err) {
    showError(`Failed to load AI model: ${err.message}`, `webllm.CreateMLCEngine threw: ${err.message}`, false);
    console.error("Model loading failed:", err);
    return;
  }

  // ── Step 3: Initialize components ────────────────────────
  progressFill.style.width = "100%";
  progressText.textContent = "Ready!";

  // Brief pause for the "Ready!" state to be visible
  await new Promise((r) => setTimeout(r, 500));

  // Fade out loading screen
  loadingScreen.classList.add("fade-out");
  await new Promise((r) => setTimeout(r, 400));
  loadingScreen.hidden = true;

  // Show editor
  editorScreen.hidden = false;

  // Wire everything together
  const contextManager = new ContextManager(llm);
  const completionEngine = new CompletionEngine(llm, contextManager);
  const editor = new Editor(completionEngine);

  // Expose for debugging in console
  window.__llmWriter = { llm, contextManager, completionEngine, editor };

  console.log("LLM Writer initialized successfully.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
});
