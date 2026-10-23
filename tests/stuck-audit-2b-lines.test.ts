/**
 * ═══ Dòng tóm tắt 2B / regression-watch vừa kênh [ops:tom-tat] — đo theo BYTE (23/10/2026) ═══
 *
 * ops-vps.yml cắt kênh tóm tắt bằng `cut -c1-300`, mà GNU cut -c đếm BYTE: dòng 2B ngày 22/10 dồn theo `length` (UTF-16) ≤ 300 mà
 * vẫn cụt ở «CART_TOTAL_C…» vì chữ Việt 2–3 byte. Khoá: mọi mã trong SALES_QUALITY_CODES có mặt ĐÚNG MỘT lần, mỗi nhóm một dòng
 * (địa chỉ · số lượng/tiền · upsell · chờ người), mã chưa khai nhóm rơi «khác» chứ không mất, không dòng nào quá trần byte.
 */
import assert from "node:assert/strict";
import { REGRESSION_WATCH, type RegressionVerdict } from "@/lib/constants/regression-watch";
import { SALES_QUALITY_CODES } from "@/lib/constants/sales-quality";
import { packSummaryLines, QUALITY_GROUP, qualityStateSummary, SUMMARY_MAX_BYTES, utf8Bytes } from "@/scripts/stuck-conversation-audit";
import { regressionStatusLines, regressionStatusTable, type OrgRegressionSnapshot } from "@/scripts/regression-watch-status";

/** Giống hệt đường công khai: cut -c1-300 trên BYTE. */
const cutBytes = (s: string) => Buffer.from(s, "utf8").subarray(0, 300).toString("utf8");

export function testStuckAudit2bLines() {
  assert.ok(SUMMARY_MAX_BYTES <= 300, "trần phải dưới mức cắt của workflow");

  // Ca thật 22/10 (số đếm của run 39877102744): bản cũ cụt từ CART_TOTAL_CONFLICT.
  const real = {
    day: "2026-10-22",
    at: "2026-10-23T00:02:41.000Z",
    conversations: 295,
    counts: { HANDOFF_UNANSWERED: 104, QTY_REASKED: 0, SECONDARY_INTENT_UNANSWERED: 0, WRONG_PRODUCT_TEMPLATE: 1, ADDRESS_REASK: 2, COMPLAINT_WHILE_SELLING: 0, CLARIFY_FALLBACK: 0, CLAIM_GUARD_BLOCK: 7, UPSELL_ACCEPTED_BUT_REASKED: 0, UPSELL_ACCEPTED_NOT_ATTACHED: 0, ADDRESS_RECEIVED_BUT_NOT_APPLIED: 1, QUANTITY_UNIT_AMBIGUOUS: 0, PACK_MULTIPLIER_MISMATCH: 0, CART_TOTAL_CONFLICT: 0, STAFF_AI_QUOTE_CONFLICT: 0, ORDER_UPDATED_WITHOUT_VERIFIED_CONSENT: 0, PACK_MULTIPLIER_LEAKED: 1 },
    bases: { customerMessages: 662, botMessages: 662, quantityAnswers: 4, deliverySecondAsks: 2, complaints: 1, offerAccepts: 0, handoffWaiting: 233, orderWrites: 52, staffTotals: 6, addressFlagged: 37 },
    slaHours: 4,
  };
  const out = qualityStateSummary("hslc-hmt-shop", JSON.stringify(real));
  const visible = out.map(cutBytes).join("\n");
  assert.match(visible, /CART_TOTAL_CONFLICT 0\/52 = 0,0%/, "ca 22/10: mã sau «CART_TOTAL_C» nay đọc được trên kênh công khai");
  assert.match(visible, /PACK_MULTIPLIER_LEAKED 1\/52 = 1,9%/);
  for (const c of SALES_QUALITY_CODES) assert.ok(visible.includes(`${c} `), `mã có mặt SAU khi cắt theo byte: ${c}`);

  // Nhóm: mỗi mã khai nhóm, đúng một lần; mỗi dòng mang tiền tố nhóm.
  for (const c of SALES_QUALITY_CODES) assert.ok(QUALITY_GROUP[c], `mã ${c} chưa khai nhóm — thêm vào QUALITY_GROUP`);
  for (const c of SALES_QUALITY_CODES) assert.equal(out.join(" ").split(` ${c} `).length - 1, 1, `mã ${c} đúng một lần`);
  for (const [g, c] of [["địa chỉ", "ADDRESS_REASK"], ["số lượng · tiền", "CART_TOTAL_CONFLICT"], ["upsell", "UPSELL_ACCEPTED_NOT_ATTACHED"], ["chờ người · trả lời", "HANDOFF_UNANSWERED"]] as const)
    assert.ok(out.some((l) => l.startsWith(`hslc-hmt-shop 2B ${g} · `) && l.includes(c)), `${c} nằm ở dòng nhóm «${g}»`);
  assert.ok(!out.some((l) => l.includes("2B khác")), "mọi mã hiện có đều đã khai nhóm");

  // Trường hợp xấu nhất: mã tổ chức dài, số sáu chữ số, mọi ô «chưa đủ mẫu» (nhiều byte nhất).
  const big = { ...real, conversations: 999_999, capped: true, counts: Object.fromEntries(SALES_QUALITY_CODES.map((c) => [c, 999_999])), bases: Object.fromEntries(Object.keys(real.bases).map((k) => [k, 29])) };
  const org = "to-chuc-co-ma-rat-dai-de-thu-tran-byte-01";
  const worst = qualityStateSummary(org, big);
  for (const l of worst) assert.ok(utf8Bytes(l) <= SUMMARY_MAX_BYTES, `${utf8Bytes(l)} byte > ${SUMMARY_MAX_BYTES}: ${l}`);
  for (const c of SALES_QUALITY_CODES) assert.ok(worst.map(cutBytes).join(" ").includes(`${c} `), `xấu nhất vẫn đủ mã: ${c}`);

  // Bộ dồn: theo BYTE chứ không theo ký tự; ô quá dài đứng riêng; không ô nào mất.
  const viet = Array.from({ length: 12 }, (_, i) => `MÃ_${i} 1/2 chưa đủ mẫu`);
  const packed = packSummaryLines("x 2B nhóm", viet);
  assert.ok(packed.length > 1 && packed.every((l) => utf8Bytes(l) <= SUMMARY_MAX_BYTES), "chữ Việt ⇒ tách theo byte");
  assert.ok(viet.every((c) => packed.join(" ").includes(c)));
  const long = "Đ".repeat(400);
  assert.deepEqual(packSummaryLines("p", ["a", long, "b"]), ["p · a", `p · ${long}`, "p · b"], "ô quá trần đứng riêng, không nuốt ô bên cạnh");

  // regression-watch-status: định dạng giữ nguyên (ai-tech đọc lại), chỉ khoá trần byte với mọi dòng sổ thật + số lớn.
  const verdicts: RegressionVerdict[] = ["REGRESSION_REOPENED", "LEAK_UNAVAILABLE"];
  for (const verdict of verdicts) {
    const snap: OrgRegressionSnapshot = { day: "2026-10-23", rows: REGRESSION_WATCH.map((r) => ({ mission: r.mission, code: r.leakCodes[0] ?? null, leaked: verdict === "LEAK_UNAVAILABLE" ? null : 999_999, blocked: 999_999, verdict, action: null })), items: [] };
    for (const l of regressionStatusLines(regressionStatusTable([snap, snap]), 999, 999, 999)) assert.ok(utf8Bytes(l) <= 300, `regression-watch ${utf8Bytes(l)} byte > 300: ${l}`);
  }
  console.log(`✓ tóm tắt 2B: mỗi nhóm một dòng ≤ ${SUMMARY_MAX_BYTES} byte · ca 22/10 đọc được CART_TOTAL_CONFLICT · mọi mã đúng một lần sau khi cắt theo byte · regression-watch ≤ 300 byte`);
}
