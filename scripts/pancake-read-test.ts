/**
 * KIỂM TRA QUYỀN ĐỌC PANCAKE — CHỈ GỌI GET, KHÔNG MỘT LỜI GỌI GHI NÀO.
 *
 *   npx tsx scripts/pancake-read-test.ts --page=<PAGE_ID> [--hours=24] [--fb=<FACEBOOK_PAGE_ID>]
 *
 * Trả lời bằng dữ liệu thật chứ không bằng cấu hình:
 *   1. Token có dùng được không?
 *   2. Page có truy cập được không, TÊN là gì, và mã Facebook của nó là gì?
 *   3. Đọc được hội thoại không? PHÂN TRANG có đúng không?
 *   4. Đọc được tin nhắn không? Có mã trùng không? Thứ tự thời gian có thật không?
 *
 * ═══ VÌ SAO KHÔNG ĐOÁN TRƯỜNG NÀO LÀ MÃ FACEBOOK ═══
 *
 * Mã Pancake và mã Facebook của cùng một page là HAI SỐ KHÁC NHAU, và tài liệu không nói chắc
 * Pancake trả mã Facebook ở khoá nào. Nên tệp này IN RA mọi khoá trông như một mã định danh cùng
 * giá trị của chúng, rồi mới so với `--fb` nếu được truyền. Đoán một tên khoá rồi báo "không khớp"
 * là dựng ra một sự cố không có thật; in cả bộ ra thì người đọc thấy ngay sự thật.
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
  /** Mã Facebook KỲ VỌNG. Không truyền thì chỉ in ra mã đọc được, không kết luận khớp/lệch. */
  const fbMong = arg("fb");

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

    /*
      MÃ FACEBOOK: IN RA MỌI KHOÁ TRÔNG NHƯ MỘT MÃ, KHÔNG ĐOÁN MỘT TÊN KHOÁ.

      Mã Pancake và mã Facebook của cùng một page là hai số khác nhau, và tài liệu không nói chắc
      Pancake trả mã Facebook ở khoá nào. Đoán một tên khoá rồi báo "không khớp" là dựng ra một sự
      cố không có thật. In cả bộ khoá ra thì sự thật tự lộ, và lần sau không ai phải đoán nữa.
    */
    console.log("    ── mọi khoá trông như một mã định danh ──");
    const maKhoa = Object.entries(found)
      .filter(([k, v]) => /(^|_)(id|uid|fb|facebook|page)/i.test(k) && (typeof v === "string" || typeof v === "number"))
      .map(([k, v]) => [k, String(v)] as const);
    if (maKhoa.length === 0) console.log("      (không khoá nào)");
    for (const [k, v] of maKhoa) console.log(`      ${k.padEnd(22)} = ${v}`);

    if (fbMong) {
      const khop = maKhoa.filter(([, v]) => v === fbMong);
      if (khop.length) {
        console.log(`    ✓ Mã Facebook ${fbMong} KHỚP ở khoá: ${khop.map(([k]) => k).join(", ")}`);
      } else {
        // KHÔNG thoát khác 0: đây là một phát hiện phải đọc, không phải một lỗi kết nối. Quyền đọc
        // vẫn đạt; thứ cần xem lại là bản đồ mã page mà tài liệu cũ đang ghi.
        console.log(`    ⚠ Mã Facebook ${fbMong} KHÔNG khớp khoá nào ở trên.`);
        console.log("      Quyền đọc VẪN đạt — nhưng bản đồ mã page trong tài liệu cần kiểm lại.");
      }
    } else {
      console.log("    (chưa truyền --fb=<mã> nên không kết luận khớp/lệch)");
    }
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

  /*
    ── 2b. PHÂN TRANG CÓ THẬT SỰ SANG TRANG KHÔNG ──

    Một API trả HTTP 200 cho mọi `page_number` mà luôn đưa lại TRANG MỘT là dạng hỏng tệ nhất có
    thể có ở đây: lượt nạp chạy hai mươi vòng, mỗi vòng thấy "có dữ liệu", và không bao giờ đi quá
    năm mươi hội thoại đầu. Không lỗi, không cảnh báo, chỉ là phần còn lại của page không bao giờ
    tới. Nên phải so MÃ HỘI THOẠI của hai trang, không so số lượng.
  */
  console.log("\n───────── 2b. PHÂN TRANG ─────────");
  const trang2 = await get(`pages/${pageId}/conversations`, {
    [key]: token, since, until, page_number: 2, page_size: 20, order_by: "updated_at",
  });
  if (trang2.status >= 400) {
    console.log(`  ⚠ trang 2 trả HTTP ${trang2.status} — không kiểm được phân trang.`);
  } else {
    const ds2 = arr(trang2.body.conversations ?? (trang2.body.data as Record<string, unknown>)?.conversations ?? trang2.body.data);
    const id1 = new Set(conversations.map((c) => String(c.id)));
    const trung = ds2.filter((c) => id1.has(String(c.id))).length;
    console.log(`  trang 1: ${conversations.length} · trang 2: ${ds2.length} · TRÙNG mã: ${trung}`);
    if (ds2.length === 0) {
      console.log("  ✓ trang 2 rỗng — page này ít hội thoại hơn một trang, phân trang không kết luận được.");
    } else if (trung === ds2.length) {
      console.error("  ✗ TRANG 2 LẶP LẠI TRANG 1 — phân trang KHÔNG chạy. Lượt nạp sẽ không bao giờ đi quá trang đầu.");
      process.exit(1);
    } else if (trung > 0) {
      // Chồng lấn một phần là BÌNH THƯỜNG khi sắp theo `updated_at`: hội thoại có tin mới nhảy
      // trang giữa hai lời gọi. Đường nạp chống trùng bằng mã tin nên nó không đẻ ra bản sao.
      console.log(`  ✓ phân trang chạy (chồng lấn ${trung} — hợp lệ khi sắp theo updated_at)`);
    } else {
      console.log("  ✓ phân trang chạy, hai trang không trùng mã nào.");
    }
  }

  // ── 3. ĐỌC TIN NHẮN ──
  console.log("\n───────── 3. TIN NHẮN ─────────");
  const first = conversations[0];
  const customerId = String(arr(first.customers)[0]?.id ?? (first.customer as Record<string, unknown>)?.id ?? "");
  // Tham số khớp ĐÚNG `PancakePagesClient.listMessages` (`current_count`, không phải `page_number`).
  // Bài kiểm gọi khác connector thì nó kiểm một đường mà lượt nạp đi một đường khác.
  const msg = await get(`pages/${pageId}/conversations/${String(first.id)}/messages`, {
    [key]: token,
    customer_id: customerId,
    current_count: 0,
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

  /* ── 3b. MÃ TRÙNG · THỨ TỰ THỜI GIAN · ĐÍNH KÈM · DANH TÍNH ── */
  console.log("\n───────── 3b. TÍNH TOÀN VẸN CỦA TIN NHẮN ─────────");
  const ids = messages.map((m) => String(m.id ?? m.message_id ?? ""));
  const rong = ids.filter((x) => !x).length;
  const trungMa = ids.length - new Set(ids.filter(Boolean)).size;
  console.log(`  tin đọc được       : ${messages.length}`);
  console.log(`  KHÔNG có mã        : ${rong}${rong ? "  ⚠ chống trùng dựa vào mã — tin không mã phải rơi về vân tay nội dung" : ""}`);
  console.log(`  mã TRÙNG nhau      : ${trungMa}${trungMa ? "  ⚠ cùng một tin xuất hiện hai lần trong MỘT lời gọi" : ""}`);

  // Mốc thời gian: API trả theo thứ tự nào là việc của nó, nhưng mọi tin PHẢI có mốc đọc được —
  // thiếu mốc thì không dựng lại được hội thoại theo trình tự, và cả phép chia lượt sụp đổ.
  const moc = messages.map((m) => Date.parse(String(m.inserted_at ?? m.created_time ?? m.created_at ?? "")));
  const khongMoc = moc.filter((t) => Number.isNaN(t)).length;
  const hopLe = moc.filter((t) => !Number.isNaN(t));
  const giam = hopLe.every((t, i) => i === 0 || hopLe[i - 1] >= t);
  const tang = hopLe.every((t, i) => i === 0 || hopLe[i - 1] <= t);
  console.log(`  thiếu mốc thời gian: ${khongMoc}${khongMoc ? "  ⚠" : ""}`);
  console.log(`  thứ tự API trả     : ${giam ? "mới → cũ" : tang ? "cũ → mới" : "KHÔNG theo thứ tự nào"}`);

  const coDinhKem = messages.filter((m) => arr(m.attachments).length > 0).length;
  const loaiDinhKem = new Set(messages.flatMap((m) => arr(m.attachments).map((a) => String(a.type ?? ""))).filter(Boolean));
  console.log(`  tin có đính kèm    : ${coDinhKem}${coDinhKem ? ` · loại: ${[...loaiDinhKem].join(", ") || "(không khai type)"}` : ""}`);
  const coMaQC = messages.filter((m) => arr(m.attachments).some((a) => a.ad_id)).length;
  console.log(`  tin kèm mã quảng cáo: ${coMaQC}  (tín hiệu sản phẩm DUY NHẤT có thật trong Pages API)`);

  // DANH TÍNH: ai gửi. Tin của shop mà chỉ có MỘT mã người gửi nghĩa là không phân biệt được
  // người với máy bằng danh tính — phải dựa vào phép nhận dạng câu mẫu ở lớp đọc.
  const nguoiGui = new Map<string, number>();
  for (const m of messages) {
    const from = (m.from ?? {}) as Record<string, unknown>;
    const k = `${String(from.id ?? "")}|${mask(String(from.name ?? ""))}`;
    nguoiGui.set(k, (nguoiGui.get(k) ?? 0) + 1);
  }
  console.log(`  số người gửi khác nhau: ${nguoiGui.size}`);
  for (const [k, n] of [...nguoiGui.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
    const [id, ten] = k.split("|");
    const laPage = id === pageId;
    console.log(`    ${laPage ? "SHOP " : "KHÁCH"} · ${id || "(không mã)"} · ${ten || "(không tên)"} · ${n} tin`);
  }

  console.log("\n───────── KẾT LUẬN ─────────");
  console.log(`  Page ${pageId}${pageName ? ` (${pageName})` : ""}: ĐỌC ĐƯỢC hội thoại và tin nhắn.`);
  console.log("  Không một lời gọi GHI nào được thực hiện trong bài kiểm này.");
}

main().catch((error) => {
  console.error("Lỗi:", error instanceof Error ? error.message : error);
  process.exit(1);
});
