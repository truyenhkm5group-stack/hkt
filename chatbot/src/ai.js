import { config } from "./config.js";
import * as gemini from "./gemini.js";
import * as openai from "./openai.js";

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

export function generateReply(systemPrompt, history, opts) {
  return impl().generateReply(systemPrompt, history, opts);
}

export function generateWithTools(systemPrompt, contents, functionDeclarations, opts) {
  return impl().generateWithTools(systemPrompt, contents, functionDeclarations, opts);
}

export const aiStats = {
  get running() {
    return config.ai.provider === "openai" ? openai.openaiStats.running : gemini.geminiStats.running;
  },
  get waiting() {
    return config.ai.provider === "openai" ? openai.openaiStats.waiting : gemini.geminiStats.waiting;
  },
};
