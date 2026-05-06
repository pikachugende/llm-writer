/* ========================================================
   llm-engine.js — Web-LLM wrapper
   
   Handles model initialization, caching, and inference.
   ======================================================== */

import { CONFIG } from "./config.js";

export class LLMEngine {
  constructor() {
    this.engine = null;
    this.ready = false;
    this._currentModelId = null;
    this._abortController = null;
  }

  /**
   * Initialize the engine — download & cache the model.
   * @param {Function} onProgress - callback({ text, progress })
   */
  async init(onProgress) {
    const modelId = CONFIG.wordCompletionModel;
    const webllm = await import("https://esm.run/@mlc-ai/web-llm");

    // Use the custom HuggingFace repo for Gemma 4 like in the reference project
    let appConfig = webllm.prebuiltAppConfig;
    if (modelId === "gemma-4-E2B-it-q4f16_1-MLC") {
      const repo = 'https://huggingface.co/welcoma/gemma-4-E2B-it-q4f16_1-MLC';
      appConfig = {
        model_list: [
          {
            model: repo,
            model_id: modelId,
            model_lib: `${repo}/resolve/main/libs/${modelId}-webgpu.wasm`,
            required_features: ['shader-f16'],
            overrides: {
              context_window_size: 4096,
              sliding_window_size: -1,
            }
          },
        ],
      };
    } else {
      // Fallback for prebuilt models (e.g. gemma3-1b)
      appConfig = { ...webllm.prebuiltAppConfig };
      appConfig.model_list = appConfig.model_list.map(model => {
        if (model.model_id === modelId) {
          return {
            ...model,
            overrides: {
              ...model.overrides,
              sliding_window_size: -1,
              context_window_size: 4096,
            }
          };
        }
        return model;
      });
    }

    this.engine = await webllm.CreateMLCEngine(modelId, {
      appConfig,
      initProgressCallback: (report) => {
        if (onProgress) {
          onProgress({
            text: report.text || "",
            progress: report.progress || 0,
          });
        }
      },
    });

    this._currentModelId = modelId;
    this.ready = true;
  }

  /**
   * Cancel any in-flight generation.
   */
  cancel() {
    if (this.engine) {
      try {
        this.engine.interruptGenerate();
      } catch (_) {
        // not all versions support this; ignore
      }
    }
  }

  /**
   * Generate a single text completion.
   * @param {string} systemPrompt
   * @param {string} userPrompt
   * @param {object} opts - { maxTokens, temperature, stop }
   * @returns {Promise<string>} - the generated text
   */
  async generate(systemPrompt, userPrompt, opts = {}) {
    if (!this.ready) throw new Error("LLM engine not initialized");

    const {
      maxTokens = 30,
      temperature = 0.4,
      stop = [],
    } = opts;

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];

    const response = await this.engine.chat.completions.create({
      messages,
      max_tokens: maxTokens,
      temperature,
      stop: stop.length ? stop : undefined,
      top_p: 0.9,
      repetition_penalty: 1.1,
    });

    const choice = response?.choices?.[0];
    const text =
      choice?.message?.content ??
      choice?.text ??
      "";

    if (!text) {
      console.debug("LLM generate returned empty", {
        response,
      });
    }

    return text.trim();
  }

  /**
   * Generate multiple completion variants.
   * Returns the first one immediately via callback, then the rest.
   * @param {string} systemPrompt
   * @param {string} userPrompt
   * @param {object} opts
   * @param {Function} onFirst - called with first result immediately
   * @returns {Promise<string[]>} - all results
   */
  async generateVariants(systemPrompt, userPrompt, opts = {}, onFirst = null) {
    const {
      count = CONFIG.suggestionCount,
      maxTokens = 30,
      stop = [],
    } = opts;

    const results = new Array(count).fill("");
    let firstDelivered = false;

    const tasks = Array.from({ length: count }, (_, i) => {
      const temp = CONFIG.temperatures[i] ?? 0.5;
      return this.generate(systemPrompt, userPrompt, {
        maxTokens,
        temperature: temp,
        stop,
      })
        .then((text) => {
          results[i] = text;
          if (!firstDelivered && onFirst) {
            firstDelivered = true;
            onFirst(text);
          }
        })
        .catch((err) => {
          if (err?.message?.includes("interrupt")) return;
          console.warn(`Variant ${i} failed:`, err);
          results[i] = "";
        });
    });

    await Promise.allSettled(tasks);
    return results;
  }
}
