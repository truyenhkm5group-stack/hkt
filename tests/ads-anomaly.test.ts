import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { ADS_ANOMALY_LABEL, ADS_ANOMALY_RULES, PROFITABILITY_KINDS } from "@/lib/constants/ads-anomaly";
import { detectAdsAnomalies, isProfitabilityAnomaly } from "@/lib/queries/ads-anomaly";

/**
 * PHÁT HIỆN QUẢNG CÁO BẤT THƯỜNG.
 *
 * Điều phải khoá: mỗi cảnh báo nói được so cái gì với cái gì; chiến dịch nhỏ không làm ồn; và
 * cảnh báo KINH DOANH tách khỏi cảnh báo VẬN HÀNH vì hai người khác nhau xử lý.
 */
export async function testAdsAnomaly(db: Db) {
  // Dữ liệu fixture nằm ngoài cửa sổ 7 ngày nên không quy tắc nào chạy. Dựng đúng tình huống đắt
  // nhất — TIỀN ĐÃ TIÊU MÀ KHÔNG ĐƠN NÀO — rồi xoá sạch ở cuối, để không dòng chi tiêu giả nào
  // lọt vào tổng của các khối kiểm thử khác.
  const marker = "KIỂM THỬ BẤT THƯỜNG";
  await db.insert(schema.adSpends).values({
    platform: "facebook",
    campaign: marker,
    campaignId: "test-anomaly-campaign",
    spend: 3_000_000,
    spendDate: new Date(Date.now() - 2 * 86_400_000),
    externalKey: `test-anomaly:${Date.now()}`,
  });

  const anomalies = await detectAdsAnomalies();

  // ───────── ĐỘ PHỦ QUY KẾT THẤP ⇒ KHÔNG ĐƯỢC KẾT LUẬN LỖ/LÃI ─────────
  // Fixture chỉ có ~2,5% đơn mang mã quảng cáo. Chiến dịch vừa dựng tiêu 3 triệu và không có đơn
  // nào gắn vào — nhưng ở độ phủ này KHÔNG kết luận được là nó lỗ, vì doanh thu do nó mang lại có
  // thể đang nằm ở những đơn không quy kết được.
  const losing = anomalies.find((x) => x.kind === "CAMPAIGN_LOSING_MONEY" && x.campaignName === marker);
  assert.equal(losing, undefined, "độ phủ quy kết thấp thì KHÔNG được kết luận chiến dịch đang lỗ");

  // ───────── ĐỘ PHỦ QUY KẾT THẤP ⇒ KHÔNG ĐƯỢC KẾT LUẬN LỖ/LÃI ─────────
  // Phát hiện trên production: chi tiêu đếm ĐỦ 100%, doanh thu chỉ quy được cho đơn CÓ mã quảng cáo
  // (~46%). Lấy chi tiêu đủ trừ doanh thu thiếu rồi kết luận "đang lỗ" là so hai vế không cùng gốc,
  // và nó báo lỗ cho gần như MỌI chiến dịch — 26 cảnh báo trong một lần quét.
  //
  // Câu trả lời trung thực ở độ phủ thấp không phải "đang lỗ" mà là "CHƯA KẾT LUẬN ĐƯỢC".
  assert.ok(
    ADS_ANOMALY_RULES.minAttributionToJudgeProfit > ADS_ANOMALY_RULES.minAttributionPct,
    "ngưỡng dám kết luận lợi nhuận phải cao hơn hẳn ngưỡng 'quy kết hỏng'",
  );
  const attributionLost = anomalies.find((x) => x.kind === "ATTRIBUTION_LOST");
  const profitAlerts = anomalies.filter((x) => x.profitability);
  if (attributionLost) {
    assert.equal(profitAlerts.length, 0, "độ phủ chưa đủ thì KHÔNG được phát bất kỳ cảnh báo lợi nhuận nào");
    assert.ok(attributionLost.detail.includes("KHÔNG kết luận"), "phải nói thẳng là chưa kết luận được, không im lặng bỏ qua");
  }
  // Cảnh báo SO KỲ vẫn dùng được ở độ phủ thấp, vì cả hai kỳ cùng thiếu như nhau.
  for (const k of ["SPEND_SURGE_NO_REVENUE", "SUCCESS_RATE_DROP", "SPEND_SYNC_STALE"] as const) {
    assert.equal(isProfitabilityAnomaly(k), false, `${k}: so kỳ với kỳ thì không phụ thuộc độ phủ`);
  }

  for (const an of anomalies) {
    assert.ok(ADS_ANOMALY_LABEL[an.kind], `${an.kind}: thiếu nhãn tiếng Việt`);
    // Cảnh báo không nói được vì sao thì người nhận sẽ bỏ qua ngay từ lần thứ hai.
    assert.ok(an.detail.length > 30, `${an.kind}: phải nói rõ so cái gì với cái gì, chênh bao nhiêu`);
    assert.ok(an.amount >= 0, `${an.kind}: số tiền liên quan không được âm`);
    assert.equal(an.profitability, isProfitabilityAnomaly(an.kind), `${an.kind}: phân nhóm kinh doanh/vận hành phải nhất quán`);
    assert.ok(an.severity === "warning" || an.severity === "critical");
  }

  // Việc nghiêm trọng phải lên trước — hàng đợi đọc từ trên xuống.
  for (let i = 1; i < anomalies.length; i += 1) {
    const prev = anomalies[i - 1];
    const cur = anomalies[i];
    if (cur.severity === "critical") assert.equal(prev.severity, "critical", "cảnh báo nghiêm trọng phải xếp trên cảnh báo thường");
  }

  // Ngưỡng phải nằm ở MỘT chỗ và có giá trị hợp lý — không hard-code rải rác.
  assert.ok(ADS_ANOMALY_RULES.minSpendToJudge > 0, "phải có ngưỡng chi tối thiểu, nếu không chiến dịch vài chục nghìn sẽ làm ồn");
  assert.ok(ADS_ANOMALY_RULES.windowDays >= 7, "cửa sổ so sánh quá ngắn sẽ báo động theo dao động ngày thường");
  assert.ok(ADS_ANOMALY_RULES.spendSurgePct > ADS_ANOMALY_RULES.revenueLagPct, "định nghĩa 'chi tăng mà hàng không ra' phải có khoảng cách rõ ràng");

  // Hai nhóm phải tách bạch: dừng một chiến dịch lỗ là quyết định kinh doanh, không phải việc
  // của người trực quảng cáo.
  assert.ok(PROFITABILITY_KINDS.includes("CAMPAIGN_LOSING_MONEY"), "càng chạy càng lỗ là cảnh báo mức kinh doanh");
  assert.equal(isProfitabilityAnomaly("SPEND_SYNC_STALE"), false, "đồng bộ chết là trục trặc vận hành, không phải chuyện lợi nhuận");
  assert.equal(isProfitabilityAnomaly("ATTRIBUTION_LOST"), false, "mất dấu quy kết là lỗi ĐO LƯỜNG, không phải lỗi hiệu quả");

  await db.delete(schema.adSpends).where(eq(schema.adSpends.campaignId, "test-anomaly-campaign"));
  const afterCleanup = await detectAdsAnomalies();
  assert.ok(!afterCleanup.some((x) => x.campaignName === marker), "dữ liệu dựng cho kiểm thử phải được dọn sạch");

  console.log(
    `✓ Quảng cáo bất thường: ${anomalies.length} cảnh báo · độ phủ quy kết thấp thì KHÔNG kết luận lỗ/lãi (chỉ báo "chưa kết luận được") · tách cảnh báo kinh doanh khỏi vận hành · KHÔNG tự đổi ngân sách`,
  );
}
