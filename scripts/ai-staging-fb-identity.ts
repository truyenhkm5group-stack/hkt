/**
 * MÃ PAGE FACEBOOK — ĐI QUA CHIẾC CẦU DUY NHẤT ERP TỰ ĐI ĐƯỢC. CHỈ GỌI GET.
 *
 *   npx tsx scripts/ai-staging-fb-identity.ts [--max=5]
 *
 * ═══ VÌ SAO LÀ QUẢNG CÁO, KHÔNG PHẢI PANCAKE ═══
 *
 * Đã đo ngày 19/09/2026 (run 35444310784): Pages API của Pancake trả đúng ba khoá định danh
 * (`id`, `role_in_page`, `shop_id`) và KHÔNG khoá nào là mã Facebook; mã `61589434244037` xuất
 * hiện **0 lần** trong toàn bộ dữ liệu sống; ô `fanpage_sales_profiles.facebook_page_id` đang để
 * trống. Nên hỏi Pancake thêm lần nữa là hỏi lại một nguồn đã trả lời "tôi không biết".
 *
 * Thứ DUY NHẤT còn lại mà ERP tự đi được: **627 tin nhắn mang `ad_id`** (44 mã khác nhau). Mỗi mã
 * quảng cáo thuộc về đúng một trang, và Graph API trả `creative.effective_object_story_id` dạng
 * `"<mã page>_<mã bài>"`. Đó là lời khai của CHÍNH FACEBOOK về trang nào đã chạy mẩu quảng cáo mà
 * khách bấm vào để mở hội thoại này — tức một CHỨNG CỨ, không phải một suy luận.
 *
 * ═══ KHÔNG CÓ CHỨNG THƯ THÌ DỪNG, KHÔNG ĐOÁN ═══
 *
 * Thiếu `FACEBOOK_ACCESS_TOKEN` là một câu trả lời hợp lệ và phải in ra đúng như vậy. Tuyệt đối
 * không suy mã page từ việc tên trang nghe giống nhau — đó là cách một con số chưa kiểm chứng
 * biến thành một sự thật trong tài liệu.
 *
 * Token KHÔNG BAO GIỜ được in; kho mã này PUBLIC. Chỉ in ĐỘ DÀI, đủ để phân biệt "chưa khai" với
 * "khai rỗng".
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { rowsOf } from "@/lib/sql-rows";
import { env } from "@/lib/env";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? "";

async function main() {
  const token = env.facebook.accessToken;
  console.log("───────── CHỨNG THƯ FACEBOOK ─────────");
  console.log(`  FACEBOOK_ACCESS_TOKEN : ${token ? `đã khai (dài ${token.length} ký tự)` : "CHƯA KHAI"}`);

  const db = await getDb();
  const maQC = rowsOf<{ ad_id: string; so_tin: number }>(
    await db.execute(sql`select ad_id, count(*)::int as so_tin from sales_messages where ad_id <> '' group by 1 order by 2 desc limit 50`),
  );
  console.log(`  mã quảng cáo đọc được : ${maQC.length} mã (từ ${maQC.reduce((a, x) => a + Number(x.so_tin), 0)} tin nhắn)`);

  if (!token) {
    console.log("\n═══ DỪNG — KHÔNG CÓ NGUỒN CÓ THẨM QUYỀN TRÊN BẢN CHẠY THỬ ═══");
    console.log("  Bản chạy thử không khai chứng thư Facebook, nên ERP KHÔNG tự trả lời được câu hỏi này.");
    console.log("  Đây là một BLOCKER đọc được, không phải một lỗi: ba đường còn lại đều cần người —");
    console.log("    1. mở chính trang Facebook → phần Giới thiệu → ID trang;");
    console.log("    2. tra một trong các mã quảng cáo trên Trình quản lý quảng cáo;");
    console.log("    3. mở màn hình cấu hình Pancake, nơi page Facebook được nối vào Pancake.");
    console.log("  Rồi khai số ấy vào ô `facebook_page_id` đang để trống. KHÔNG đoán từ tên trang.");
    for (const m of maQC.slice(0, 10)) console.log(`     mã quảng cáo tra được: ${m.ad_id}`);
    process.exit(0);
  }

  // CÓ chứng thư ⇒ đi hỏi Facebook. Chỉ GET, và chỉ vài mã: câu hỏi là NHỊ PHÂN (mọi mã có cùng
  // trỏ về một trang không), nên dò cả 44 mã là tự gây bão request mà không biết thêm gì.
  const max = Number(arg("max")) || 5;
  const version = env.facebook.apiVersion;
  const theoPage = new Map<string, number>();
  console.log("\n───────── HỎI FACEBOOK: MỖI MÃ QUẢNG CÁO THUỘC TRANG NÀO ─────────");
  for (const m of maQC.slice(0, max)) {
    const url = new URL(`https://graph.facebook.com/${version}/${m.ad_id}`);
    url.searchParams.set("fields", "creative{effective_object_story_id,object_story_spec}");
    url.searchParams.set("access_token", token);
    let body: Record<string, unknown> = {};
    let status = 0;
    try {
      const res = await fetch(url, { method: "GET" });
      status = res.status;
      body = (await res.json()) as Record<string, unknown>;
    } catch (e) {
      console.log(`  ${m.ad_id} → không gọi được: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (status >= 400) {
      const loi = ((body.error ?? {}) as Record<string, unknown>).message;
      console.log(`  ${m.ad_id} → HTTP ${status}${loi ? ` · ${String(loi)}` : ""}`);
      continue;
    }
    const creative = (body.creative ?? {}) as Record<string, unknown>;
    const story = String(creative.effective_object_story_id ?? "");
    const spec = (creative.object_story_spec ?? {}) as Record<string, unknown>;
    const pageTuSpec = String(spec.page_id ?? "");
    const pageTuStory = /^([0-9]+)_/.exec(story)?.[1] ?? "";
    const page = pageTuStory || pageTuSpec;
    console.log(`  ${m.ad_id} → story_id="${story || "(không có)"}" · page_id từ spec="${pageTuSpec || "(không có)"}" ⇒ TRANG: ${page || "KHÔNG ĐỌC ĐƯỢC"}`);
    if (page) theoPage.set(page, (theoPage.get(page) ?? 0) + 1);
  }

  console.log("\n───────── KẾT LUẬN ─────────");
  if (theoPage.size === 0) {
    console.log("  KHÔNG mã nào trả về mã trang. Chứng thư có thể thiếu quyền `ads_read`, hoặc các mẩu");
    console.log("  quảng cáo này không thuộc tài khoản mà chứng thư nhìn thấy. CHƯA KẾT LUẬN ĐƯỢC.");
    process.exit(0);
  }
  for (const [page, n] of [...theoPage.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  trang ${page} — ${n} mẩu quảng cáo`);
  }
  if (theoPage.size > 1) {
    console.log("  ⚠ NHIỀU HƠN MỘT TRANG. Page Pancake này nhận hội thoại từ quảng cáo của nhiều trang,");
    console.log("    nên KHÔNG có một bản đồ 1-1 để khai. Phải hỏi chủ shop trang nào là trang gốc.");
  } else {
    const [page] = [...theoPage.keys()];
    console.log(`  ⇒ CHỨNG CỨ: page Pancake 1117899664739453 nhận hội thoại từ quảng cáo của trang Facebook ${page}.`);
    console.log("    Đây là lời khai của CHÍNH Facebook, đủ mạnh để khai vào ô `facebook_page_id`.");
    console.log(`    Mã đang nghi ngờ trong tài liệu là 61589434244037 ⇒ ${page === "61589434244037" ? "KHỚP" : "KHÔNG KHỚP — tài liệu đang sai"}.`);
  }
}

main().catch((e) => {
  console.error("Lỗi:", e instanceof Error ? e.message : e);
  process.exit(1);
});
