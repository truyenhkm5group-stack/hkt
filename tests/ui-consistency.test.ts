import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { OUTCOME_LABEL, OUTCOME_TONE, type OrderOutcome } from "@/lib/constants/returns";
import { VERIFIED_OUTCOME_LABEL } from "@/lib/constants/data-quality";
import { ORDER_STAGE_LABEL } from "@/lib/constants/pancake";
import { COD_STATUS_LABEL, SHIPMENT_STAGE_LABEL } from "@/lib/constants/viettelpost";
import { TRUTH_DIMENSIONS, TRUTH_DIMENSION_ORDER } from "@/lib/constants/truth";
import { orderStageEnum, shipmentStageEnum, codStatusEnum } from "@/db/schema";

/**
 * NHẤT QUÁN GIAO DIỆN.
 *
 * Luật quan trọng nhất của TASK 18: trạng thái đơn / trạng thái vận đơn / trạng thái tiền / kết quả
 * đơn là BỐN CHIỀU KHÁC NHAU và không được trình bày khiến người dùng tưởng là một.
 */

function tsxFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) tsxFiles(full, acc);
    else if (entry.name.endsWith(".tsx")) acc.push(full);
  }
  return acc;
}

export function testUiConsistency() {
  // ───────── 1. Mọi giá trị của mọi chiều đều có nhãn tiếng Việt ─────────
  for (const stage of orderStageEnum.enumValues) assert.ok(ORDER_STAGE_LABEL[stage], `thiếu nhãn trạng thái đơn ${stage}`);
  for (const stage of shipmentStageEnum.enumValues) assert.ok(SHIPMENT_STAGE_LABEL[stage], `thiếu nhãn trạng thái vận đơn ${stage}`);
  for (const status of codStatusEnum.enumValues) assert.ok(COD_STATUS_LABEL[status], `thiếu nhãn trạng thái tiền ${status}`);
  for (const outcome of Object.keys(OUTCOME_LABEL) as OrderOutcome[]) {
    assert.ok(OUTCOME_LABEL[outcome] && OUTCOME_TONE[outcome], `thiếu nhãn/màu kết quả đơn ${outcome}`);
  }
  assert.ok(VERIFIED_OUTCOME_LABEL.UNVERIFIED.includes("Chưa xác minh"), "trạng thái chưa xác minh phải nói rõ là CHƯA BIẾT");
  // CHƯA BIẾT phải đọc ra là "chưa có chứng từ", không được lẫn với "chưa gửi" hay "đang giao".
  // Ba thứ này khác nhau về nghiệp vụ, và người dùng phải phân biệt được chỉ bằng cách đọc nhãn.
  assert.ok(OUTCOME_LABEL.UNKNOWN.includes("chứng từ"), "nhãn CHƯA BIẾT phải nói rõ là thiếu chứng từ ĐVVC");
  assert.notEqual(OUTCOME_LABEL.UNKNOWN, OUTCOME_LABEL.NOT_SHIPPED, "chưa có chứng từ KHÁC chưa gửi");
  assert.notEqual(OUTCOME_LABEL.UNKNOWN, OUTCOME_LABEL.IN_TRANSIT, "chưa có chứng từ KHÁC đang giao");
  assert.notEqual(OUTCOME_TONE.UNKNOWN, OUTCOME_TONE.IN_TRANSIT, "hai trạng thái khác nghĩa phải khác màu");

  // ───────── 2. Bốn chiều phải phân biệt được TRÊN GIAO DIỆN ─────────
  const badge = readFileSync("components/status-badge.tsx", "utf8");
  for (const dimension of ["order_status", "shipment_status", "payment_status", "shipment_outcome"] as const) {
    assert.ok(badge.includes(`"${dimension}"`), `nhãn trạng thái phải nói rõ nó thuộc chiều ${dimension}`);
  }
  for (const name of ["OrderStageBadge", "ShipmentStageBadge", "CodStatusBadge", "OrderOutcomeBadge", "VerifiedOutcomeBadge"]) {
    assert.ok(badge.includes(`export function ${name}`), `phải có một thành phần dùng chung cho ${name}`);
  }
  assert.ok(badge.includes("DimensionMark"), "mỗi nhãn phải mang dấu hiệu chiều để không đọc nhầm bốn chiều thành một");
  assert.ok(badge.includes("dimensionTitle"), "tooltip phải nói nguồn sự thật và điều cấm suy ra");
  for (const key of TRUTH_DIMENSION_ORDER) {
    assert.ok(TRUTH_DIMENSIONS[key].label.length > 3, `${key} phải có nhãn hiển thị được`);
  }

  // ───────── 3. KHÔNG trang nào tự vẽ lại nhãn kết quả đơn ─────────
  // Vẽ tay thì mỗi trang một kiểu, và người dùng mất luôn dấu hiệu phân biệt chiều.
  const offenders: string[] = [];
  for (const file of tsxFiles("app").concat(tsxFiles("components"))) {
    const rel = file.split(path.sep).join("/");
    if (rel.endsWith("components/status-badge.tsx")) continue;
    const src = readFileSync(file, "utf8");
    if (/OUTCOME_TONE\s*\[/.test(src)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], `phải dùng <OrderOutcomeBadge/>, không tự vẽ nhãn kết quả đơn: ${offenders.join(", ")}`);

  console.log(
    `✓ Nhất quán giao diện: ${orderStageEnum.enumValues.length + shipmentStageEnum.enumValues.length + codStatusEnum.enumValues.length + Object.keys(OUTCOME_LABEL).length} trạng thái đều có nhãn tiếng Việt · bốn chiều mang dấu hiệu riêng · không trang nào tự vẽ lại nhãn kết quả đơn`,
  );
}
