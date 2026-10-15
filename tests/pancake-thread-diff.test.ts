/**
 * ═══════════ OPS `pancake-thread-diff` — TIN PANCAKE ĐỐI CHIẾU SỔ TIN ERP VÀ HỘP THƯ (P0 HSLC 14/10/2026) ═══════════
 *
 * Khoá: đối chiếu theo mã rồi theo chữ (tin phía page — bot ghi mã tạm `bot-out:`), tin «quá mới» không tính thiếu, dòng nhập lịch sử
 * không vào độ trễ webhook, mã tạm của ERP không thành «thừa», phân vị nearest-rank, đối số chặt; script chỉ đọc (Postgres ép + hỏi
 * lại), chỉ GET, dừng khi 429, tóm tắt không nhận chữ tin / tên / token / mã hội thoại; ops-vps khai đủ bốn chỗ.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { diffThread, parseDiffArgs, phanVi, vnHour, vnTime, type ErpRow, type PcMsg } from "@/scripts/pancake-thread-diff";

const MIN = 60_000;

export function testPancakeThreadDiff() {
  console.log("Ops pancake-thread-diff (tin Pancake ↔ sổ tin ERP ↔ hộp thư):");
  const UUID = "1b942a28-86ba-4146-bf0a-2a9705f05ad3";
  assert.deepEqual(parseDiffArgs(["hslc-hmt-shop"]), { code: "hslc-hmt-shop", conv: null, hours: 72, threads: 60 });
  assert.deepEqual(parseDiffArgs(["hslc", `--conv=${UUID.toUpperCase()}`, "--hours=24", "--threads=200"]), { code: "hslc", conv: UUID, hours: 24, threads: 200 });
  for (const bad of [[], ["HSLC"], ["hslc", "--hours=73"], ["hslc", "--threads=0"], ["hslc", "--conv=abc"], ["hslc", "--hours=1.5"]]) assert.ok("error" in parseDiffArgs(bad), JSON.stringify(bad));
  assert.equal(phanVi([], 95), null, "không mẫu ⇒ chưa biết, không phải 0");
  assert.equal(phanVi([5, 1, 3, 2, 4], 50), 3);
  assert.equal(phanVi([1, 2, 3, 4, 100], 95), 100);
  assert.equal(vnTime(null), "—");
  assert.equal(vnTime(Date.parse("2026-10-13T22:55:00Z")), "14/10 05:55", "giờ Việt Nam");
  assert.equal(vnHour(Date.parse("2026-10-13T22:55:00Z")), 5);

  const now = Date.parse("2026-10-14T05:00:00Z");
  const pc: PcMsg[] = [
    { id: "c1", side: "CUSTOMER", at: now - 60 * MIN, text: "Cho mình hỏi giá" },
    { id: "p1", side: "PAGE", at: now - 59 * MIN, text: "Dạ chả cá thu bên em 280k/kg ạ" },
    { id: "c2", side: "CUSTOMER", at: now - 30 * MIN, text: "Ship về Hà Nội bao lâu" },
    { id: "p2", side: "PAGE", at: now - 29 * MIN, text: "Dạ 2 ngày chị nhé" },
    { id: "c3", side: "CUSTOMER", at: now - 10 * MIN, text: "Ok em" },
    { id: "c4", side: "CUSTOMER", at: now - 30_000, text: "Vừa gửi" },
  ];
  const erp: ErpRow[] = [
    { messageId: "c1", side: "CUSTOMER", at: now - 60 * MIN + 2_000, text: "Cho mình hỏi giá", imported: false },
    // Bot ghi mã tạm + chữ ⇒ khớp theo chữ, và mã tạm không thành «thừa».
    { messageId: "bot-out:x", side: "BOT", at: now - 59 * MIN, text: "Dạ chả cá thu bên em 280k/kg ạ", imported: false },
    { messageId: "c2", side: "CUSTOMER", at: now - 30 * MIN, text: "Ship về Hà Nội bao lâu", imported: true },
    // Dòng khách trùng chữ nhưng mã khác (luồng khác ghi lại) ⇒ khớp theo chữ, không thừa.
    { messageId: "other-id", side: "CUSTOMER", at: now - 10 * MIN + 1_000, text: "Ok em", imported: false },
    // Dòng thật sự thừa: mã không có ở Pancake, chữ không khớp.
    { messageId: "ghost", side: "PAGE", at: now - 20 * MIN, text: "zzz", imported: false },
    // Dòng cũ ngoài cửa sổ so.
    { messageId: "old", side: "CUSTOMER", at: now - 5 * 24 * 60 * MIN, text: "cũ", imported: false },
  ];
  const d = diffThread(pc, erp, now);
  assert.deepEqual(d.pancake, { CUSTOMER: 4, PAGE: 2 });
  assert.deepEqual(d.matchedById, { CUSTOMER: 2, PAGE: 0 });
  assert.deepEqual(d.matchedByText, { CUSTOMER: 1, PAGE: 1 });
  assert.equal(d.tooFresh, 1, "tin < 2 phút chưa kịp tới — không tính thiếu");
  assert.deepEqual(d.missing.map((m) => m.id), ["p2"], "tin page không có ở ERP");
  assert.deepEqual(d.extra.map((r) => r.messageId), ["ghost"]);
  assert.deepEqual(d.latencies, [2_000], "dòng nhập lịch sử (imported) không vào độ trễ webhook");
  assert.equal(d.erp.CUSTOMER, 3, "dòng ngoài cửa sổ không đếm");
  assert.equal(d.lastPancakeAt, now - 30_000);
  assert.equal(d.lastPancakeCustomerAt, now - 30_000);
  // Không tin Pancake ⇒ không kết luận thiếu / thừa.
  const empty = diffThread([], erp, now);
  assert.equal(empty.missing.length + empty.extra.length, 0);

  // Quét mã nguồn: chỉ đọc, chỉ GET, dừng khi 429, không in chữ tin / tên / token / mã hội thoại vào tóm tắt.
  const src = readFileSync("scripts/pancake-thread-diff.ts", "utf8");
  assert.match(src, /process\.env\.ERP_READ_ONLY = "1"/);
  assert.match(src, /show default_transaction_read_only/);
  assert.match(src, /getDbForInspection/);
  assert.match(src, /bindReadOnlyOrgHandle/);
  assert.match(src, /status === 429/);
  assert.doesNotMatch(src, /method: "(POST|PUT|PATCH|DELETE)"/);
  assert.doesNotMatch(src, /\.(insert|update|delete)\(/, "không một câu ghi");
  for (const line of src.split("\n").filter((l) => l.includes("tomTat(`"))) {
    assert.doesNotMatch(line, /\$\{\s*(token|[\w.]*\.text\b|[\w.]*customerName|[\w.]*[pP]hone|conv\.id|conv\.threadId|th\.id|convId)\b/, `tóm tắt không mang dữ liệu nhạy cảm: ${line.trim().slice(0, 80)}`);
  }
  const ops = readFileSync(".github/workflows/ops-vps.yml", "utf8");
  assert.equal((ops.match(/pancake-thread-diff/g) ?? []).length >= 6, true, "ops-vps khai đủ: lựa chọn · mã hoá · nặng · nhánh case");
  assert.match(ops, /OPS_THAO_TAC_MA_HOA: "[^"]*\bpancake-thread-diff\b/);
  assert.match(ops, /DOC_NANG="[^"]*\bpancake-thread-diff\b/);
  assert.match(ops, /fetch_script inbox-perf-probe\.ts[^\n]*\n\s*fetch_script pancake-thread-diff\.ts/, "kéo cả script được import");
  /*
    ═══ TIN KHÔNG CÓ CHỮ: KHỚP ĐƯỢC THÌ KHÔNG PHẢI «THIẾU», KHÔNG KHỚP ĐƯỢC THÌ VẪN LÀ «THIẾU» ═══

    Ảnh nhân viên gửi TỪ ERP nằm trong sổ dưới mã `staff-out:<id>:img` với chữ dán «[Ảnh]», còn Pancake trả cùng tin ấy
    KHÔNG CÓ CHỮ. Trước bản vá, nhánh khớp-theo-chữ bị bỏ qua khi tin Pancake rỗng chữ ⇒ tin ấy bị đếm THIẾU dù nội dung
    vẫn ở trong hộp thư, và một con số «thiếu» sai hướng dẫn người đọc đi BACKFILL — tức nhân đôi tin của khách thật.
  */
  const t0 = now;
  const pcMedia: PcMsg[] = [
    { id: "m1", side: "PAGE", at: t0 - 40 * MIN, text: "" },
    { id: "m2", side: "PAGE", at: t0 - 20 * MIN, text: "" },
    { id: "m3", side: "PAGE", at: t0 - 50 * MIN, text: "Dạ em gửi ảnh ạ" },
  ];
  const erpMedia: ErpRow[] = [
    { messageId: "staff-out:9:img", side: "PAGE", at: t0 - 40 * MIN + 3_000, text: "[Ảnh]", imported: false },
    { messageId: "staff-out:9:txt", side: "PAGE", at: t0 - 50 * MIN, text: "Dạ em gửi ảnh ạ", imported: false },
  ];
  const dm = diffThread(pcMedia, erpMedia, now);
  assert.deepEqual(dm.matchedByMedia, { CUSTOMER: 0, PAGE: 1 }, "ảnh của nhân viên khớp dòng «[Ảnh]» — đếm ở ô RIÊNG");
  assert.deepEqual(dm.matchedByText, { CUSTOMER: 0, PAGE: 1 }, "tin có chữ vẫn đi đường khớp-theo-chữ như cũ");
  assert.deepEqual(dm.missing.map((m) => m.id), ["m2"], "ảnh KHÔNG có dòng ERP nào tương ứng thì VẪN là thiếu");
  assert.deepEqual(dm.extra.map((r) => r.messageId), [], "dòng ERP đã dùng không thành «thừa»");

  // Tin không chữ KHÔNG được nuốt một dòng ERP CÓ chữ: nếu không, một tin có chữ mất thật sẽ bị che.
  const dn = diffThread([{ id: "m4", side: "PAGE", at: t0 - 15 * MIN, text: "" }], [{ messageId: "k", side: "PAGE", at: t0 - 15 * MIN, text: "Dạ vâng ạ", imported: false }], now);
  assert.deepEqual(dn.matchedByMedia, { CUSTOMER: 0, PAGE: 0 }, "không khớp tin không-chữ với dòng CÓ chữ");
  assert.deepEqual(dn.missing.map((m) => m.id), ["m4"]);
  assert.deepEqual(dn.extra.map((r) => r.messageId), ["k"]);

  console.log("  ✓ đạt");
}
