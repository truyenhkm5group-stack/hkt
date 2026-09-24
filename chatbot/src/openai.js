import { config } from "./config.js";
import { log } from "./logger.js";
import { sleep } from "./util.js";

/**
 * Goi OpenAI (ChatGPT) qua Chat Completions API, giu DUNG giao dien cua gemini.js
 * (generateReply / generateWithTools / listModels) de cac module khac khong phai sua.
 * Lich su, schema JSON va khai bao ham van viet theo kieu Gemini; file nay tu chuyen doi.
 */

// Gioi han so request chay song song (giong Gemini) de khong dinh 429
let running = 0;
const waiting = [];
async function withSlot(fn) {
  const max = config.openai.maxConcurrent;
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
export const openaiStats = { get running() { return running; }, get waiting() { return waiting.length; } };

function headers() {
  return { "Content-Type": "application/json", Authorization: `Bearer ${config.openai.apiKey}` };
}

/** Ten model Gemini (luu trong cai dat page cu) -> dung model OpenAI mac dinh */
export function resolveModel(name) {
  const n = String(name || "").trim();
  return /^(gpt|o\d|chatgpt|ft:)/i.test(n) ? n : config.openai.model;
}

/** Model "suy nghi" (gpt-5*, o1/o3/o4...): khong nhan temperature, dung reasoning_effort + max_completion_tokens */
function isReasoning(model) {
  return /^(gpt-5|o\d)/i.test(model) && !/chat-latest/i.test(model);
}

/** Muc "khong suy nghi": gpt-5 / gpt-5-mini chi nhan "minimal"; gpt-5.1 tro len nhan "none" (khong nhan "minimal") */
function noThinkEffort(model) {
  return /^gpt-5\.[1-9]/i.test(model) ? "none" : "minimal";
}

/** Schema kieu Gemini (type: "OBJECT"/"STRING"...) -> JSON Schema chuan */
export function toJsonSchema(s) {
  if (!s || typeof s !== "object") return s;
  if (Array.isArray(s)) return s.map(toJsonSchema);
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === "type" && typeof v === "string") out.type = v.toLowerCase();
    else if (k === "properties" && v && typeof v === "object") {
      out.properties = {};
      for (const [pk, pv] of Object.entries(v)) out.properties[pk] = toJsonSchema(pv);
    } else if (k === "items" || k === "anyOf" || k === "oneOf") out[k] = toJsonSchema(v);
    else if (k === "nullable") { if (v && out.type) out.type = [out.type, "null"]; }
    else out[k] = v;
  }
  if (out.type === "object" && out.additionalProperties === undefined) out.additionalProperties = false;
  return out;
}

function imgPart(img) {
  return { type: "image_url", image_url: { url: `data:${img.mimeType};base64,${img.data}` } };
}

function mapFinish(reason) {
  return { stop: "STOP", length: "MAX_TOKENS", content_filter: "SAFETY", tool_calls: "STOP" }[reason] || String(reason || "UNKNOWN").toUpperCase();
}

function mapUsage(u) {
  if (!u) return {};
  return {
    ...u,
    promptTokenCount: u.prompt_tokens,
    candidatesTokenCount: u.completion_tokens,
    totalTokenCount: u.total_tokens,
    thoughtsTokenCount: u.completion_tokens_details?.reasoning_tokens,
  };
}

async function callChat(body) {
  const url = `${config.openai.baseUrl}/chat/completions`;
  let attempt = 0;
  for (;;) {
    attempt++;
    const res = await withSlot(() => fetch(url, { method: "POST", headers: headers(), body: JSON.stringify(body) }));
    const data = await res.json().catch(() => ({}));
    if ((res.status === 429 || res.status >= 500) && attempt <= 4) {
      const backoff = Math.min(30000, 1000 * 2 ** attempt);
      log.warn(`OpenAI ${res.status} (${data?.error?.message || ""}) -> thu lai sau ${backoff}ms`);
      await sleep(backoff);
      continue;
    }
    if (!res.ok) throw new Error(`OpenAI loi ${res.status}: ${data?.error?.message || JSON.stringify(data)}`);
    return data;
  }
}

/** Danh sach model ma API key nay dung duoc (tra ve cung hinh dang voi Gemini: name/displayName) */
export async function listModels() {
  const res = await fetch(`${config.openai.baseUrl}/models`, { headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OpenAI listModels loi ${res.status}: ${JSON.stringify(data)}`);
  return (data.data || [])
    .map((m) => m.id)
    .filter((id) => /^(gpt-4o|gpt-4\.1|gpt-5|o\d|chatgpt-4o)/.test(id) && !/audio|realtime|transcribe|tts|search|image|embedding|moderation|instruct|codex|pro|deep-research|computer-use/.test(id))
    .sort()
    .map((id) => ({ name: id, displayName: id, supportedGenerationMethods: ["generateContent"] }));
}

/**
 * Sinh cau tra loi (giao dien giong gemini.generateReply).
 * @param {string} systemPrompt
 * @param {{role:'user'|'model', text:string, images?:{mimeType:string,data:string}[]}[]} history
 * @returns {Promise<{text:string, json:object|null, finishReason:string, usage:object}>}
 */
export async function generateReply(systemPrompt, history, opts = {}) {
  const model = resolveModel(opts.model);
  const messages = [{ role: "system", content: systemPrompt }];
  for (const h of history) {
    const text = (h.text || "").trim();
    const images = Array.isArray(h.images) ? h.images.filter((i) => i?.data && i?.mimeType) : [];
    if (!text && images.length === 0) continue;
    const role = h.role === "model" ? "assistant" : "user";
    if (messages.length === 1 && role === "assistant") continue; // luot dau phai la user
    if (role === "assistant" || images.length === 0) messages.push({ role, content: text });
    else messages.push({ role, content: [...images.map(imgPart), ...(text ? [{ type: "text", text }] : [])] });
  }
  if (messages.length === 1) throw new Error("Khong co noi dung de gui OpenAI");

  const think = opts.thinkingBudget; // undefined = theo OPENAI_REASONING; 0 = tat; >0 = low; -1 = medium
  const askedMax = opts.maxOutputTokens ?? config.gemini.maxOutputTokens;
  const reasoning = isReasoning(model);
  const body = { model, messages };
  if (reasoning) {
    // Token suy nghi TRU VAO max_completion_tokens -> cong bu nhu voi Gemini (khong thi JSON bi cat cut)
    body.max_completion_tokens = askedMax + 2048;
    // Test 2026-09-14: gpt-5.4-mini TAT suy nghi bam kich ban tot hon va nhanh hon (1.4s vs 2.0s) so voi "low"
    const mucCauHinh = config.openai.reasoning === "none" ? noThinkEffort(model) : config.openai.reasoning;
    body.reasoning_effort = think === undefined ? mucCauHinh : think === 0 ? noThinkEffort(model) : think > 0 && think <= 1024 ? "low" : "medium";
  } else {
    body.max_tokens = askedMax;
    body.temperature = opts.temperature ?? config.gemini.temperature;
  }
  if (opts.jsonSchema) {
    body.response_format = { type: "json_schema", json_schema: { name: "ket_qua", schema: toJsonSchema(opts.jsonSchema) } };
  }

  const data = await callChat(body);
  const choice = data.choices?.[0];
  const text = String(choice?.message?.content || "").trim();
  let json = null;
  if (opts.jsonSchema) {
    try {
      json = JSON.parse(text.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/, ""));
    } catch {
      json = null;
    }
  }
  return { text, json, finishReason: mapFinish(choice?.finish_reason), usage: mapUsage(data.usage) };
}

/** Khai bao ham kieu Gemini -> tools cua OpenAI */
function toTools(functionDeclarations) {
  return (functionDeclarations || []).map((f) => ({
    type: "function",
    function: { name: f.name, description: f.description, parameters: toJsonSchema(f.parameters || { type: "OBJECT", properties: {} }) },
  }));
}

/** contents kieu Gemini (parts text/inline_data/functionCall/functionResponse) -> messages cua OpenAI */
function toMessages(systemPrompt, contents) {
  const messages = [{ role: "system", content: systemPrompt }];
  const pendingIds = []; // id cac functionCall chua co functionResponse (khop theo thu tu khi thieu id)
  let seq = 0;
  for (const c of contents || []) {
    const parts = c.parts || [];
    if (c.role === "model") {
      const text = parts.filter((p) => typeof p.text === "string").map((p) => p.text).join("");
      const calls = parts.filter((p) => p.functionCall);
      const msg = { role: "assistant", content: text || (calls.length ? null : "") };
      if (calls.length) {
        msg.tool_calls = calls.map((p) => {
          const id = p.functionCall.id || `call_${++seq}_${p.functionCall.name}`;
          pendingIds.push({ id, name: p.functionCall.name });
          return { id, type: "function", function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args || {}) } };
        });
      }
      messages.push(msg);
      continue;
    }
    const responses = parts.filter((p) => p.functionResponse);
    if (responses.length) {
      for (const p of responses) {
        const fr = p.functionResponse;
        let id = fr.id;
        if (!id) {
          const i = pendingIds.findIndex((x) => x.name === fr.name);
          id = i >= 0 ? pendingIds.splice(i, 1)[0].id : `call_${fr.name}`;
        } else {
          const i = pendingIds.findIndex((x) => x.id === id);
          if (i >= 0) pendingIds.splice(i, 1);
        }
        messages.push({ role: "tool", tool_call_id: id, content: JSON.stringify(fr.response ?? {}) });
      }
      continue;
    }
    const text = parts.filter((p) => typeof p.text === "string").map((p) => p.text).join("\n");
    const imgs = parts.filter((p) => p.inline_data?.data).map((p) => imgPart({ mimeType: p.inline_data.mime_type, data: p.inline_data.data }));
    if (!text && !imgs.length) continue;
    messages.push({ role: "user", content: imgs.length ? [...imgs, ...(text ? [{ type: "text", text }] : [])] : text });
  }
  return messages;
}

/**
 * Goi OpenAI voi function calling (cho tro ly quan tri). Tra ve parts kieu Gemini
 * ({text} / {functionCall:{name,args,id}}) de assistant.js dung nguyen.
 */
export async function generateWithTools(systemPrompt, contents, functionDeclarations, opts = {}) {
  const model = resolveModel(opts.model);
  const body = { model, messages: toMessages(systemPrompt, contents), tools: toTools(functionDeclarations) };
  if (isReasoning(model)) {
    body.max_completion_tokens = (opts.maxOutputTokens ?? 2048) + 2048;
    // Chat Completions chi cho dung function tools khi KHONG suy nghi (gpt-5.4: "set reasoning_effort to 'none'")
    body.reasoning_effort = noThinkEffort(model);
  } else {
    body.max_tokens = opts.maxOutputTokens ?? 2048;
    body.temperature = opts.temperature ?? 0.2;
  }
  // toolMode: "AUTO" (mac dinh) | "NONE" (ep tra loi bang chu) | "ANY"
  if (opts.toolMode === "NONE") body.tool_choice = "none";
  else if (opts.toolMode === "ANY") body.tool_choice = "required";

  const data = await callChat(body);
  const choice = data.choices?.[0];
  const msg = choice?.message || {};
  const parts = [];
  if (msg.content && String(msg.content).trim()) parts.push({ text: String(msg.content) });
  for (const tc of msg.tool_calls || []) {
    let args = {};
    try {
      args = JSON.parse(tc.function?.arguments || "{}");
    } catch {
      args = {};
    }
    parts.push({ functionCall: { name: tc.function?.name, args, id: tc.id } });
  }
  return { parts, finishReason: mapFinish(choice?.finish_reason), usage: mapUsage(data.usage) };
}
