/**
 * TRẠM CHUYỂN TIẾP GOOGLE PLACES CHO ERP — Cloud Run (04/10/2026).
 *
 * Vì sao: Google trả HTTP 403 «The caller does not have permission» (KHÔNG kèm `reason`) cho MỌI lời gọi Places API (New)
 * đi ra từ IP Việt Nam, kể cả với khoá đúng: đo 04/10/2026 — cùng khoá, cùng yêu cầu: Cloud Shell trả 20 Place ID, máy
 * chủ ERP (VNPT TP.HCM) và máy văn phòng (VNPT) đều 403; khoá sai cố ý thì 400 API_KEY_INVALID (tức Google NHẬN ra khoá
 * rồi mới từ chối nơi gửi). Trạm này chạy trên Cloud Run vùng Singapore, trong CHÍNH dự án Google Cloud của tổ chức.
 *
 * Trạm KHÔNG giữ khoá Google: khoá đi theo từng yêu cầu của ERP trong tiêu đề `X-Goog-Api-Key`, như khi gọi thẳng. Trạm chỉ
 * giữ MẬT KHẨU TRẠM (`RELAY_SECRET`) — thiếu / sai mật khẩu ⇒ 401, nên URL lộ ra cũng không ai dùng ké được. Chỉ chuyển
 * tiếp ba lời gọi ERP dùng (searchText · searchNearby · chi tiết một địa điểm) tới places.googleapis.com, không theo
 * chuyển hướng, không ghi log nội dung hay tiêu đề.
 *
 * Tệp này là LOGIC (thuần, nhận `fetchImpl`); `server.js` mở cổng HTTP. Bài kiểm: tests/wholesale-lead-hunter.test.ts.
 */
import { timingSafeEqual } from "node:crypto";

export const UPSTREAM = "https://places.googleapis.com";
export const MAX_BODY = 64 * 1024;

const ROUTES = [
  ["POST", /^\/v1\/places:searchText$/],
  ["POST", /^\/v1\/places:searchNearby$/],
  ["GET", /^\/v1\/places\/[A-Za-z0-9_-]{10,300}$/],
];

/** Đường dẫn + phương thức có nằm trong ba lời gọi được phép không. */
export function allowed(method, path) {
  return ROUTES.some(([m, re]) => m === method && re.test(path));
}

/** So mật khẩu trạm không lộ thời gian; mật khẩu cấu hình dưới 16 ký tự ⇒ coi như chưa cấu hình, từ chối mọi yêu cầu. */
export function secretOk(given, secret) {
  if (typeof secret !== "string" || secret.length < 16) return false;
  const a = Buffer.from(typeof given === "string" ? given : "");
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Xử lý một yêu cầu đã đọc xong. `req` = { method, url (đường dẫn + query), headers (chữ thường), body (chuỗi) }.
 * Trả { status, contentType, body }.
 */
export async function handle(req, { secret, fetchImpl, timeoutMs = 20_000 }) {
  const text = (status, body) => ({ status, contentType: "text/plain; charset=utf-8", body });
  const u = new URL(req.url, "http://relay.local");
  if (req.method === "GET" && u.pathname === "/healthz") return text(200, "ok");
  if (!secretOk(req.headers["x-relay-secret"], secret)) return text(401, "relay: sai hoặc thiếu mật khẩu trạm");
  if (!allowed(req.method, u.pathname)) return text(404, "relay: đường dẫn không được phép");
  if ((req.body ?? "").length > MAX_BODY) return text(413, "relay: thân yêu cầu quá lớn");
  const headers = { "Content-Type": "application/json" };
  for (const [k, name] of [["x-goog-api-key", "X-Goog-Api-Key"], ["x-goog-fieldmask", "X-Goog-FieldMask"]]) {
    if (typeof req.headers[k] === "string") headers[name] = req.headers[k];
  }
  try {
    const res = await fetchImpl(`${UPSTREAM}${u.pathname}${u.search}`, {
      method: req.method,
      headers,
      body: req.method === "POST" ? req.body : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: res.status, contentType: res.headers.get("content-type") || "application/json", body: await res.text() };
  } catch (e) {
    return text(502, `relay: không gọi được Google (${e instanceof Error ? e.name : "lỗi"})`);
  }
}
