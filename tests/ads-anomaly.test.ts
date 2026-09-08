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

  // ───────── Tiêu 3 triệu, không đơn nào: PHẢI kêu, và kêu ở mức kinh doanh ─────────
  // Đây là loại thất thoát dễ bị bỏ sót nhất vì nó không làm chỉ số nào xấu đi — nó chỉ biến mất.
  const losing = anomalies.find((x) => x.kind === "CAMPAIGN_LOSING_MONEY" && x.campaignName === marker);
  assert.ok(losing, "chiến dịch tiêu 3 triệu mà không đơn nào PHẢI sinh cảnh báo");
  assert.equal(losing.severity, "critical", "mất trắng tiền quảng cáo là nghiêm trọng");
  assert.equal(losing.profitability, true, "dừng một chiến dịch lỗ là quyết định kinh doanh, không phải việc trực quảng cáo");
  assert.ok(losing.detail.includes("Lợi nhuận góp"), "phải nói rõ con số nào dẫn tới kết luận");
  assert.equal(losing.amount, 3_000_000, "số tiền liên quan phải đúng bằng phần đã mất");

  const lowRoas = anomalies.find((x) => x.kind === "LOW_DELIVERED_ROAS" && x.campaignName === marker);
  assert.ok(lowRoas, "ROAS giao thành công bằng 0 phải bị bắt");

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

  console.log(`✓ Quảng cáo bất thường: ${anomalies.length} cảnh báo (bắt đúng ca tiêu 3 triệu không ra đơn) · ngưỡng ở một chỗ duy nhất · tách cảnh báo kinh doanh khỏi cảnh báo vận hành · KHÔNG tự đổi ngân sách`);
}
