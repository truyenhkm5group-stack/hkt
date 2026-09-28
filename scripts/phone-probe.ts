/**
 * Dò xem API Pancake có trả lịch sử mua hàng theo SĐT trên toàn hệ thống (số GTC / hoàn như Pancake hiển thị cạnh SĐT) không.
 * In mã HTTP + các khoá / đoạn đầu phản hồi, KHÔNG in api_key / token.
 *   npx tsx scripts/phone-probe.ts 0788281828
 *   npx tsx scripts/phone-probe.ts order:4063     ← lấy SĐT từ chính đơn đó trên Pancake (SĐT không đi qua ô "arg")
 *
 * 28/09/2026: web POS hiện cột "Tỷ lệ hoàn" (reports_by_phone → order_fail / (order_success + order_fail))
 * và "Cảnh báo SĐT" (total_warning · warning_phone_numbers) — đọc từ mã web POS. Đường POS gọi cho
 * một SĐT là `orders/bad_report_info?phone_number=`. Phần "POS thật" bên dưới hỏi đúng các đường đó.
 */
import "dotenv/config";
import { env } from "@/lib/env";

const arg = (process.argv[2] ?? "").trim();
const orderArg = arg.startsWith("order:") ? arg.slice(6).trim() : "";
let phone = orderArg ? "" : arg.replace(/\D/g, "");
const key = env.pancake.apiKey;
const shop = env.pancake.shopId;
const base = env.pancake.baseUrl.replace(/\/$/, "");
const token = env.pancake.pagesAccessToken;

const mask = (t: string) => t.replace(new RegExp(key, "g"), "***").replace(token ? new RegExp(token, "g") : /$^/, "***");

async function probe(name: string, url: string) {
  try {
    const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    const text = mask(await res.text());
    let keys = "";
    try {
      const j = JSON.parse(text) as Record<string, unknown>;
      const first = Array.isArray(j.data) ? (j.data[0] as Record<string, unknown> | undefined) : Array.isArray(j.customers) ? (j.customers[0] as Record<string, unknown> | undefined) : null;
      keys = `keys=${Object.keys(j).join(",")}${first ? ` · item=${Object.keys(first).join(",")}` : ""}`;
    } catch {
      keys = "";
    }
    console.log(`- ${name}: HTTP ${res.status} · ${keys || text.slice(0, 200).replace(/\s+/g, " ")}`);
    const hit = /(succeed|success|returned|return_count|bomb|warning|black|reputation|history|total_order|delivered)/i.exec(text);
    if (hit && res.ok) console.log(`    → có từ khoá "${hit[1]}": ${text.slice(Math.max(0, (hit.index ?? 0) - 120), (hit.index ?? 0) + 200).replace(/\s+/g, " ")}`);
  } catch (e) {
    console.log(`- ${name}: lỗi ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Các khoá liên quan tới lịch sử SĐT có mặt trong một bản ghi đơn — để biết đường nào trả chúng. */
const REPORT_KEYS = ["reports_by_phone", "total_warning", "warning_phone_numbers", "bad_report_info"];
function reportKeys(o: unknown): string {
  if (!o || typeof o !== "object") return "(không phải object)";
  const r = o as Record<string, unknown>;
  return REPORT_KEYS.map((k) => `${k}=${k in r ? JSON.stringify(r[k]).slice(0, 300) : "∅"}`).join(" · ");
}

async function getJson(url: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: mask(text).slice(0, 200) };
  }
}

async function posThat(q: string) {
  console.log("── POS thật: các đường web POS dùng cho Tỷ lệ hoàn / Cảnh báo SĐT ──");
  const bad = await getJson(`${base}/shops/${shop}/orders/bad_report_info?${q}&phone_number=${phone}`);
  console.log(`- orders/bad_report_info: HTTP ${bad.status} · ${mask(JSON.stringify(bad.body)).slice(0, 1500)}`);
  if (orderArg) {
    const one = await getJson(`${base}/shops/${shop}/orders/${encodeURIComponent(orderArg)}?${q}`);
    const d = (one.body as { data?: unknown })?.data;
    console.log(`- orders/<id>: HTTP ${one.status} · ${reportKeys(d)}`);
  }
  const list = await getJson(`${base}/shops/${shop}/orders?${q}&page_size=1&search=${phone}`);
  console.log(`- orders?search: HTTP ${list.status} · ${reportKeys((list.body as { data?: unknown[] })?.data?.[0])}`);
  for (const f of ["reports_by_phone,total_warning,warning_phone_numbers", "reports_by_phone"]) {
    const lf = await getJson(`${base}/shops/${shop}/orders?${q}&page_size=1&search=${phone}&fields=${encodeURIComponent(f)}`);
    console.log(`- orders?search&fields=${f}: HTTP ${lf.status} · ${reportKeys((lf.body as { data?: unknown[] })?.data?.[0])}`);
  }
}

async function main() {
  if (!key) throw new Error("Chưa có PANCAKE_API_KEY");
  const q = `api_key=${key}`;
  if (orderArg) {
    const o = await getJson(`${base}/shops/${shop}/orders/${encodeURIComponent(orderArg)}?${q}`);
    const d = ((o.body as { data?: Record<string, unknown> })?.data ?? {}) as Record<string, unknown>;
    phone = String(d.bill_phone_number ?? (d.shipping_address as Record<string, unknown> | undefined)?.phone_number ?? "").replace(/\D/g, "");
    console.log(`đơn ${orderArg}: HTTP ${o.status} · ${phone ? `SĐT ${phone.length} chữ số (không in)` : "KHÔNG đọc được SĐT"}`);
  }
  if (!phone) throw new Error("Nhập SĐT hoặc order:<mã đơn>: npx tsx scripts/phone-probe.ts 09xxxxxxxx");
  await posThat(q);
  console.log("── Các đường đoán tên (lượt dò cũ) ──");
  const c = [
    ["customers?search", `${base}/shops/${shop}/customers?${q}&page_size=2&search=${phone}`],
    ["customers?phone_number", `${base}/shops/${shop}/customers?${q}&page_size=2&phone_number=${phone}`],
    ["customers/check_phone", `${base}/shops/${shop}/customers/check_phone?${q}&phone_number=${phone}`],
    ["customers/phone_info", `${base}/shops/${shop}/customers/phone_info?${q}&phone_number=${phone}`],
    ["customers/phone/<sđt>", `${base}/shops/${shop}/customers/phone/${phone}?${q}`],
    ["customers/<sđt>", `${base}/shops/${shop}/customers/${phone}?${q}`],
    ["customers/<sđt>/statistics", `${base}/shops/${shop}/customers/${phone}/statistics?${q}`],
    ["customers/<sđt>/orders", `${base}/shops/${shop}/customers/${phone}/orders?${q}`],
    ["orders?search (shop)", `${base}/shops/${shop}/orders?${q}&page_size=1&search=${phone}`],
    ["orders/check_phone", `${base}/shops/${shop}/orders/check_phone?${q}&phone_number=${phone}`],
    ["phone_numbers/<sđt>", `${base}/shops/${shop}/phone_numbers/${phone}?${q}`],
    ["check_phone (root)", `${base}/check_phone?${q}&phone_number=${phone}&shop_id=${shop}`],
    ["customers/stats", `${base}/shops/${shop}/customers/stats?${q}&phone_number=${phone}`],
    ["customer_histories", `${base}/shops/${shop}/customer_histories?${q}&phone_number=${phone}`],
    ["blacklist", `${base}/shops/${shop}/blacklist?${q}&phone_number=${phone}`],
  ] as const;
  for (const [name, url] of c) await probe(name, url);
  if (token) {
    console.log("Pages API (chat):");
    await probe("pages", `https://pages.fm/api/public_api/v1/pages?access_token=${token}`);
    await probe("conversations?search phone (page đầu)", `https://pages.fm/api/public_api/v1/pages?access_token=${token}`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
