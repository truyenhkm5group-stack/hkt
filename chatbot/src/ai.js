import { config } from "./config.js";
import * as gemini from "./gemini.js";
import * as openai from "./openai.js";
import { currentAiPage, usageTokens } from "./aicost.js";
import { store } from "./store.js";

/**
 * Bo chon nha cung cap AI: AI_PROVIDER=gemini (mac dinh) | openai (ChatGPT).
 * Moi module khac chi import tu day; gemini.js va openai.js co cung giao dien.
 */
function impl() {
  return config.ai.provider === "openai" ? openai : gemini;
}

export function providerName() {
  return config.ai.provider;
}

export function listModels() {
  return impl().listModels();
}

function defaultModel() {
  return config.ai.provider === "openai" ? config.openai.model : config.gemini.model;
}

/** Ghi token cua MOI lan goi AI (xem aicost.js). Loi ghi so khong duoc lam hong cau tra loi. */
function tally(opts, res) {
  try {
    if (res && res.usage) store.addAiUsage(currentAiPage(), (opts && opts.model) || defaultModel(), usageTokens(config.ai.provider, res.usage));
  } catch {}
  return res;
}

export function generateReply(systemPrompt, history, opts) {
  return impl().generateReply(systemPrompt, history, opts).then((r) => tally(opts, r));
}

export function generateWithTools(systemPrompt, contents, functionDeclarations, opts) {
  return impl().generateWithTools(systemPrompt, contents, functionDeclarations, opts).then((r) => tally(opts, r));
}

export const aiStats = {
  get running() {
    return config.ai.provider === "openai" ? openai.openaiStats.running : gemini.geminiStats.running;
  },
  get waiting() {
    return config.ai.provider === "openai" ? openai.openaiStats.waiting : gemini.geminiStats.waiting;
  },
};
