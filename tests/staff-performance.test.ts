import assert from "node:assert/strict";
import { asc, inArray } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { ATTRIBUTION_FIELDS, UNASSIGNED_LABEL } from "@/lib/constants/sales-funnel";
import { getStaffPerformance } from "@/lib/queries/staff-performance";
import { getSalesFunnel } from "@/lib/queries/sales-funnel";

const ALL = { key: "all" as const, from: null, to: null, label: "Toàn bộ", fromKey: null, toKey: null };

/**
 * HIỆU SUẤT NHÂN SỰ.
 *
 * Điều phải khoá: không đánh giá ai bằng số lượng đơn; đơn không gán được phải hiện ra chứ không
 * bị chia đều; thiếu giá vốn phải thành `null` chứ không thành 0.
 */
export async function testStaffPerformance(db: Db) {
  // Fixture dùng chung không gán người bán cho đơn nào, nên nếu không dựng thêm thì bài kiểm thử
  // chỉ thấy đúng một dòng "Chưa gán" và không kiểm được phần quan trọng nhất: tách người, xếp
  // theo tiền, và tổng cộng lại không rơi mất đơn.
  //
  // Chỉ ghi vào `seller_name` — trường này không có báo cáo nào khác đọc, nên không đổi con số của
  // bất kỳ assertion nào ở các khối kiểm thử khác.
  const sample = await db.select({ id: schema.orders.id }).from(schema.orders).orderBy(asc(schema.orders.id)).limit(6);
  if (sample.length >= 4) {
    await db.update(schema.orders).set({ sellerName: "Ngọc" }).where(inArray(schema.orders.id, sample.slice(0, 2).map((r) => r.id)));
    await db.update(schema.orders).set({ sellerName: "Hà" }).where(inArray(schema.orders.id, sample.slice(2, 4).map((r) => r.id)));
  }

  for (const f of ATTRIBUTION_FIELDS) {
    const report = await getStaffPerformance(ALL, f.field);

    // ───────── 1. Tổng phải khớp phễu — không được rơi mất đơn nào ─────────
    const funnel = await getSalesFunnel(ALL);
    assert.equal(report.totalOrders, funnel.stages[0].count, `${f.label}: tổng đơn phải bằng bước đầu của phễu`);
    assert.equal(
      report.rows.reduce((t, r) => t + r.orders, 0),
      report.totalOrders,
      `${f.label}: cộng từng người phải đúng bằng tổng — đơn không gán được KHÔNG được rơi mất`,
    );

    // ───────── 2. Đơn không gán được hiện thành MỘT dòng riêng, không chia đều ─────────
    const unassigned = report.rows.filter((r) => r.unassigned);
    assert.ok(unassigned.length <= 1, `${f.label}: chỉ được có đúng một dòng "chưa gán"`);
    if (unassigned.length) assert.equal(unassigned[0].name, UNASSIGNED_LABEL, "dòng chưa gán phải có nhãn tiếng Việt");

    for (const r of report.rows) {
      // ───────── 3. Mẫu số của tỷ lệ là đơn ĐÃ KẾT THÚC ─────────
      // Chia cho tổng đơn sẽ trừng phạt người vừa nhận đơn hôm qua.
      const settled = r.delivered + r.returned;
      if (settled === 0) {
        assert.equal(r.gtc, null, `${r.name}: chưa đơn nào kết thúc thì KHÔNG được bịa ra tỷ lệ`);
        assert.equal(r.returnRate, null, `${r.name}: chưa đơn nào kết thúc thì chưa có tỷ lệ hoàn`);
      } else {
        assert.ok(Math.abs((r.gtc ?? 0) + (r.returnRate ?? 0) - 1) < 1e-9, `${r.name}: giao thành công + hoàn phải bằng 1 trên đơn đã kết thúc`);
      }
      assert.ok(r.delivered + r.returned + r.unfinished <= r.orders, `${r.name}: các nhóm kết quả không vượt tổng đơn`);

      // ───────── 4. Thiếu giá vốn là NULL, không phải 0 ─────────
      // Coi thiếu là 0 sẽ thổi phồng đóng góp đúng bằng phần giá vốn chưa biết.
      if (r.cogs === null) assert.equal(r.contribution, null, `${r.name}: chưa biết giá vốn thì chưa biết đóng góp`);
      else assert.equal(r.contribution, r.deliveredRevenue - r.cogs, `${r.name}: đóng góp = doanh thu giao thành công − giá vốn`);

      if (r.delivered === 0) assert.equal(r.aov, null, `${r.name}: chưa giao đơn nào thì không có giá trị trung bình`);
    }

    // ───────── 5. Xếp theo TIỀN THẬT, không theo số đơn ─────────
    const staff = report.rows.filter((r) => !r.unassigned);
    for (let i = 1; i < staff.length; i += 1) {
      assert.ok(staff[i - 1].deliveredRevenue >= staff[i].deliveredRevenue, `${f.label}: phải xếp theo doanh thu giao thành công giảm dần`);
    }
    assert.ok(report.coverage >= 0 && report.coverage <= 1, `${f.label}: độ phủ phải trong 0–1`);
    assert.ok(report.cogsCoverage >= 0 && report.cogsCoverage <= 1, `${f.label}: độ phủ giá vốn phải trong 0–1`);
  }

  const seller = await getStaffPerformance(ALL, "sellerName");
  // ───────── 6. Có người thật thì phải tách thành nhiều dòng, và "Chưa gán" vẫn còn nguyên ─────────
  const names = seller.rows.map((r) => r.name);
  assert.ok(names.includes("Ngọc") && names.includes("Hà"), "phải tách được từng người, không gộp làm một");
  assert.ok(names.includes(UNASSIGNED_LABEL), "đơn không gán được PHẢI hiện ra, không được chia đều cho nhân viên");
  assert.equal(seller.rows[seller.rows.length - 1].name, UNASSIGNED_LABEL, "dòng chưa gán xếp cuối, không lẫn vào bảng xếp hạng người thật");
  assert.ok(seller.coverage > 0, "gán được người rồi thì độ phủ phải lớn hơn 0");

  console.log(
    `✓ Hiệu suất nhân sự: ${seller.rows.length} dòng · độ phủ gán người ${(seller.coverage * 100).toFixed(1)}%${seller.lowCoverage ? " (THẤP — mọi so sánh phải kèm cảnh báo)" : ""} · độ phủ giá vốn ${(seller.cogsCoverage * 100).toFixed(1)}% · xếp theo tiền thật bán được, không theo số đơn`,
  );
}
