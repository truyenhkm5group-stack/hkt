import assert from "node:assert/strict";
import type { Db } from "@/db";
import { getAdsAttributionAudit } from "@/lib/queries/ads-attribution";
import { getAdsRoas } from "@/lib/queries/ads-roas";

const ALL = { key: "all" as const, from: null, to: null, label: "Toàn bộ", fromKey: null, toKey: null };

/**
 * ĐỘ PHỦ QUY KẾT QUẢNG CÁO. Đặc tả: docs/ads-attribution-audit.md.
 *
 * Điều phải khoá: độ phủ là TRẦN của mọi chỉ số ROAS, phần không nối được phải đếm riêng, và ba cấp
 * không có dữ liệu phải được nêu tên chứ không im lặng bỏ qua.
 */
export async function testAdsAttribution(db: Db) {
  void db;
  const audit = await getAdsAttributionAudit(ALL);

  // ───────── 1. Mọi dòng độ phủ phải hợp lệ và nói được lý do ─────────
  for (const r of audit.rows) {
    assert.ok(r.matched <= r.total, `${r.label}: phần nối được không thể nhiều hơn tổng`);
    assert.ok(r.coverage >= 0 && r.coverage <= 1, `${r.label}: độ phủ phải trong 0–1`);
    assert.ok(r.note.length > 20, `${r.label}: phải nói vì sao phần còn lại không nối được`);
    assert.ok(r.unit === "spend" || r.unit === "order", `${r.label}: phải nói đang đo tiền hay đơn`);
  }

  // ───────── 2. Độ phủ mã quảng cáo là TRẦN của mọi tầng sâu hơn ─────────
  // Không thể truy tới chiến dịch nhiều hơn số đơn có mã quảng cáo — nếu xảy ra thì ở đâu đó đang
  // suy ra quy kết từ thứ không phải bằng chứng.
  const withAd = audit.rows.find((r) => r.key === "order.ad");
  const campaign = audit.rows.find((r) => r.key === "order.campaign");
  const adKnown = audit.rows.find((r) => r.key === "order.adKnown");
  assert.ok(withAd && campaign && adKnown, "phải đo đủ ba tầng quy kết đơn");
  assert.equal(campaign.total, withAd.matched, "mẫu số của tầng chiến dịch phải là số đơn CÓ mã quảng cáo");
  assert.ok(campaign.matched <= withAd.matched, "không thể truy tới chiến dịch nhiều hơn số đơn có mã quảng cáo");
  assert.ok(adKnown.matched <= withAd.matched, "không thể tra ra nhiều mã hơn số mã đang có");

  // ───────── 3. Ba cấp không có dữ liệu phải được NÊU TÊN ─────────
  // Im lặng bỏ qua thì người sau sẽ đi tìm, không thấy, rồi tự dựng một con số thay thế.
  assert.equal(audit.unavailableLevels.length, 3, "phải nêu đủ ba cấp không phân tích được");
  const levels = audit.unavailableLevels.map((l) => l.level).join(" ");
  assert.ok(levels.includes("creative"), "phải nói rõ nội dung quảng cáo không có trong ERP");
  assert.ok(levels.includes("adset"), "phải nói rõ không có chi tiêu cấp nhóm quảng cáo");
  for (const l of audit.unavailableLevels) assert.ok(l.reason.length > 30, `${l.level}: phải nói VÌ SAO không có`);

  // ───────── 4. Tiền đã tiêu mà không đơn nào gắn vào phải hiện ra ─────────
  // Đây là loại thất thoát dễ bị bỏ sót nhất: nó không làm ROAS xấu đi, nó chỉ biến mất.
  assert.ok(audit.spendUnattributed >= 0, "phải đếm được tiền quảng cáo không truy ra đơn");
  assert.ok(audit.spendUnattributed <= audit.totalSpend, "phần không truy được không thể lớn hơn tổng chi");

  // ───────── 5. ROAS và độ phủ phải nói cùng một câu chuyện ─────────
  const roas = await getAdsRoas(ALL, "campaign");
  assert.equal(roas.unmapped.ordersWithoutAd, withAd.total - withAd.matched, "số đơn không có mã quảng cáo phải khớp giữa hai báo cáo");

  console.log(
    `✓ Độ phủ quy kết quảng cáo: ${(withAd.coverage * 100).toFixed(1)}% đơn có mã QC (TRẦN của mọi ROAS) · ${audit.adsMissing} mẩu QC không đọc được · ${audit.spendUnattributed.toLocaleString("vi-VN")}đ tiền chi không truy ra đơn · 3 cấp không có dữ liệu được nêu tên`,
  );
}
