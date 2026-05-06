/**
 * engine.worker.ts
 *
 * Runs the WebLLM MLCEngine entirely off the main thread.
 * The UI thread communicates via postMessage; this worker handles:
 *   – Model initialisation with download-progress callbacks
 *   – Streaming chat completions (token-by-token)
 *   – Abort signals
 *
 * ─── MANDATORY server headers (Cross-Origin Isolation) ──────────────────────
 * SharedArrayBuffer (required by WebGPU/WebLLM) is only available when the
 * page is served with BOTH of the following HTTP headers:
 *
 *   Cross-Origin-Opener-Policy:   same-origin
 *   Cross-Origin-Embedder-Policy: require-corp
 *
 * The Vite dev-server already sends these (see vite.config.ts).
 * You MUST replicate this in your production server / CDN config.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { CreateMLCEngine } from '@mlc-ai/web-llm';
import type { MLCEngine, InitProgressReport, AppConfig } from '@mlc-ai/web-llm';
import type { ToWorker, FromWorker } from './types';
import { GEMMA4_E2B_MODEL_ID, GEMMA4_E4B_MODEL_ID } from './types';

// ── Gemma 4 model definitions (custom HuggingFace repos) ─────────────────────

const E2B_REPO = 'https://huggingface.co/welcoma/gemma-4-E2B-it-q4f16_1-MLC';
const E4B_REPO = 'https://huggingface.co/welcoma/gemma-4-E4B-it-q4f16_1-MLC';

function buildAppConfig(modelId: string): AppConfig {
  const repo = modelId === GEMMA4_E4B_MODEL_ID ? E4B_REPO : E2B_REPO;
  const libName = `${modelId}-webgpu.wasm`;
  return {
    model_list: [
      {
        model: repo,
        model_id: modelId,
        model_lib: `${repo}/resolve/main/libs/${libName}`,
        required_features: ['shader-f16'],
      },
    ],
  };
}

// ── State ────────────────────────────────────────────────────────────────────

let engine: MLCEngine | null = null;
let abortRequested = false;

// Shared progress callback — stored so it can be reused on reload.
const progressCb = (report: InitProgressReport) => {
  self.postMessage({
    type: 'progress',
    progress: Math.round(report.progress * 100),
    text: report.text,
  } satisfies FromWorker);
};

// ── Message handler ──────────────────────────────────────────────────────────

self.onmessage = async (event: MessageEvent<ToWorker>) => {
  const msg = event.data;

  switch (msg.type) {
    // ── Initialise the engine (download + compile) ─────────────────────────
    case 'init': {
      try {
        const appConfig = (msg.appConfig as AppConfig | undefined) ?? buildAppConfig(msg.model);
        engine = await CreateMLCEngine(msg.model, {
          initProgressCallback: progressCb,
          appConfig,
        });
        self.postMessage({ type: 'ready', cached: true } satisfies FromWorker);
      } catch (err) {
        self.postMessage({
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        } satisfies FromWorker);
      }
      break;
    }

    // ── Stream a chat completion ───────────────────────────────────────────
    case 'generate': {
      if (!engine) {
        self.postMessage({
          type: 'error',
          message: 'Engine is not initialised yet.',
        } satisfies FromWorker);
        return;
      }

      abortRequested = false;

      try {
        const stream = await engine.chat.completions.create({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          messages: msg.messages as any,
          stream: true,
          temperature: 0.7,
          top_p: 0.95,
          extra_body: {
            enable_thinking: true,
          },
        });

        for await (const chunk of stream) {
          if (abortRequested) break;

          const delta = chunk.choices[0]?.delta?.content ?? '';
          if (delta) {
            self.postMessage({ type: 'chunk', id: msg.id, delta } satisfies FromWorker);
          }
        }
      } catch (err) {
        self.postMessage({
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        } satisfies FromWorker);
      } finally {
        self.postMessage({ type: 'done', id: msg.id } satisfies FromWorker);
        abortRequested = false;
      }
      break;
    }

    // ── Abort the current stream ───────────────────────────────────────────
    case 'abort': {
      abortRequested = true;
      break;
    }
  }
};
