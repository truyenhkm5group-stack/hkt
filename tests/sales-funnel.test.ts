import assert from "node:assert/strict";
import type { Db } from "@/db";
import { ATTRIBUTION_FIELDS, LOW_COVERAGE_PCT } from "@/lib/constants/sales-funnel";
import { getAttributionCoverage, getFunnelBySource, getSalesFunnel } from "@/lib/queries/sales-funnel";

const ALL = { key: "all" as const, from: null, to: null, label: "Toàn bộ", fromKey: null, toKey: null };

/**
 * PHỄU BÁN HÀNG. Đặc tả: docs/sales-funnel-contract.md.
 *
 * Điều phải khoá: phễu KHÔNG được phình ra ở giữa, bước cuối dùng lại đúng công thức kết quả đơn,
 * và mọi chỉ số chia theo người phải kèm độ phủ.
 */
export async function testSalesFunnel(db: Db) {
  void db;
  const funnel = await getSalesFunnel(ALL);

  // ───────── 1. Phễu phải THU HẸP, không phình ─────────
  // Đây là lý do phễu tính theo KỲ TẠO ĐƠN chứ không theo ngày xảy ra từng bước: đếm theo ngày
  // riêng thì bước sau có thể lớn hơn bước trước, và cái hình vẽ ra không còn là cái phễu.
  const orderStages = funnel.stages.filter((s) => s.key !== "repeat");
  for (let i = 1; i < orderStages.length; i += 1) {
    assert.ok(
      orderStages[i].count <= orderStages[i - 1].count,
      `phễu phình ở bước "${orderStages[i].label}": ${orderStages[i].count} > ${orderStages[i - 1].count}`,
    );
  }

  // ───────── 2. Tỷ lệ phải nói rõ đang so với cái gì ─────────
  for (const s of funnel.stages) {
    assert.ok(s.ofStart >= 0 && s.ofStart <= 1, `${s.label}: tỷ lệ so với bước đầu phải trong 0–1`);
    assert.ok(s.ofPrevious >= 0 && s.ofPrevious <= 1, `${s.label}: tỷ lệ so với bước trước phải trong 0–1`);
    assert.ok(s.previousLabel.length > 0, `${s.label}: phải nói mẫu số là gì`);
  }
  // Bước "khách mua lại" có GRAIN KHÁC (khách, không phải đơn) nên mẫu số của nó phải là số khách —
  // ghi rõ bằng lời thay vì để người đọc tưởng đang so với số đơn.
  const repeat = funnel.stages.find((s) => s.key === "repeat");
  assert.equal(repeat?.previousLabel, "khách đã nhận hàng", "bước mua lại phải nói rõ mẫu số là khách");

  // ───────── 3. Đơn chưa kết thúc KHÔNG được tính là thất bại ─────────
  // Kỳ vừa chạy xong luôn còn đơn đang trên đường; im lặng coi chúng là hỏng là bôi đen số liệu
  // của chính mình.
  assert.ok(funnel.unfinished >= 0, "phải đếm được đơn chưa kết thúc");
  assert.ok(funnel.cancelled >= 0, "đơn huỷ phải tách riêng, không lẫn vào thất bại giao vận");
  const created = funnel.stages[0].count;
  const delivered = funnel.stages.find((s) => s.key === "delivered")?.count ?? 0;
  assert.ok(delivered + funnel.unfinished + funnel.cancelled <= created, "các nhóm kết quả không được vượt tổng đơn");

  // ───────── 4. Độ phủ gán người: có số, và biết khi nào số đó không đáng tin ─────────
  const coverage = await getAttributionCoverage(ALL);
  assert.equal(coverage.length, ATTRIBUTION_FIELDS.length, "phải đo đủ cả năm trường người phụ trách");
  for (const c of coverage) {
    assert.ok(c.coverage >= 0 && c.coverage <= 1, `${c.label}: độ phủ phải trong 0–1`);
    assert.ok(c.filled <= c.total, `${c.label}: số đơn có gán không thể nhiều hơn tổng đơn`);
    assert.equal(c.lowCoverage, c.total > 0 && c.coverage * 100 < LOW_COVERAGE_PCT, `${c.label}: cờ độ phủ thấp phải khớp ngưỡng`);
  }
  // Năm vai KHÔNG thay thế được cho nhau — mỗi vai phải là một dòng riêng, không gộp.
  assert.equal(new Set(coverage.map((c) => c.field)).size, 5, "năm vai phải tách bạch");

  // ───────── 5. Tách theo kênh: cộng lại phải bằng tổng, tỷ lệ có mẫu số đúng ─────────
  const bySource = await getFunnelBySource(ALL);
  assert.equal(
    bySource.reduce((t, r) => t + r.created, 0),
    created,
    "cộng các kênh phải đúng bằng tổng đơn — không kênh nào được đếm hai lần, không đơn nào rơi mất",
  );
  for (const r of bySource) {
    // Mẫu số là đơn ĐÃ RỜI KHO: kênh không chịu trách nhiệm cho đơn chưa từng gửi đi.
    if (r.shipped === 0) assert.equal(r.deliveryRate, null, `${r.label}: chưa gửi đơn nào thì KHÔNG có tỷ lệ giao`);
    else assert.ok(Math.abs((r.deliveryRate ?? 0) - r.delivered / r.shipped) < 1e-9, `${r.label}: tỷ lệ giao phải chia cho đơn đã rời kho`);
    assert.ok(r.delivered <= r.shipped, `${r.label}: không thể giao nhiều hơn số đã gửi`);
    assert.ok(r.confirmed <= r.created, `${r.label}: không thể xác nhận nhiều hơn số đơn tạo`);
  }

  const low = coverage.filter((c) => c.lowCoverage).map((c) => c.label);
  console.log(
    `✓ Phễu bán hàng: ${created} đơn → ${funnel.stages[1].count} xác nhận → ${funnel.stages[2].count} rời kho → ${delivered} giao thành công · ${funnel.unfinished} chưa kết thúc (KHÔNG tính là hỏng)${low.length ? ` · độ phủ thấp: ${low.join(", ")}` : ""}`,
  );
}
