/**
 * ═══════ ops `page-auto-skip-audit` (issue #856) — đo tin khách bị chốt «Page đã trả lời» nhầm ═══════
 *
 * Khoá: (1) phân loại dùng ĐÚNG `buildCustomerTurns` (không luật thứ hai) — tin tự động của page không đóng lượt, nhân viên / bot / ứng
 * dụng khác thì có; (2) hằng bản sao (`PAGE_REPLIED_NOTE`, `TU_CUU_MS`) bằng bản gốc; (3) tham số đóng; (4) ops-vps: MÃ HOÁ, chỉ đọc.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PAGE_REPLIED_REASON } from "@/lib/sales-chatbot/fanpage";
import { buildCustomerTurns, RESUME_MAX_TURN_AGE_MS, type LedgerMessage } from "@/lib/sales-chatbot/response-ownership";
import { docThamSo, PAGE_REPLIED_NOTE, phanLoai, TU_CUU_MS, tyLe } from "../scripts/page-auto-skip-audit";

const T = Date.parse("2026-10-16T03:04:00Z");
const cust = (id: string, at: number, o: Partial<LedgerMessage> = {}): LedgerMessage => ({ id, sender: "CUSTOMER", arrivedAt: at, sourceAt: at, status: "SKIPPED", note: PAGE_REPLIED_NOTE, ...o });
const out = (id: string, sender: LedgerMessage["sender"], at: number): LedgerMessage => ({ id, sender, arrivedAt: at, sourceAt: at });

export function testPageAutoSkipAudit() {
  assert.equal(PAGE_REPLIED_NOTE, PAGE_REPLIED_REASON, "bản sao ghi chú phải bằng fanpage.ts::PAGE_REPLIED_REASON");
  assert.equal(TU_CUU_MS, RESUME_MAX_TURN_AGE_MS, "cửa sổ tự cứu = RESUME_MAX_TURN_AGE_MS");

  // Ca «Cao Hải Ninh»: hỏi giá (câu mẫu) + tự động của page ⇒ CHỐT NHẦM, lượt cuối ⇒ BỎ SÓT HIỆN TẠI.
  const cao = buildCustomerTurns([cust("q", T, { template: true, text: "Báo giá chả cá thu?" }), out("a", "PANCAKE_AUTOMATION", T + 1_000)]);
  assert.equal(phanLoai("q", cao), "CHOT_NHAM_BO_SOT");
  // Nhân viên thật trả lời ⇒ đóng hợp lệ; bot ERP ⇒ đóng hợp lệ; ứng dụng khác ⇒ đóng hợp lệ (luật 4).
  for (const s of ["VERIFIED_HUMAN", "AI_AGENT", "OTHER_APP"] as const)
    assert.equal(phanLoai("q", buildCustomerTurns([cust("q", T), out("a", "PANCAKE_AUTOMATION", T + 1_000), out("r", s, T + 90_000)])), "DONG_HOP_LE", s);
  // Chữ hệ thống không trả lời.
  assert.equal(phanLoai("q", buildCustomerTurns([cust("q", T), out("m", "META_SYSTEM", T + 90_000)])), "CHOT_NHAM_BO_SOT");
  // Khách nhắn tiếp, lượt sau được bot đáp ⇒ đã đáp ở lượt sau (trễ, không mất). Lượt sau cũng chưa ai đáp ⇒ vẫn bỏ sót.
  const sau = [cust("q", T), out("a", "PANCAKE_AUTOMATION", T + 1_000), out("v", "VERIFIED_HUMAN", T + 2 * 3_600_000), cust("q2", T + 3 * 3_600_000, { status: "DONE", note: null }), out("b", "AI_AGENT", T + 3 * 3_600_000 + 5_000)];
  // Nhân viên trả lời sau 2 giờ cũng thuộc lượt đầu ⇒ đóng hợp lệ (người đã thật sự đáp).
  assert.equal(phanLoai("q", buildCustomerTurns(sau)), "DONG_HOP_LE");
  const sau2 = [cust("q", T), out("a", "PANCAKE_AUTOMATION", T + 1_000), cust("q2", T + 60_000, { status: "DONE", note: null })];
  assert.equal(phanLoai("q", buildCustomerTurns(sau2)), "CHOT_NHAM_BO_SOT", "khách nhắn tiếp trong cùng lượt mà chưa ai đáp ⇒ vẫn bỏ sót");
  assert.equal(phanLoai("khong-co", cao), null);
  // Review: tin bị chốt chưa ai đáp dồn chung lượt với tin khách SAU nó; câu AI đáp tin sau đóng cả lượt nhưng KHÔNG đáp tin bị chốt.
  const dapTinSau = buildCustomerTurns([cust("q", T, { template: true }), out("a", "PANCAKE_AUTOMATION", T + 1_000), cust("q2", T + 3_600_000, { status: "DONE", note: null }), out("b", "AI_AGENT", T + 3_600_000 + 5_000)]);
  assert.equal(phanLoai("q", dapTinSau), "CHOT_NHAM_DA_DAP_SAU", "câu đáp cho tin sau không phải câu đáp cho tin bị chốt");
  assert.equal(phanLoai("q", dapTinSau, new Set(["q"])), "CHOT_NHAM_DA_DAP_SAU");
  // Khách gõ hai dòng liền, cả hai bị chốt, nhân viên đáp sau cả cụm ⇒ đóng hợp lệ cho cả hai.
  const cum = buildCustomerTurns([cust("q", T), cust("q2", T + 4_000), out("v", "VERIFIED_HUMAN", T + 60_000)]);
  assert.equal(phanLoai("q", cum, new Set(["q", "q2"])), "DONG_HOP_LE");
  assert.equal(phanLoai("q2", cum, new Set(["q", "q2"])), "DONG_HOP_LE");

  assert.deepEqual(docThamSo(["hslc-hmt-shop"]), { org: "hslc-hmt-shop", hours: 168 });
  assert.deepEqual(docThamSo(["hslc-hmt-shop", "--hours=24"]), { org: "hslc-hmt-shop", hours: 24 });
  for (const sai of [[], ["a", "b"], ["a", "--hours=0"], ["a", "--hours=400"], ["a", "--apply"]]) assert.ok("error" in docThamSo(sai), JSON.stringify(sai));
  assert.equal(tyLe(1, 4), "25,0%");
  assert.equal(tyLe(1, 0), "—");

  // Chỉ đọc: không câu ghi nào; ops-vps mã hoá.
  const ma = readFileSync(path.resolve(__dirname, "../scripts/page-auto-skip-audit.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!/\.(insert|update|delete)\(|\b(insert into|delete from|update\s+\w+\s+set)\b/i.test(ma), "script chỉ đọc");
  assert.match(ma, /process\.env\.ERP_READ_ONLY = "1"/);
  const ops = readFileSync(path.resolve(__dirname, "../.github/workflows/ops-vps.yml"), "utf8");
  const maHoa = /OPS_THAO_TAC_MA_HOA: "([^"]+)"/.exec(ops)?.[1] ?? "";
  assert.ok(` ${maHoa} `.includes(" page-auto-skip-audit "), "kết quả phải MÃ HOÁ");
  assert.match(ops, /fetch_script page-auto-skip-audit\.ts[\s\S]{0,200}ma_hoa_ket_qua chay_voi_arg docker exec erp-app npx tsx --tsconfig tsconfig\.json scripts\/page-auto-skip-audit\.ts/);
  console.log("✓ page-auto-skip-audit: chốt nhầm = lượt không câu trả lời hợp lệ (luật buildCustomerTurns) · bản sao hằng khớp · chỉ đọc · MÃ HOÁ");
}
