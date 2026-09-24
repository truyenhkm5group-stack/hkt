import { config } from "./config.js";
import { log } from "./logger.js";
import { sleep } from "./util.js";

const BASE = "https://generativelanguage.googleapis.com/v1beta";

// Gioi han so request Gemini chay song song (GEMINI_MAX_CONCURRENT) de khong dinh 429 khi nhieu khach nhan cung luc
let running = 0;
const waiting = [];
async function withSlot(fn) {
  const max = config.gemini.maxConcurrent;
  if (running >= max) await new Promise((r) => waiting.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    const next = waiting.shift();
    if (next) next();
  }
}
export const geminiStats = { get running() { return running; }, get waiting() { return waiting.length; } };

function headers() {
  return { "Content-Type": "application/json", "x-goog-api-key": config.gemini.apiKey };
}

/** Danh sach model ma API key nay dung duoc */
export async function listModels() {
  const res = await fetch(`${BASE}/models?pageSize=100`, { headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Gemini listModels loi ${res.status}: ${JSON.stringify(data)}`);
  return (data.models || []).filter((m) =>
    (m.supportedGenerationMethods || []).includes("generateContent")
  );
}

/**
 * Sinh cau tra loi.
 * @param {string} systemPrompt
 * @param {{role:'user'|'model', text:string, images?:{mimeType:string,data:string}[]}[]} history
 *        theo thu tu thoi gian, tin cuoi la cua khach. `images` = anh base64 dinh kem (vision)
 * @returns {Promise<{text:string, finishReason:string, usage:object}>}
 */
export async function generateReply(systemPrompt, history, opts = {}) {
  const model = opts.model || config.gemini.model;

  // Gemini yeu cau luot dau la "user" va nen xen ke user/model -> gop cac luot cung vai
  const contents = [];
  for (const h of history) {
    const text = (h.text || "").trim();
    const images = Array.isArray(h.images) ? h.images.filter((i) => i?.data && i?.mimeType) : [];
    if (!text && images.length === 0) continue;
    const role = h.role === "model" ? "model" : "user";
    if (contents.length === 0 && role === "model") continue;

    const imgParts = images.map((img) => ({ inline_data: { mime_type: img.mimeType, data: img.data } }));
    const last = contents[contents.length - 1];
    if (last && last.role === role) {
      // Gop luot cung vai: anh chen truoc part text cuoi, text noi them dong moi
      const lastPart = last.parts[last.parts.length - 1];
      const hasText = typeof lastPart?.text === "string";
      last.parts.splice(last.parts.length - (hasText ? 1 : 0), 0, ...imgParts);
      if (text) {
        if (hasText) lastPart.text += "\n" + text;
        else last.parts.push({ text });
      }
    } else {
      contents.push({ role, parts: [...imgParts, ...(text ? [{ text }] : [])] });
    }
  }
  if (contents.length === 0) throw new Error("Khong co noi dung de gui Gemini");

  const think = opts.thinkingBudget ?? config.gemini.thinkingBudget;
  const askedMax = opts.maxOutputTokens ?? config.gemini.maxOutputTokens;
  const outMax = think > 0 ? askedMax + think : askedMax;

  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents,
    generationConfig: {
      temperature: opts.temperature ?? config.gemini.temperature,
      // QUAN TRONG: token "suy nghi" TRU VAO maxOutputTokens. Neu khong cong bu, cau tra loi bi cat cut
      // (finishReason MAX_TOKENS, text rong) - nang nhat la cac lenh tra JSON co cau truc voi maxOutputTokens nho.
      // Su co 2026-09-09: .env doi GEMINI_THINKING_BUDGET tu 0 -> 512, resolveAddress chi cho 300 token
      // -> model tieu het vao suy nghi, tra ve "{" -> moi don deu bao "khong xac dinh duoc tinh/thanh".
      maxOutputTokens: outMax,
      // thinkingBudget 0 = khong "suy nghi" -> tra loi nhanh hon 2-4 lan (chi ap dung model ho tro; -1 = de model tu quyet)
      ...(think >= 0 ? { thinkingConfig: { thinkingBudget: think } } : {}),
      // JSON co cau truc (trich xuat don hang, dia chi...)
      ...(opts.jsonSchema ? { responseMimeType: "application/json", responseSchema: opts.jsonSchema } : {}),
    },
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
    ],
  };

  const url = `${BASE}/models/${model}:generateContent`;
  let attempt = 0;
  for (;;) {
    attempt++;
    const res = await withSlot(() => fetch(url, { method: "POST", headers: headers(), body: JSON.stringify(body) }));
    const data = await res.json().catch(() => ({}));

    if ((res.status === 429 || res.status === 503 || res.status === 500) && attempt <= 4) {
      const backoff = Math.min(30000, 1000 * 2 ** attempt);
      log.warn(`Gemini ${res.status} (${data?.error?.message || ""}) -> thu lai sau ${backoff}ms`);
      await sleep(backoff);
      continue;
    }
    if (!res.ok) {
      throw new Error(`Gemini loi ${res.status}: ${data?.error?.message || JSON.stringify(data)}`);
    }

    const cand = data.candidates?.[0];
    const finishReason = cand?.finishReason || data.promptFeedback?.blockReason || "UNKNOWN";
    const text = (cand?.content?.parts || [])
      .map((p) => p.text || "")
      .join("")
      .trim();
    let json = null;
    if (opts.jsonSchema) {
      try {
        json = JSON.parse(text.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/, ""));
      } catch {
        json = null;
      }
    }
    return { text, json, finishReason, usage: data.usageMetadata || {} };
  }
}

/**
 * Goi Gemini voi function calling (cho tro ly quan tri).
 * @param {string} systemPrompt
 * @param {object[]} contents  - mang contents dung dinh dang Gemini (role user/model, parts text/functionCall/functionResponse)
 * @param {object[]} functionDeclarations
 * @returns {Promise<{parts: object[], finishReason: string, usage: object}>}
 */
export async function generateWithTools(systemPrompt, contents, functionDeclarations, opts = {}) {
  const model = opts.model || config.gemini.model;
  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents,
    tools: [{ function_declarations: functionDeclarations }],
    generationConfig: { temperature: opts.temperature ?? 0.2, maxOutputTokens: opts.maxOutputTokens ?? 2048 },
  };
  // toolMode: "AUTO" (mac dinh) | "NONE" (ep tra loi bang chu) | "ANY"
  if (opts.toolMode) body.tool_config = { function_calling_config: { mode: opts.toolMode } };
  const url = `${BASE}/models/${model}:generateContent`;
  let attempt = 0;
  for (;;) {
    attempt++;
    const res = await withSlot(() => fetch(url, { method: "POST", headers: headers(), body: JSON.stringify(body) }));
    const data = await res.json().catch(() => ({}));
    if ((res.status === 429 || res.status === 503 || res.status === 500) && attempt <= 4) {
      await sleep(Math.min(30000, 1000 * 2 ** attempt));
      continue;
    }
    if (!res.ok) throw new Error(`Gemini loi ${res.status}: ${data?.error?.message || JSON.stringify(data)}`);
    const cand = data.candidates?.[0];
    return { parts: cand?.content?.parts || [], finishReason: cand?.finishReason || data.promptFeedback?.blockReason || "UNKNOWN", usage: data.usageMetadata || {} };
  }
}
