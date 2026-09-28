import { AsyncLocalStorage } from "node:async_hooks";

/**
 * CHI PHI AI: dem token cua MOI lan goi AI (tra loi, nhan dien anh, trich xuat don, tro ly...) theo page / ngay /
 * model, roi quy ra tien bang bang gia sua duoc trong app. Chu shop hoi "moi don ton bao nhieu tien API".
 *
 * Ba luat:
 *  1. Model CHUA CO GIA thi luot goi do la CHUA BIET, KHONG phai 0d. Tong tien khi do la "it nhat" (partial = true)
 *     va app in ra so luot chua tinh duoc — doan gia cua model la ve ra mot con so trong co ve dung.
 *  2. Gia la GIA NIEM YET THAM KHAO (USD / 1 trieu token), khong phai hoa don. Sua duoc trong app khi nha cung cap
 *     doi gia; ty gia USD->VND cung sua duoc.
 *  3. "AI / don" = chi phi AI cua page trong ky / so don bot ghi vao POS trong ky. Tien cua nhung hoi thoai khong
 *     ra don van tinh vao — do chinh la gia de co mot don. Chua co don nao thi khong chia (null).
 */
export const aiScope = new AsyncLocalStorage();

/** Page cua luot goi AI hien tai (bot.processConversation dat vao), hoac "_khac" (tro ly, doi chieu don...). */
export function currentAiPage() {
  return aiScope.getStore()?.pageId || "_khac";
}

// USD / 1 trieu token. input = token vao khong duoc cache; cached = token vao doc tu cache; output = token ra (ke ca
// token "suy nghi" — Gemini tinh gia nhu token ra).
export const DEFAULT_AI_PRICES = {
  "gemini-2.5-flash-lite": { input: 0.1, cached: 0.025, output: 0.4 },
  "gemini-2.5-flash": { input: 0.3, cached: 0.075, output: 2.5 },
};
export const DEFAULT_USD_VND = 26000;

/** Tra gia theo TIEN TO DAI NHAT (API tra "gemini-2.5-flash-lite-preview-..."; "flash" khong duoc an vao "flash-lite"). */
export function priceFor(model, prices) {
  const m = String(model || "").toLowerCase();
  const keys = Object.keys(prices || {}).filter((k) => m === k.toLowerCase() || m.startsWith(k.toLowerCase()));
  if (!keys.length) return null;
  keys.sort((a, b) => b.length - a.length);
  const p = prices[keys[0]];
  return p && [p.input, p.cached, p.output].every((x) => Number.isFinite(Number(x))) ? p : null;
}

/** Token cua mot lan goi, theo hinh dang usage cua tung nha cung cap. */
export function usageTokens(provider, usage) {
  const u = usage || {};
  const prompt = Number(u.promptTokenCount || 0);
  if (provider === "openai") {
    const cached = Number(u.prompt_tokens_details?.cached_tokens || 0);
    // completion_tokens cua OpenAI DA gom reasoning -> khong cong them
    return { input: Math.max(0, prompt - cached), cached, output: Number(u.candidatesTokenCount || 0) };
  }
  const cached = Number(u.cachedContentTokenCount || 0);
  return {
    input: Math.max(0, prompt - cached),
    cached,
    output: Number(u.candidatesTokenCount || 0) + Number(u.thoughtsTokenCount || 0),
  };
}

export function costUsd(tokens, price) {
  return (tokens.input * Number(price.input) + tokens.cached * Number(price.cached) + tokens.output * Number(price.output)) / 1e6;
}

/**
 * Tong hop cho mot page (hoac ca shop). byDay = { "YYYY-MM-DD": { model: {calls,input,cached,output} } }.
 * days = danh sach ngay tinh vao. orders = so don ghi POS trong cung ky.
 */
export function summarizeAiCost(byDay, days, { prices, usdVnd, orders }) {
  const models = {};
  for (const d of days) {
    for (const [model, t] of Object.entries((byDay || {})[d] || {})) {
      const x = (models[model] ||= { calls: 0, input: 0, cached: 0, output: 0 });
      x.calls += t.calls || 0;
      x.input += t.input || 0;
      x.cached += t.cached || 0;
      x.output += t.output || 0;
    }
  }
  let usd = 0;
  let calls = 0;
  let unpricedCalls = 0;
  const unpricedModels = [];
  const perModel = [];
  for (const [model, t] of Object.entries(models)) {
    calls += t.calls;
    const p = priceFor(model, prices);
    const c = p ? costUsd(t, p) : null;
    if (c === null) {
      unpricedCalls += t.calls;
      unpricedModels.push(model);
    } else usd += c;
    perModel.push({ model, ...t, costVnd: c === null ? null : Math.round(c * usdVnd) });
  }
  perModel.sort((a, b) => b.calls - a.calls);
  const pricedAny = calls > unpricedCalls;
  const costVnd = pricedAny ? Math.round(usd * usdVnd) : calls ? null : 0;
  return {
    calls,
    costVnd,
    partial: unpricedCalls > 0 && pricedAny,
    unpricedCalls,
    unpricedModels,
    orders: orders || 0,
    perOrderVnd: costVnd !== null && orders > 0 ? Math.round(costVnd / orders) : null,
    perModel,
  };
}

/**
 * Token TU MOC DO tro di: bo ngay truoc moc, ngay cua moc thi tru phan da ghi truoc moc (baseline). Ham thuan.
 * Khong co moc (du lieu cu) => tra nguyen.
 */
export function meteredUsage(byDay, meter, baseline) {
  if (!meter?.day) return byDay || {};
  const out = {};
  for (const [d, models] of Object.entries(byDay || {})) {
    if (d < meter.day) continue;
    if (d !== meter.day || !baseline) {
      out[d] = models;
      continue;
    }
    out[d] = {};
    for (const [model, t] of Object.entries(models)) {
      const b = baseline[model] || {};
      const x = {
        calls: Math.max(0, (t.calls || 0) - (b.calls || 0)),
        input: Math.max(0, (t.input || 0) - (b.input || 0)),
        cached: Math.max(0, (t.cached || 0) - (b.cached || 0)),
        output: Math.max(0, (t.output || 0) - (b.output || 0)),
      };
      if (x.calls) out[d][model] = x;
    }
  }
  return out;
}

/** Chia tien cho SDT: chua co SDT nao thi KHONG chia (null), tien chua biet thi cung null. */
export function perSdt(costVnd, sdt) {
  return costVnd !== null && costVnd !== undefined && sdt > 0 ? Math.round(costVnd / sdt) : null;
}
