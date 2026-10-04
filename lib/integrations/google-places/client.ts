import type { DiscoveryTier, PlacesSku } from "@/lib/wholesale/config";

/**
 * ═══════════ GOOGLE PLACES API (NEW) — CLIENT THEO TỔ CHỨC ═══════════
 *
 * Kết nối «google-places» (lib/connectors/registry.ts): khoá API do TỪNG tổ chức khai ở
 * `/settings/connections`, mã hoá trong CSDL của chính tổ chức đó. Client này KHÔNG tự đọc khoá — người
 * gọi (lib/wholesale/engine.ts) mở kết nối bằng `openActiveConnection` rồi truyền khoá vào; nên không có
 * khoá nào của tổ chức nhà hay của tổ chức khác đi qua đây.
 *
 * Luật:
 *  · Khoá đi trong HEADER `X-Goog-Api-Key`, không bao giờ trong URL (URL lọt vào log máy chủ / proxy);
 *    mọi thông báo lỗi đi qua `scrub()` trước khi trả ra.
 *  · CHỈ gọi `places.googleapis.com` (hoặc trạm chuyển tiếp `https://….run.app` của chính tổ chức — xem
 *    `PLACES_RELAY_URL_PATTERN`), `redirect: "manual"`.
 *  · Field mask theo MỨC (`DiscoveryTier`) — chỉ xin đúng trường dùng tới, vì Google tính tiền theo
 *    trường đắt nhất trong mask (SKU). Mỗi kết quả trả kèm `sku` để người gọi ghi chi phí.
 *  · Thử lại có lùi dần (lũy thừa 2 + nhiễu) cho lỗi mạng, hết giờ, 429, 5xx. KHÔNG thử lại 4xx khác
 *    (khoá sai, API chưa bật, tham số sai) — thử lại chỉ đốt hạn mức.
 *  · Không ném: mọi lỗi thành `{ ok: false }` với `kind` để engine quyết định (tạm dừng chiến dịch khi
 *    khoá hỏng, ghi lỗi ô khi tham số sai).
 *
 * Tài liệu: https://developers.google.com/maps/documentation/places/web-service/op-overview
 */

export const PLACES_HOST = "https://places.googleapis.com";

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type PlacesClientDeps = {
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
};

/**
 * Trạm chuyển tiếp (deploy/places-relay, Cloud Run) — Google từ chối Places API (New) khi lời gọi đi ra từ IP Việt Nam (đo
 * 04/10/2026: 403 không kèm `reason`, cùng khoá chạy được từ Cloud Shell). Chỉ nhận địa chỉ `https://….run.app`: người
 * quản trị tổ chức gõ ô này, nên một URL tuỳ ý là cửa để máy chủ gửi khoá Google + mật khẩu trạm tới nơi khác (SSRF).
 */
export const PLACES_RELAY_URL_PATTERN = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.run\.app\/?$/;
export type PlacesRelay = { url: string; secret: string };

/** Trạm từ cấu hình kết nối: ô «Địa chỉ trạm» trống ⇒ `null` (gọi thẳng Google). Địa chỉ sai dạng vẫn trả về để lượt gọi báo INVALID. */
export function placesRelayOf(settings: Record<string, string | undefined>, secrets: Record<string, string | undefined>): PlacesRelay | null {
  const url = (settings.relayUrl ?? "").trim();
  return url ? { url, secret: (secrets.relaySecret ?? "").trim() } : null;
}

export type PlacesClientOptions = { apiKey: string; timeoutMs: number; maxRetries: number; relay?: PlacesRelay | null };

/** Một địa điểm đã đọc từ phản hồi — mọi trường ngoài `placeId` có thể thiếu tuỳ field mask. */
export type PlaceRecord = {
  placeId: string;
  name: string | null;
  address: string | null;
  types: string[];
  primaryType: string | null;
  businessStatus: string | null;
  lat: number | null;
  lng: number | null;
  mapsUrl: string | null;
  nationalPhone: string | null;
  internationalPhone: string | null;
  website: string | null;
  rating: number | null;
  reviewCount: number | null;
};

export type PlacesErrorKind = "AUTH" | "QUOTA" | "INVALID" | "NOT_FOUND" | "NETWORK" | "SERVER" | "UNKNOWN";

export type PlacesCallMeta = { sku: PlacesSku; httpStatus: number | null; durationMs: number; attempts: number; billable: boolean };

export type PlacesResult<T> = ({ ok: true } & T & { meta: PlacesCallMeta }) | { ok: false; kind: PlacesErrorKind; message: string; meta: PlacesCallMeta };

const PRO_FIELDS = ["id", "displayName", "formattedAddress", "types", "primaryType", "businessStatus", "location", "googleMapsUri"];
const ENTERPRISE_FIELDS = ["nationalPhoneNumber", "internationalPhoneNumber", "websiteUri", "rating", "userRatingCount"];

/** Field mask cho lượt TÌM theo mức. */
export function searchFieldMask(tier: DiscoveryTier): string {
  const fields = tier === "IDS_ONLY" ? ["id"] : tier === "PRO" ? PRO_FIELDS : [...PRO_FIELDS, ...ENTERPRISE_FIELDS];
  return [...fields.map((f) => `places.${f}`), "nextPageToken"].join(",");
}

/**
 * Field mask cho lượt CHI TIẾT. Đã có trường Pro từ lượt tìm ⇒ chỉ xin trường liên hệ (vẫn là SKU
 * Enterprise, nhưng payload nhỏ). `full` ⇒ xin cả trường Pro (sau lượt tìm chỉ-ID, hoặc làm mới).
 */
export function detailsFieldMask(full: boolean): string {
  const fields = full ? [...PRO_FIELDS, ...ENTERPRISE_FIELDS] : ["id", "businessStatus", "googleMapsUri", ...ENTERPRISE_FIELDS];
  return fields.join(",");
}

export function searchSku(mode: "TEXT" | "NEARBY", tier: DiscoveryTier): PlacesSku {
  if (mode === "NEARBY") return tier === "ENTERPRISE" ? "NEARBY_SEARCH_ENTERPRISE" : "NEARBY_SEARCH_PRO";
  return tier === "IDS_ONLY" ? "TEXT_SEARCH_IDS" : tier === "PRO" ? "TEXT_SEARCH_PRO" : "TEXT_SEARCH_ENTERPRISE";
}

function scrub(text: string, apiKey: string, extra?: string | null): string {
  let out = text;
  if (apiKey && apiKey.length >= 8) out = out.split(apiKey).join("••••");
  if (extra && extra.length >= 8) out = out.split(extra).join("••••");
  return out.replace(/AIza[0-9A-Za-z_-]{20,}/g, "••••").slice(0, 300);
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function parsePlace(raw: unknown): PlaceRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const placeId = asString(r.id);
  if (!placeId || !/^[A-Za-z0-9_-]{10,300}$/.test(placeId)) return null;
  const display = r.displayName && typeof r.displayName === "object" ? asString((r.displayName as Record<string, unknown>).text) : null;
  const loc = r.location && typeof r.location === "object" ? (r.location as Record<string, unknown>) : null;
  const reviewCount = asNumber(r.userRatingCount);
  return {
    placeId,
    name: display,
    address: asString(r.formattedAddress),
    types: Array.isArray(r.types) ? r.types.filter((t): t is string => typeof t === "string").slice(0, 30) : [],
    primaryType: asString(r.primaryType),
    businessStatus: asString(r.businessStatus),
    lat: loc ? asNumber(loc.latitude) : null,
    lng: loc ? asNumber(loc.longitude) : null,
    mapsUrl: asString(r.googleMapsUri),
    nationalPhone: asString(r.nationalPhoneNumber),
    internationalPhone: asString(r.internationalPhoneNumber),
    website: asString(r.websiteUri),
    rating: asNumber(r.rating),
    reviewCount: reviewCount == null ? null : Math.max(0, Math.round(reviewCount)),
  };
}

function classify(status: number, body: string): PlacesErrorKind {
  if (status === 401 || status === 403) return "AUTH";
  if (status === 429 || /RESOURCE_EXHAUSTED/.test(body)) return "QUOTA";
  if (status === 404) return "NOT_FOUND";
  if (status === 400) return "INVALID";
  if (status >= 500) return "SERVER";
  return "UNKNOWN";
}

/** Lý do máy đọc được trong `error.details[].reason` (ErrorInfo) — câu `message` của 403 thường chỉ là «The caller does not have permission». */
export function googleErrorReason(body: string): string | null {
  try {
    const j = JSON.parse(body) as { error?: { details?: unknown } };
    const details = Array.isArray(j.error?.details) ? (j.error.details as { reason?: unknown }[]) : [];
    return details.map((d) => d?.reason).find((x): x is string => typeof x === "string" && /^[A-Z0-9_]{3,80}$/.test(x)) ?? null;
  } catch {
    return null;
  }
}

function googleMessage(body: string): string {
  try {
    const j = JSON.parse(body) as { error?: { message?: unknown; status?: unknown } };
    const m = typeof j.error?.message === "string" ? j.error.message : "";
    const s = typeof j.error?.status === "string" ? j.error.status : "";
    const reason = googleErrorReason(body);
    return [[s, m].filter(Boolean).join(": "), reason ? `(reason: ${reason})` : ""].filter(Boolean).join(" ") || body.slice(0, 200);
  } catch {
    return body.slice(0, 200);
  }
}

async function readCapped(res: Response, max = 2_000_000): Promise<string> {
  const text = await res.text();
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * Một lượt gọi có thử lại. `billable` = Google đã trả 2xx (lượt bị tính tiền); lỗi không bị tính.
 */
async function call(
  opts: PlacesClientOptions,
  deps: PlacesClientDeps,
  sku: PlacesSku,
  request: { url: string; method: "GET" | "POST"; fieldMask: string; body?: unknown },
): Promise<{ ok: true; json: unknown; meta: PlacesCallMeta } | { ok: false; kind: PlacesErrorKind; message: string; meta: PlacesCallMeta }> {
  const fetchImpl = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = deps.random ?? Math.random;
  const now = deps.now ?? Date.now;
  const started = now();
  let attempts = 0;
  let lastStatus: number | null = null;
  let last: { kind: PlacesErrorKind; message: string } = { kind: "UNKNOWN", message: "chưa gọi" };
  if (!request.url.startsWith(`${PLACES_HOST}/`)) {
    return { ok: false, kind: "INVALID", message: "Chỉ gọi places.googleapis.com", meta: { sku, httpStatus: null, durationMs: 0, attempts: 0, billable: false } };
  }
  const relay = opts.relay ?? null;
  if (relay && (!PLACES_RELAY_URL_PATTERN.test(relay.url) || relay.secret.length < 16)) {
    return { ok: false, kind: "INVALID", message: "Địa chỉ trạm phải là https://….run.app và mật khẩu trạm ≥ 16 ký tự", meta: { sku, httpStatus: null, durationMs: 0, attempts: 0, billable: false } };
  }
  const target = relay ? `${relay.url.replace(/\/$/, "")}${request.url.slice(PLACES_HOST.length)}` : request.url;
  for (let i = 0; i <= opts.maxRetries; i++) {
    attempts++;
    try {
      const res = await fetchImpl(target, {
        method: request.method,
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": opts.apiKey,
          "X-Goog-FieldMask": request.fieldMask,
          ...(relay ? { "X-Relay-Secret": relay.secret } : {}),
        },
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        redirect: "manual",
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
      lastStatus = res.status;
      const text = await readCapped(res);
      if (res.status >= 200 && res.status < 300) {
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          return { ok: false, kind: "SERVER", message: "Phản hồi không phải JSON", meta: { sku, httpStatus: res.status, durationMs: now() - started, attempts, billable: true } };
        }
        return { ok: true, json, meta: { sku, httpStatus: res.status, durationMs: now() - started, attempts, billable: true } };
      }
      const kind = classify(res.status, text);
      last = { kind, message: scrub(`HTTP ${res.status} — ${relay && res.status === 401 ? "trạm từ chối mật khẩu" : googleMessage(text)}`, opts.apiKey, relay?.secret) };
      if (kind !== "QUOTA" && kind !== "SERVER") break; // 4xx khác: thử lại vô ích
    } catch (e) {
      lastStatus = null;
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      last = { kind: "NETWORK", message: scrub(msg, opts.apiKey, relay?.secret) };
    }
    if (i < opts.maxRetries) {
      const backoff = Math.min(30_000, 1000 * 2 ** i) + Math.floor(random() * 250);
      await sleep(backoff);
    }
  }
  return { ok: false, kind: last.kind, message: last.message, meta: { sku, httpStatus: lastStatus, durationMs: now() - started, attempts, billable: false } };
}

export type TextSearchInput = {
  textQuery: string;
  tier: DiscoveryTier;
  pageToken?: string | null;
  /** Thiên vị kết quả quanh một điểm (không phải giới hạn cứng). */
  bias?: { lat: number; lng: number; radiusM: number } | null;
};

export async function textSearch(opts: PlacesClientOptions, input: TextSearchInput, deps: PlacesClientDeps = {}): Promise<PlacesResult<{ places: PlaceRecord[]; nextPageToken: string | null }>> {
  const sku = searchSku("TEXT", input.tier);
  const body: Record<string, unknown> = { textQuery: input.textQuery, languageCode: "vi", regionCode: "VN", pageSize: 20 };
  if (input.pageToken) body.pageToken = input.pageToken;
  if (input.bias) body.locationBias = { circle: { center: { latitude: input.bias.lat, longitude: input.bias.lng }, radius: Math.min(50_000, Math.max(100, input.bias.radiusM)) } };
  const r = await call(opts, deps, sku, { url: `${PLACES_HOST}/v1/places:searchText`, method: "POST", fieldMask: searchFieldMask(input.tier), body });
  if (!r.ok) return r;
  const j = (r.json ?? {}) as { places?: unknown; nextPageToken?: unknown };
  const places = (Array.isArray(j.places) ? j.places : []).map(parsePlace).filter((p): p is PlaceRecord => p != null);
  return { ok: true, places, nextPageToken: asString(j.nextPageToken), meta: r.meta };
}

export type NearbySearchInput = { tier: DiscoveryTier; includedTypes: string[]; center: { lat: number; lng: number }; radiusM: number };

/** Nearby Search (New) KHÔNG nhận từ khoá — lọc bằng `includedTypes`, tối đa 20 kết quả, không phân trang. */
export async function nearbySearch(opts: PlacesClientOptions, input: NearbySearchInput, deps: PlacesClientDeps = {}): Promise<PlacesResult<{ places: PlaceRecord[] }>> {
  const tier: DiscoveryTier = input.tier === "IDS_ONLY" ? "PRO" : input.tier; // Nearby không có SKU chỉ-ID
  const sku = searchSku("NEARBY", tier);
  const body = {
    includedTypes: input.includedTypes.slice(0, 50),
    maxResultCount: 20,
    languageCode: "vi",
    regionCode: "VN",
    locationRestriction: { circle: { center: { latitude: input.center.lat, longitude: input.center.lng }, radius: Math.min(50_000, Math.max(100, input.radiusM)) } },
  };
  const mask = searchFieldMask(tier).replace(",nextPageToken", "");
  const r = await call(opts, deps, sku, { url: `${PLACES_HOST}/v1/places:searchNearby`, method: "POST", fieldMask: mask, body });
  if (!r.ok) return r;
  const j = (r.json ?? {}) as { places?: unknown };
  const places = (Array.isArray(j.places) ? j.places : []).map(parsePlace).filter((p): p is PlaceRecord => p != null);
  return { ok: true, places, meta: r.meta };
}

export async function placeDetails(opts: PlacesClientOptions, input: { placeId: string; full: boolean }, deps: PlacesClientDeps = {}): Promise<PlacesResult<{ place: PlaceRecord }>> {
  const sku: PlacesSku = "DETAILS_ENTERPRISE";
  if (!/^[A-Za-z0-9_-]{10,300}$/.test(input.placeId)) {
    return { ok: false, kind: "INVALID", message: "Place ID không hợp lệ", meta: { sku, httpStatus: null, durationMs: 0, attempts: 0, billable: false } };
  }
  const url = `${PLACES_HOST}/v1/places/${encodeURIComponent(input.placeId)}?languageCode=vi&regionCode=VN`;
  const r = await call(opts, deps, sku, { url, method: "GET", fieldMask: detailsFieldMask(input.full) });
  if (!r.ok) return r;
  const place = parsePlace(r.json);
  if (!place) return { ok: false, kind: "SERVER", message: "Phản hồi chi tiết thiếu Place ID", meta: r.meta };
  return { ok: true, place, meta: r.meta };
}

/**
 * Khoá API Google: chỉ chặn thứ CHẮC CHẮN không phải khoá (khoảng trắng, ngoặc, «=»…) — cùng luật với khoá Gemini
 * (lib/connectors/testers.ts, 02/10/2026: khoá Google cấp không còn chỉ dạng «AIza» + 35 ký tự). Đúng hay sai do
 * Google trả lời. Bộ ký tự đóng nên khoá không chèn được gì vào header.
 */
export const GOOGLE_API_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{29,199}$/;
