/**
 * Dò endpoint Pancake Pages public API với PANCAKE_ACCESS_TOKEN: in mã HTTP + đoạn đầu phản hồi (không in token).
 *   npx tsx scripts/pages-debug.ts
 *
 * Phần 2 (26/09/2026): in HÌNH DẠNG hội thoại và tin nhắn — tên trường, và GIÁ TRỊ chỉ khi giá trị là
 * đúng/sai, số hoặc mốc thời gian. Câu hỏi cần trả lời: API có trường nào nói "khách đã xem tin của
 * trang" không (giao diện Pancake hiện "đã xem · <giờ>"). KHÔNG in tên, SĐT, nội dung tin — kho PUBLIC.
 */
import "dotenv/config";
import { env } from "@/lib/env";
import { getPancakePagesClient } from "@/lib/integrations/pancake/pages";

const token = env.pancake.pagesAccessToken;
const baseUrl = env.pancake.pagesBaseUrl;
const variants: { name: string; url: string; method?: string; headers?: Record<string, string> }[] = [
  { name: "public_api/v1/pages (accept json)", url: `https://pages.fm/api/public_api/v1/pages?access_token=${token}`, headers: { accept: "application/json" } },
  { name: "public_api/v1/pages (no accept)", url: `https://pages.fm/api/public_api/v1/pages?access_token=${token}` },
  { name: "public_api/v1/pages (accept */*)", url: `https://pages.fm/api/public_api/v1/pages?access_token=${token}`, headers: { accept: "*/*", "user-agent": "Mozilla/5.0" } },
  { name: "api/v1/pages", url: `https://pages.fm/api/v1/pages?access_token=${token}`, headers: { accept: "*/*" } },
  { name: "pancake.vn public_api/v1/pages", url: `https://pancake.vn/api/public_api/v1/pages?access_token=${token}`, headers: { accept: "*/*" } },
  { name: "public_api/v1/pages POST", url: `https://pages.fm/api/public_api/v1/pages?access_token=${token}`, method: "POST", headers: { accept: "*/*" } },
  { name: "pages.fm/api/v1/pages (header token)", url: `https://pages.fm/api/v1/pages`, headers: { accept: "*/*", authorization: `Bearer ${token}` } },
];

/** Token trang sinh ra trong lượt dò — che cùng token người dùng nếu lọt vào câu lỗi. */
let pageTokenForMask = "";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** Tên trường + giá trị AN TOÀN (đúng/sai · số · mốc thời gian · null). Chuỗi khác chỉ in độ dài. */
function shape(obj: unknown, depth = 0): string[] {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return [];
  const out: string[] = [];
  for (const k of Object.keys(obj as Record<string, unknown>).sort()) {
    const v = (obj as Record<string, unknown>)[k];
    const pad = "  ".repeat(depth + 2);
    if (v === null) out.push(`${pad}${k}: null`);
    else if (typeof v === "boolean") out.push(`${pad}${k}: ${v}`);
    // Số lớn có thể là ID Facebook của khách: chỉ in số nhỏ hoặc số có dạng mốc thời gian (giây / mili giây).
    else if (typeof v === "number") out.push(`${pad}${k}: ${Math.abs(v) < 1e6 || (v >= 1e9 && v <= 2e10) || (v >= 1e12 && v <= 2e13) ? v : `số(${String(v).length} chữ số)`}`);
    else if (typeof v === "string") out.push(`${pad}${k}: ${ISO.test(v) ? v : `chuỗi(${v.length})`}`);
    else if (Array.isArray(v)) out.push(`${pad}${k}: mảng[${v.length}]`);
    else {
      out.push(`${pad}${k}: {…}`);
      if (depth < 1) out.push(...shape(v, depth + 1));
    }
  }
  return out;
}

async function getJson(url: string) {
  const res = await fetch(url, { headers: { accept: "*/*" }, signal: AbortSignal.timeout(20_000) });
  return (await res.json()) as Record<string, unknown>;
}

async function probeShape() {
  // Dùng đúng client đang chạy trên production cho phần liệt kê page / token — lượt dò đầu tự đọc phản hồi
  // và lấy nhầm trường ID nên không ra page nào.
  const client = getPancakePagesClient();
  const pages = await client.listPages();
  console.log(`\nSố page: ${pages.length}`);
  if (!pages.length) return console.log("Không có page nào để dò hình dạng hội thoại.");
  const now = Math.floor(Date.now() / 1000);
  // Page đầu có thể im 24 giờ — thử lần lượt tới page đầu tiên có hội thoại.
  let pageId = "";
  let tk = "";
  let conv: Record<string, unknown> = {};
  let list: Record<string, unknown>[] = [];
  for (const [i, p] of pages.slice(0, 10).entries()) {
    const pt = await client.pageToken(p.id);
    pageTokenForMask = pt.value;
    tk = `${pt.key}=${pt.value}`;
    pageId = p.id;
    conv = await getJson(`${baseUrl}/pages/${pageId}/conversations?${tk}&since=${now - 86_400}&until=${now}&page_number=1&page_size=5&order_by=updated_at`);
    list = ((conv.conversations as unknown[]) ?? []) as Record<string, unknown>[];
    if (list.length) {
      console.log(`Page thứ ${i + 1} có hội thoại.`);
      break;
    }
  }
  console.log(`\n── Hình dạng hội thoại (${list.length} hội thoại 24 giờ) ──`);
  console.log("  Trường cấp ngoài của phản hồi:", Object.keys(conv).sort().join(", "));
  if (!list.length) return;
  console.log(shape(list[0]).join("\n"));
  const convId = String(list[0].id ?? "");
  const cust = ((list[0].customers as unknown[]) ?? [])[0] as Record<string, unknown> | undefined;
  const msgs = await getJson(`${baseUrl}/pages/${pageId}/conversations/${convId}/messages?${tk}&customer_id=${String(cust?.id ?? "")}&current_count=0&page_size=5`);
  console.log(`\n── Hình dạng phản hồi tin nhắn ──`);
  console.log(shape(msgs).join("\n"));
  const first = (((msgs.messages as unknown[]) ?? [])[0] ?? null) as Record<string, unknown> | null;
  if (first) {
    console.log(`\n── Hình dạng một tin nhắn ──`);
    console.log(shape(first).join("\n"));
  }
  const seenKeys = [...Object.keys(list[0]), ...Object.keys(msgs), ...(first ? Object.keys(first) : [])].filter((k) => /seen|read|watermark/i.test(k));
  console.log(`\nTrường có chữ seen/read/watermark: ${seenKeys.length ? [...new Set(seenKeys)].join(", ") : "KHÔNG CÓ"}`);
}

async function main() {
  if (!token) throw new Error("Chưa có PANCAKE_ACCESS_TOKEN");
  console.log(`Token dài ${token.length} ký tự`);
  for (const v of variants) {
    try {
      const res = await fetch(v.url, { method: v.method ?? "GET", headers: v.headers, signal: AbortSignal.timeout(20_000) });
      const text = (await res.text()).replace(new RegExp(token, "g"), "***");
      console.log(`- ${v.name}: HTTP ${res.status} · ${text.slice(0, 220).replace(/\s+/g, " ")}`);
    } catch (e) {
      console.log(`- ${v.name}: lỗi ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  try {
    await probeShape();
  } catch (e) {
    let msg = (e instanceof Error ? e.message : String(e)).replace(new RegExp(token, "g"), "***");
    if (pageTokenForMask) msg = msg.split(pageTokenForMask).join("***");
    console.log(`Dò hình dạng lỗi: ${msg}`);
  }
}
main().then(() => process.exit(0));
