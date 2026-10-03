import { config } from "./config.js";
import * as gemini from "./gemini.js";
import * as openai from "./openai.js";
import { currentAiPage, currentAiConversation, usageTokens } from "./aicost.js";
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
function tally(opts, res, provider = config.ai.provider) {
  try {
    if (res && res.usage) {
      const model = (opts && opts.model) || (provider === "gemini" ? config.gemini.model : defaultModel());
      const t = usageTokens(provider, res.usage);
      store.addAiUsage(currentAiPage(), model, t);
      store.addConvAiUsage(currentAiPage(), currentAiConversation(), model, t);
    }
  } catch {}
  return res;
}

export function generateReply(systemPrompt, history, opts) {
  return impl().generateReply(systemPrompt, history, opts).then((r) => tally(opts, r));
}

/**
 * Goi THANG Gemini, bat ke AI_PROVIDER — cho viec chi Gemini lam duoc (nghe ghi am). Token van vao so chi phi AI
 * cua page/hoi thoai nhu moi lan goi khac.
 */
export function generateReplyGemini(systemPrompt, history, opts) {
  return gemini.generateReply(systemPrompt, history, opts).then((r) => tally(opts, r, "gemini"));
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
