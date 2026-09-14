/**
 * KIỂM TRA QUYỀN ĐỌC PANCAKE — CHỈ GỌI GET, KHÔNG MỘT LỜI GỌI GHI NÀO.
 *
 *   npx tsx scripts/pancake-read-test.ts --page=<PAGE_ID> [--hours=24]
 *
 * Trả lời đúng bốn câu, bằng dữ liệu thật chứ không bằng cấu hình:
 *   1. Token có dùng được không?
 *   2. Page có truy cập được không, TÊN là gì?
 *   3. Đọc được hội thoại không?
 *   4. Đọc được tin nhắn không?
 *
 * VÌ SAO TỰ GỌI `fetch` THAY VÌ DÙNG `PancakePagesClient`: client gọi `pageToken()`, và hàm ấy
 * POST tới `generate_page_access_token` khi chưa có page token. Đó là một lời gọi GHI (nó sinh ra
 * một chứng thư mới). Bài kiểm "chỉ đọc" mà tự sinh token thì không còn là bài kiểm chỉ đọc.
 *
 * Token KHÔNG BAO GIỜ được in. Nội dung tin nhắn của khách bị CHE — kho mã này PUBLIC và ảnh chụp
 * màn hình hay được dán sang chỗ khác.
 */
import "dotenv/config";
import { env } from "@/lib/env";

function arg(name: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : "";
}

/** Che nội dung: giữ độ dài và ba ký tự đầu, đủ để nhận ra kiểu dữ liệu mà không lộ câu chữ. */
function mask(value: unknown): string {
  if (typeof value !== "string") return String(value);
  return value.length <= 3 ? value : `${value.slice(0, 3)}…(${value.length} ký tự)`;
}

const BASE = env.pancake.pagesBaseUrl;

async function get(path: string, params: Record<string, string | number>): Promise<{ status: number; body: Record<string, unknown> }> {
  const url = new URL(`${BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  // `url` không bao giờ được in ra: nó chứa token ở query string.
  const res = await fetch(url, { method: "GET", headers: { accept: "*/*" } });
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: res.status, body };
}

function arr(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value.filter((v) => v && typeof v === "object") as Record<string, unknown>[]) : [];
}

async function main() {
  const pageId = arg("page") || env.pancake.pageId;
  const hours = Number(arg("hours")) || 24;

  // Ưu tiên token của CHÍNH page (phạm vi hẹp hơn); không có thì dùng token người dùng.
  const pageToken = env.pancake.pageAccessToken;
  const userToken = env.pancake.pagesAccessToken;
  const key = pageToken ? "page_access_token" : "access_token";
  const token = pageToken || userToken;

  console.log("───────── CHỨNG THƯ ĐANG DÙNG ─────────");
  console.log(`  Loại               : ${pageToken ? "token của MỘT page (phạm vi hẹp)" : "token người dùng (mở mọi page)"}`);
  console.log(`  Độ dài             : ${token ? token.length : 0} ký tự`);
  console.log(`  Page cần đọc       : ${pageId || "(chưa khai)"}`);
  if (!token) {
    console.error("\n✗ DỪNG: chưa có PANCAKE_PAGE_ACCESS_TOKEN lẫn PANCAKE_ACCESS_TOKEN.");
    process.exit(1);
  }
  if (!pageId) {
    console.error("\n✗ DỪNG: chưa khai PANCAKE_PAGE_ID.");
    process.exit(1);
  }

  // ── 1. PAGE CÓ TRUY CẬP ĐƯỢC KHÔNG, TÊN GÌ ──
  // Chỉ hỏi được khi cầm token người dùng; token của một page không liệt kê page nào.
  console.log("\n───────── 1. PAGE ─────────");
  let pageName = "";
  if (userToken) {
    const { status, body } = await get("pages", { access_token: userToken });
    if (status >= 400) {
      console.error(`  ✗ GET /pages trả HTTP ${status} — token người dùng không dùng được.`);
      process.exit(1);
    }
    const categorized = (body.categorized ?? {}) as Record<string, unknown>;
    const pages = [...arr(categorized.activated), ...arr(body.pages), ...arr(body.data)];
    const found = pages.find((p) => String(p.id) === pageId);
    console.log(`  Tài khoản thấy     : ${pages.length} page`);
    if (!found) {
      console.error(`  ✗ Page ${pageId} KHÔNG nằm trong danh sách page của tài khoản này.`);
      console.error("    Kiểm lại mã page, hoặc token thuộc một tài khoản khác.");
      process.exit(1);
    }
    pageName = String(found.name ?? "");
    console.log(`  ✓ Tìm thấy page    : ${pageId}`);
    console.log(`    Tên              : ${pageName || "(Pancake không trả tên)"}`);
    console.log(`    Nền tảng         : ${String(found.platform ?? "(không khai)")}`);
  } else {
    console.log("  (chỉ có token của một page — không liệt kê được page, sẽ kiểm bằng đường đọc hội thoại)");
  }

  // ── 2. ĐỌC HỘI THOẠI ──
  console.log("\n───────── 2. HỘI THOẠI ─────────");
  const until = Math.floor(Date.now() / 1000);
  const since = until - hours * 3600;
  const conv = await get(`pages/${pageId}/conversations`, {
    [key]: token,
    since,
    until,
    page_number: 1,
    page_size: 20,
    order_by: "updated_at",
  });
  if (conv.status >= 400) {
    console.error(`  ✗ HTTP ${conv.status} — không đọc được hội thoại của page này.`);
    const why = conv.body.message ?? conv.body.error ?? conv.body.reason;
    if (why) console.error(`    Pancake nói: ${String(why)}`);
    process.exit(1);
  }
  const conversations = arr(conv.body.conversations ?? (conv.body.data as Record<string, unknown>)?.conversations ?? conv.body.data);
  console.log(`  ✓ Đọc được         : ${conversations.length} hội thoại trong ${hours} giờ qua`);
  for (const c of conversations.slice(0, 5)) {
    const customer = arr(c.customers)[0] ?? {};
    console.log(`    ${String(c.id)} · khách ${mask(String(customer.name ?? ""))} · cập nhật ${String(c.updated_at ?? "?")}`);
  }
  if (!conversations.length) {
    console.log("\n  ⚠ Không có hội thoại nào trong cửa sổ này. Quyền đọc VẪN đạt (API trả 200),");
    console.log("    nhưng lượt nạp sẽ không có gì để nạp — nới cửa sổ thời gian hoặc chọn page khác.");
    process.exit(0);
  }

  // ── 3. ĐỌC TIN NHẮN ──
  console.log("\n───────── 3. TIN NHẮN ─────────");
  const first = conversations[0];
  const customerId = String(arr(first.customers)[0]?.id ?? (first.customer as Record<string, unknown>)?.id ?? "");
  const msg = await get(`pages/${pageId}/conversations/${String(first.id)}/messages`, {
    [key]: token,
    customer_id: customerId,
    page_number: 1,
    page_size: 10,
  });
  if (msg.status >= 400) {
    console.error(`  ✗ HTTP ${msg.status} — đọc được hội thoại nhưng KHÔNG đọc được tin nhắn.`);
    const why = msg.body.message ?? msg.body.error ?? msg.body.reason;
    if (why) console.error(`    Pancake nói: ${String(why)}`);
    process.exit(1);
  }
  const messages = arr(msg.body.messages ?? (msg.body.data as Record<string, unknown>)?.messages ?? msg.body.data);
  console.log(`  ✓ Đọc được         : ${messages.length} tin trong hội thoại ${String(first.id)}`);
  for (const m of messages.slice(0, 5)) {
    const from = (m.from ?? {}) as Record<string, unknown>;
    const fromPage = String(from.id ?? "") === pageId;
    console.log(`    ${fromPage ? "SHOP " : "KHÁCH"} · ${String(m.inserted_at ?? "?")} · ${mask(String(m.message ?? ""))}`);
  }

  console.log("\n───────── KẾT LUẬN ─────────");
  console.log(`  Page ${pageId}${pageName ? ` (${pageName})` : ""}: ĐỌC ĐƯỢC hội thoại và tin nhắn.`);
  console.log("  Không một lời gọi GHI nào được thực hiện trong bài kiểm này.");
}

main().catch((error) => {
  console.error("Lỗi:", error instanceof Error ? error.message : error);
  process.exit(1);
});
