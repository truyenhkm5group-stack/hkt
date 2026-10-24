/**
 * ═══ OPS `order-dup-scan` (P0 HSLC 24/10/2026 — bot tự chốt đơn thứ hai sau khi nhân viên vừa lên đơn) ═══
 *
 * Khoá: (1) ca thật — form nhân viên 02:47:56Z + bot tự chốt 02:49:19Z, cùng hội thoại, cùng SĐT, cùng món ⇒ DUPLICATE_SUSPECTED,
 * cùng hội thoại, nguồn STAFF_FORM→BOT, tiền ảnh hưởng = đơn sau; (2) KHÔNG báo nhầm: khác mẫu mã ⇒ bỏ (luật của shop), quá khoảng
 * cách ⇒ bỏ, mỗi cặp một lần dù chung nhiều khoá; cùng hội thoại khác SĐT vẫn in; nhóm quá đông bị bỏ và ĐẾM; tất định;
 * (3) phán quyết là `assessDuplicate` (không luật thứ hai); (4) chạy được trên CSDL thật của bài kiểm; (5) script chỉ đọc, tự chứa,
 * khai đủ ở ops-vps / platform-isolation-static, tóm tắt không mã đơn / SĐT.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { MANUAL_ORDER_ID_PREFIX } from "@/lib/constants/manual-orders";
import { DUP_SCAN_MAX_GROUP, findCandidatePairs, guardBlockStats, isCancelled, newPairStats, orderLabel, originOf, parseDupScanArgs, runOrderDupScan, summarize, type ScanOrder } from "../scripts/order-dup-scan";

const item = (variantId: string, quantity = 1) => ({ variantId, sku: variantId, productName: "Chả cá thu", variationDetail: "1kg", quantity });

function order(over: Partial<ScanOrder> & { id: string; insertedAt: Date }): ScanOrder {
  return {
    systemId: null,
    stage: "CONFIRMED",
    source: "Fanpage (nhân viên chốt)",
    origin: "STAFF_FORM",
    phone: "0372000111",
    receiverName: "Khách A",
    address: "Gò Vấp, TP HCM",
    total: 280_000,
    customerId: "cus-1",
    pageId: "page-1",
    pancakeConversationId: "pc-1",
    salesConversationId: "conv-1",
    items: [item("v-cha-ca-1kg")],
    leftWarehouse: false,
    delivered: false,
    codCollected: 0,
    paid: 0,
    ...over,
  };
}

function testPure() {
  // Đồng hồ là THAM SỐ: mốc ghim cạnh dữ liệu ghim, bài kiểm không mang hạn sử dụng (AGENTS mục 50).
  const NOW = new Date("2026-10-24T09:00:00Z");
  assert.deepEqual(parseDupScanArgs(["hslc-hmt-shop"], NOW), { code: "hslc-hmt-shop", days: 30, maxGapHours: 72, since: null });
  assert.deepEqual(parseDupScanArgs(["hslc-hmt-shop", "--days=7", "--max-gap-hours=6"], NOW), { code: "hslc-hmt-shop", days: 7, maxGapHours: 6, since: null });
  assert.deepEqual(parseDupScanArgs(["hslc-hmt-shop", "--since=2026-10-24T05:18:18Z", "--max-gap-hours=72"], NOW), { code: "hslc-hmt-shop", days: 30, maxGapHours: 72, since: new Date("2026-10-24T05:18:18Z") }, "đúng lệnh Lead sẽ chạy cho #1029");
  for (const bad of [[], ["HSLC!"], ["x", "--days=0"], ["x", "--days=91"], ["x", "--max-gap-hours=0"], ["x", "--since=2026-10-24 05:18"], ["x", "--since=2026-10-24T05:18:18"], ["x", "--since=2026-07-01T00:00:00Z"]])
    assert.ok("error" in parseDupScanArgs(bad, NOW), `${JSON.stringify(bad)}: thiếu Z (giờ máy chạy), sai dạng, hay cũ hơn 90 ngày ⇒ từ chối`);
  assert.deepEqual([originOf("sales-chat:conv-1:0"), originOf("chat:conv-1:req"), originOf("order-sync:x"), originOf(null)], ["BOT", "STAFF_FORM", "MACHINE_OTHER", "SYNC_OR_MANUAL"]);

  // Ca thật: nhân viên 02:47:56Z, bot 02:49:19Z.
  const staff = order({ id: "D2A8DE9B-staff", insertedAt: new Date("2026-10-24T02:47:58Z") });
  const bot = order({ id: "A5CC67E2-bot", insertedAt: new Date("2026-10-24T02:49:19Z"), source: "Chatbot fanpage", origin: "BOT" });
  // Không báo nhầm: cùng khách, KHÁC mẫu mã, cùng hội thoại khác ⇒ hai đơn hợp lệ.
  const other = order({ id: "other-sku", insertedAt: new Date("2026-10-24T05:00:00Z"), items: [item("v-nem-hop")], salesConversationId: "conv-9", pancakeConversationId: "pc-9", origin: "BOT" });
  // Quá khoảng cách.
  const late = order({ id: "late", insertedAt: new Date("2026-10-28T02:49:00Z"), salesConversationId: "conv-7", pancakeConversationId: "pc-7" });
  // Cùng hội thoại nhưng khác SĐT (người nhận khác) — vẫn in.
  const sameConvOtherPhone = order({ id: "conv-other-phone", insertedAt: new Date("2026-10-24T03:30:00Z"), phone: "0909000222", customerId: "cus-2", items: [item("v-nem-hop")] });
  const { pairs, skippedGroups } = findCandidatePairs([bot, staff, other, late, sameConvOtherPhone], 72);
  assert.equal(skippedGroups, 0);
  const real = pairs.find((p) => p.keeper.id === staff.id && p.suspect.id === bot.id)!;
  assert.ok(real, `phải thấy cặp thật: ${JSON.stringify(pairs.map((p) => [p.keeper.id, p.suspect.id]))}`);
  assert.deepEqual(
    [real.verdict, real.gapMinutes, real.sameSalesConversation, real.samePancakeConversation, real.sameCustomer, real.bothActive, real.keeper.origin, real.suspect.origin],
    ["DUPLICATE_SUSPECTED", 1, true, true, true, true, "STAFF_FORM", "BOT"],
  );
  assert.ok(!pairs.some((p) => p.suspect.id === "other-sku" && p.keeper.id !== "conv-other-phone"), "khác mẫu mã, khác hội thoại ⇒ không phải cặp (luật của shop)");
  assert.ok(!pairs.some((p) => p.suspect.id === "late" || p.keeper.id === "late"), "quá khoảng cách ⇒ bỏ");
  assert.ok(pairs.some((p) => p.suspect.id === "conv-other-phone" && p.verdict === "DISTINCT" && p.sameSalesConversation), "cùng hội thoại khác SĐT ⇒ vẫn in (tín hiệu riêng)");
  assert.equal(new Set(pairs.map((p) => `${p.keeper.id}|${p.suspect.id}`)).size, pairs.length, "mỗi cặp đúng một lần dù chung SĐT + hội thoại + khách");
  assert.deepEqual(findCandidatePairs([sameConvOtherPhone, late, other, staff, bot], 72), { pairs, skippedGroups: 0 }, "tất định với thứ tự đầu vào");

  const s = summarize(5, pairs);
  assert.equal(s.bothActiveSuspected, 1);
  assert.equal(s.moneyAtRisk, 280_000, "tiền ảnh hưởng = tiền hàng đơn SAU của cặp nghi trùng còn hiệu lực cả hai");
  assert.equal(s.byOriginCombo["STAFF_FORM→BOT"], 1);
  const cancelled = summarize(2, findCandidatePairs([staff, { ...bot, stage: "CANCELLED" }], 72).pairs);
  assert.deepEqual([cancelled.pairs, cancelled.bothActiveSuspected, cancelled.moneyAtRisk], [1, 0, 0], "đơn sau đã huỷ ⇒ vẫn in cặp, không tính tiền ảnh hưởng");
  // Lượt quét lại sau khi nhân viên xử lý: đếm được cặp nào đã huỷ đơn sau, cặp nào huỷ đơn trước, cặp nào còn nguyên.
  assert.deepEqual([cancelled.suspectCancelledSuspected, cancelled.keeperCancelledSuspected], [1, 0], "huỷ đơn SAU ⇒ đếm vào «đơn sau đã huỷ»");
  const huyTruoc = summarize(2, findCandidatePairs([{ ...staff, stage: "CANCELLED" }, bot], 72).pairs);
  assert.deepEqual([huyTruoc.suspectCancelledSuspected, huyTruoc.keeperCancelledSuspected, huyTruoc.bothActiveSuspected], [0, 1, 0], "huỷ đơn TRƯỚC ⇒ đếm riêng, không lẫn với huỷ đơn sau");
  assert.deepEqual([s.suspectCancelledSuspected, s.keeperCancelledSuspected], [0, 0], "chưa ai huỷ ⇒ 0 / 0");
  assert.deepEqual([isCancelled({ stage: "CANCELLED" }), isCancelled({ stage: "DELETED" }), isCancelled({ stage: "CONFIRMED" })], [true, true, false]);

  // Mã đơn in ĐÚNG như danh sách /orders: `#` + mã Pancake, hoặc `#` + 8 ký tự của đơn tạo trên ERP — tra được bằng ô tìm.
  assert.equal(orderLabel({ id: `${MANUAL_ORDER_ID_PREFIX}d2a8de9b-1111-4222-8333-444455556666`, systemId: null }), "#D2A8DE9B");
  assert.equal(orderLabel({ id: "1849203311", systemId: 4521 }), "#4521", "đơn Pancake ⇒ mã hiển thị system_id, không phải id nội bộ");
  assert.equal(orderLabel({ id: `${MANUAL_ORDER_ID_PREFIX}a5cc67e2-1111-4222-8333-444455556666`, systemId: 77 }), "#77", "có system_id thì system_id thắng, như columns.tsx");

  // Cặp MỚI từ mốc deploy: tính theo ĐƠN SAU; đơn trước nằm TRƯỚC mốc vẫn ghép được. «BOT sau người» = đúng ca P0.
  const moc = new Date("2026-10-24T02:48:30Z"); // giữa đơn người (02:47:58) và đơn bot (02:49:19)
  // Ba cặp có đơn sau từ mốc: cặp thật + hai cặp «cùng hội thoại khác SĐT» (03:30) — chỉ cặp thật là nghi trùng và BOT sau người.
  assert.deepEqual(newPairStats(pairs, moc), { pairs: 3, botAfterHuman: 1, suspected: 1, suspectedBotAfterHuman: 1 }, "đơn người trước mốc + bot sau mốc ⇒ đếm là cặp mới, BOT sau người");
  assert.deepEqual(newPairStats(pairs, new Date("2026-10-24T06:00:00Z")), { pairs: 0, botAfterHuman: 0, suspected: 0, suspectedBotAfterHuman: 0 }, "không cặp nào có đơn sau từ 06:00");
  const haiBot = findCandidatePairs([{ ...staff, origin: "BOT" }, bot], 72).pairs;
  assert.equal(newPairStats(haiBot, moc).botAfterHuman, 0, "bot sau bot không phải «BOT sau người»");

  // Rào hội thoại: chỉ số đếm theo bước + «cùng đề xuất»; bước lạ không rơi mất.
  assert.deepEqual(
    guardBlockStats([
      { step: "CREATE", same: "true", n: 2 },
      { step: "CREATE", same: "false", n: "1" },
      { step: "CONFIRM", same: "false", n: 3 },
      { step: null, same: null, n: 1 },
    ]),
    { total: 7, create: 3, createSame: 2, confirm: 3, confirmSame: 0, other: 1 },
  );

  // Nhóm quá đông (SĐT dùng chung) ⇒ không dựng cặp, nhưng đếm.
  const crowd = Array.from({ length: DUP_SCAN_MAX_GROUP + 1 }, (_, i) => order({ id: `c${i}`, insertedAt: new Date(Date.UTC(2026, 9, 24, 0, i)), phone: "0912345678", customerId: null, salesConversationId: null, pancakeConversationId: null, pageId: null }));
  const big = findCandidatePairs(crowd, 72);
  assert.deepEqual([big.pairs.length, big.skippedGroups], [0, 1]);
}

async function testOnDb() {
  const printed: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => void printed.push(a.map(String).join(" "));
  try {
    const db = await getDb();
    const r = await runOrderDupScan(db, { since: new Date(Date.now() - 30 * 86_400_000), maxGapHours: 72, label: "kiểm thử", now: new Date() });
    assert.ok(r.summary.orders >= 0 && Array.isArray(r.pairs), "câu SQL chạy được trên lược đồ thật");

    // Đường đọc nhật ký rào đi qua ĐÚNG hình dạng `audit()` ghi (after nằm trong detail) — ghi bằng chính audit() như rào thật.
    const MARK = "agent:tests/order-dup-scan.test.ts";
    const truoc = new Date(Date.now() - 1000);
    try {
      for (const [step, sameAsProposal] of [["CREATE", true], ["CREATE", false], ["CONFIRM", false]] as const)
        await audit({ userId: null, userEmail: MARK, actorKind: "AGENT", action: "SALES_CHAT_DUPLICATE_ORDER_BLOCKED", entity: "ORDER", entityId: "erp-test", after: { conversationId: "c", step, sameAsProposal, draftOrderId: null } });
      const r2 = await runOrderDupScan(db, { since: new Date(Date.now() - 30 * 86_400_000), newSince: truoc, maxGapHours: 72, label: "kiểm thử --since", now: new Date() });
      assert.ok(r2.guardBlocks.create >= 2 && r2.guardBlocks.createSame >= 1 && r2.guardBlocks.confirm >= 1, `đếm rào đọc đúng detail->'after': ${JSON.stringify(r2.guardBlocks)}`);
    } finally {
      await db.delete(schema.auditLogs).where(eq(schema.auditLogs.userEmail, MARK));
    }
  } finally {
    console.log = orig;
  }
  const summary = printed.filter((l) => l.startsWith("[ops:tom-tat]"));
  assert.ok(summary.length >= 4, "có khối tóm tắt");
  assert.ok(summary.some((l) => l.includes("cặp mới từ ")) && summary.some((l) => l.includes("rào hội thoại chặn bot từ ")), "có dòng cặp mới + dòng đếm rào");
  for (const l of summary) assert.ok(!/0\d{9}/.test(l), `tóm tắt không có SĐT: ${l}`);
}

function testSourceFences() {
  const src = readFileSync("scripts/order-dup-scan.ts", "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(src, /if \(CHAY_THANG\) process\.env\.ERP_READ_ONLY = "1";\nimport "dotenv\/config";/, "đặt ERP_READ_ONLY TRƯỚC khi nạp @/db");
  assert.match(src, /show default_transaction_read_only/);
  assert.match(src, /getDbForInspection/);
  assert.ok(!/\bgetDb\(|withOrganization/.test(code), "không gọi lib đọc getDb() — chỉ handle chỉ đọc của tổ chức đã chọn");
  assert.ok(!/\b(insert|update|delete)\s+(into|from)?\s*\w|\.insert\(|\.update\(|\.delete\(/i.test(code.replace(/\/\/.*$/gm, "")), "không ghi gì");
  for (const m of code.matchAll(/from "@\/([^"]+)"/g)) assert.ok(existsSync(`${m[1]}.ts`) || existsSync(`${m[1]}/index.ts`), `import @/${m[1]} phải có sẵn`);
  assert.ok(!/\(\?<[=!]/.test(code), "không nhìn-ngược");
  assert.ok(!/short\([kx]\.id\)/.test(code), "mã đơn đi qua orderLabel (đúng mã ERP hiển thị), không cắt 8 ký tự đầu của id nội bộ");
  assert.match(code, /select o\.id, o\.system_id,/, "đọc system_id để in mã Pancake");
  assert.match(src, /process\.stdout\.write\("", \(\) => done\(\)\)/, "xả stdout trước khi thoát");
  assert.ok(!/tomTat\([^)]*short\(|tomTat\([^)]*\.id\b|tomTat\([^)]*phone/.test(code), "tóm tắt không in mã đơn / SĐT");
  const ops = readFileSync(".github/workflows/ops-vps.yml", "utf8").replace(/\r\n/g, "\n");
  assert.match(ops, /- order-dup-scan\s+#/, "ops-vps khai lựa chọn");
  assert.match(ops, /OPS_THAO_TAC_MA_HOA: "[^"]*\border-dup-scan\b/, "kết quả MÃ HOÁ");
  assert.match(ops, /DOC_NANG="[^"]*\border-dup-scan\b/, "làn ĐỌC nặng");
  assert.match(ops, /\n\s+order-dup-scan\)\n[\s\S]*?ma_hoa_ket_qua chay_voi_arg[^\n]*scripts\/order-dup-scan\.ts ;;/, "nhánh chạy đúng script, trong ma_hoa_ket_qua");
  assert.ok(readFileSync("tests/platform-isolation-static.test.ts", "utf8").includes('"scripts/order-dup-scan.ts":'), "khai getDbForInspection ở platform-isolation-static");
}

export async function testOrderDupScan() {
  testPure();
  await testOnDb();
  testSourceFences();
  console.log("  ✓ ops order-dup-scan: ca thật (form nhân viên → bot tự chốt, cùng hội thoại, 1 phút) ⇒ nghi trùng, tiền ảnh hưởng 280.000 ₫ · khác mẫu mã / quá khoảng cách không báo nhầm · cùng hội thoại khác SĐT vẫn in · nhóm quá đông đếm riêng · tất định · chạy được trên CSDL · chỉ đọc, tóm tắt không mã đơn / SĐT");
}
