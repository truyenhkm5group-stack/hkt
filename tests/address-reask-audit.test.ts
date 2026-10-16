/**
 * ═══════════ ops `address-reask-audit` — bot HỎI LẠI địa chỉ / phường khách đã gửi (P0 HSLC 15/10/2026) ═══════════
 *
 *  · Thuần: ca «Tuyet Nguyen Thi» (khách ghi «P An Hội Tây», bot liệt kê 6 phường Gò Vấp; công cụ nhận dòng đã mất phường) ⇒
 *    WARD_ALREADY_CLEAR + WARD_LIST + TOOL_LINE_DEGRADED; ca «Lê Văn Dụ» hỏi phường hai lượt ⇒ REPEAT_WARD_ASK; câu hỏi phường ĐẦU TIÊN
 *    cho địa chỉ mơ hồ thật KHÔNG đếm; số câu hỏi từ địa chỉ tới đơn; cửa sổ --since.
 *  · Bộ nhận «câu hỏi phường» trong script là BẢN SAO của `lib/sales-chatbot/address-memory.ts::asksForWard` — so trên cùng câu mẫu.
 *  · Mã nguồn: không câu ghi, ép chỉ đọc, TỰ CHỨA (không import tệp lib mới — ops lấy script từ main, lib từ image đang chạy), ops khai
 *    đủ bốn chỗ. CSDL thật: tóm tắt không lọt SĐT / địa chỉ / chữ tin / mã hội thoại.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { asksForWard } from "@/lib/sales-chatbot/address-memory";
import { addressAsksIn, asksForWardCopy, auditAddressReask, meanMedianText, parseReaskAuditArgs, rateText, runAddressReaskAudit, type AuditMsg } from "../scripts/address-reask-audit";

const PHONE = "0901234567";
const TUYET = `1kg chả cá thu + 1kg chả mực\n230/20 Phan Huy Ích, P An Hội Tây, TP.HCM\n${PHONE}`;
const SIX_ASK = "Dạ địa chỉ mình nay thuộc phường Gò Vấp, phường An Nhơn, phường An Hội Đông, phường An Hội Tây, phường Hạnh Thông hay phường Thông Tây Hội theo địa giới mới ạ? Mình xác nhận giúp em để shop giao đúng nha.";
const txt = (t: string) => [{ type: "text", text: t }];
const result = (o: Record<string, unknown>, isError = false) => [{ type: "tool_result", toolUseId: "tu", content: JSON.stringify(o), isError }];

/** Dựng chuỗi tin cách nhau một phút, kết thúc «bây giờ» trừ `endAgoMin`. */
function convo(parts: [string, unknown][], endAgoMin = 1): AuditMsg[] {
  const now = Date.now();
  return parts.map(([role, content], i) => ({ seq: i + 1, role, content, at: new Date(now - (endAgoMin + parts.length - i) * 60_000) }));
}

const TUYET_CONVO: [string, unknown][] = [
  ["user", txt(TUYET)],
  ["assistant", [{ type: "tool_use", id: "tu", name: "create_customer", input: {} }]],
  ["user", result({ customer_id: "x", address_check: { status: "AMBIGUOUS", ask_customer: "…" } })],
  ["assistant", txt(SIX_ASK)],
  ["user", txt("An Hội Tây mà em")],
  ["assistant", txt("Dạ vâng, em lên đơn cho mình nhé?")],
  ["user", result({ order_code: "#AB12CD34", status: "Nháp — chưa chốt, chưa giữ hàng", lines: [] })],
  ["assistant", txt("Dạ phường nào ạ?")],
];

function testArgs() {
  const at = new Date();
  assert.deepEqual(parseReaskAuditArgs(["hslc"], at), { code: "hslc", days: 7, since: null });
  assert.deepEqual(parseReaskAuditArgs(["hslc", "--days=30"], at), { code: "hslc", days: 30, since: null });
  assert.ok("error" in parseReaskAuditArgs(["hslc", "--days=31"], at));
  assert.ok("error" in parseReaskAuditArgs([], at));
  assert.ok("error" in parseReaskAuditArgs(["hslc", "--fix=1"], at), "cờ lạ");
  const since = new Date(at.getTime() - 3_600_000);
  assert.equal((parseReaskAuditArgs(["hslc", `--since=${since.toISOString()}`], at) as { since: Date }).since.getTime(), since.getTime());
  assert.ok("error" in parseReaskAuditArgs(["hslc", `--since=${new Date(at.getTime() + 60_000).toISOString()}`], at), "mốc ở tương lai");
  assert.ok("error" in parseReaskAuditArgs(["hslc", "--since=hom-qua"], at));
  assert.equal(rateText(0, 0), "CHƯA ĐO ĐƯỢC (mẫu 0)");
  assert.equal(rateText(3, 40), "3/40 (7,5%)");
  assert.equal(meanMedianText([]), "CHƯA ĐO ĐƯỢC (mẫu 0)");
  assert.equal(meanMedianText([1, 2, 6]), "trung bình 3,0 · trung vị 2,0 (n=3 · mẫu nhỏ)");
}

function testPure() {
  // Bản sao bộ nhận câu hỏi phường = bản trong lib. Hai lớp (#855 P0-A2 — lớp câu mẫu cũ để lọt một mẫu regex mới của lib):
  //  (1) MÃ NGUỒN: các khối regex cùng tên ở hai tệp phải giống hệt từng ký tự — thêm một mẫu ở lib mà quên bản sao là đỏ ngay;
  //  (2) CÙNG MỘT tập câu mẫu chạy qua cả hai, phủ mọi nhánh (câu tự thân là hỏi · câu xin không dấu hỏi · câu có dấu hiệu hỏi · câu kể).
  const block = (src: string, name: string) => {
    const m = new RegExp(`const ${name} = ([\\s\\S]*?);\\n`).exec(src);
    assert.ok(m, `không thấy khối ${name}`);
    return m[1].replace(/\s+/g, " ").trim();
  };
  const libSrc = readFileSync("lib/sales-chatbot/address-memory.ts", "utf8").replace(/\r\n/g, "\n");
  const copySrc = readFileSync("scripts/address-reask-audit.ts", "utf8").replace(/\r\n/g, "\n");
  const stripComments = (x: string) => x.replace(/^\s*\/\/.*$/gm, "");
  for (const name of ["WARD_ASK", "WARD_ASK_Q", "FULL_ADDRESS_ASK", "NOT_A_REASK"]) assert.equal(block(stripComments(copySrc), name), block(stripComments(libSrc), name), `bản sao ${name} lệch lib`);
  const WARD_SAMPLES = [
    SIX_ASK,
    "Dạ phường nào ạ?",
    "Dạ mình cho em xin tên phường / xã mới của địa chỉ với ạ?",
    "Dạ phường Cổ Nhuế 2 cũ nay thuộc phường Thượng Cát hay phường Đông Ngạc theo địa giới mới ạ?",
    "Dạ phường Đại Kim cũ nay là phường / xã nào theo tên mới ạ? Mình cho em xin tên phường / xã mới để shop giao đúng nha.",
    "Mình cho em xin tên phường nhé.",
    "Cho em xin lại xã giúp em.",
    "Mình xác nhận giúp em phường An Hội Tây đúng không ạ",
    "Dạ em giao về phường An Hội Tây cho mình nhé.",
    "Em xác nhận phường An Hội Tây cho mình nhé.",
    "Dạ em lên đơn 1kg chả cá thu nhé?",
    "Mình xác nhận giúp em nhé.",
  ];
  for (const s of WARD_SAMPLES) {
    for (const part of s.match(/[^.!?\n]+[.!?]*/g) ?? []) assert.equal(asksForWardCopy(part), asksForWard(part), `bản sao lệch bản lib: ${part}`);
  }
  assert.ok(asksForWardCopy("Mình cho em xin tên phường / xã mới để shop giao đúng nha."), "câu xin không dấu hỏi vẫn là câu hỏi phường");
  assert.deepEqual(addressAsksIn(SIX_ASK), { ward: true, wardList: true, province: false, full: false });
  assert.deepEqual(addressAsksIn("Dạ mình cho em xin địa chỉ nhận hàng nhé?"), { ward: false, wardList: false, province: false, full: true });
  assert.equal(addressAsksIn("Dạ mình ở tỉnh nào ạ?").province, true);

  const start = new Date(Date.now() - 86_400_000);
  // Ca «Tuyet Nguyen Thi»: phường rõ mà vẫn hỏi (danh sách 6) + dòng công cụ mất phường; câu hỏi SAU khi đơn lên không đếm.
  const t = auditAddressReask(convo(TUYET_CONVO), start);
  assert.ok(t.givenAt && t.clear && t.reasked, JSON.stringify(t));
  assert.deepEqual(t.causes, ["WARD_ALREADY_CLEAR", "TOOL_LINE_DEGRADED", "WARD_LIST"]);
  assert.equal(t.questionsToOrder, 2, "hai tin bot có «?» giữa địa chỉ và đơn nháp");

  // Ca «Lê Văn Dụ»: địa chỉ chỉ có quận cũ (mơ hồ thật) ⇒ câu hỏi ĐẦU TIÊN hợp lệ, lần hai bị đếm.
  const du = auditAddressReask(convo([
    ["user", txt("khu đô thị Xa La, Hà Đông, Hà Nội")],
    ["assistant", txt("Dạ mình cho em xin tên phường / xã mới của địa chỉ với ạ?")],
    ["user", txt("chị ở gần chợ")],
    ["assistant", txt("Dạ phường nào ạ?")],
  ]), start);
  assert.deepEqual([du.clear, du.causes], [false, ["REPEAT_WARD_ASK"]]);
  const once = auditAddressReask(convo([["user", txt("khu đô thị Xa La, Hà Đông, Hà Nội")], ["assistant", txt("Dạ mình cho em xin tên phường / xã mới của địa chỉ với ạ?")]]), start);
  assert.deepEqual([once.reasked, once.causes], [false, []], "câu hỏi phường đầu tiên cho địa chỉ mơ hồ thật không phải hỏi lại");
  // #855 P0-A2, ca «ThivanNguyen» (đã thay số nhà / SĐT): phường Đại Kim CŨ (bị chia) + quận cũ ⇒ bot bắt khách quy đổi sang tên mới
  // ⇒ OLD_WARD_CONVERT_ASK, kể cả câu hỏi ĐẦU TIÊN (chủ shop 16/10/2026 cấm hỏi khách tên phường mới). Trước bản này hội thoại không
  // rơi vào nhóm nào vì phường cũ không «rõ».
  const thivan = auditAddressReask(convo([
    ["user", txt(`Số 25 khu Bắc Linh Đàm, phường Đại Kim (cũ), Hoàng Mai, Hà Nội\n${PHONE}`)],
    ["assistant", txt("Dạ phường Đại Kim cũ nay là phường / xã nào theo tên mới ạ? Mình cho em xin tên phường / xã mới để shop giao đúng nha.")],
  ]), start);
  assert.deepEqual([thivan.clear, thivan.reasked, thivan.causes], [false, true, ["OLD_WARD_CONVERT_ASK"]], JSON.stringify(thivan));
  const anhSon = auditAddressReask(convo([["user", txt("Khối 3, thị trấn Anh Sơn, huyện Anh Sơn, tỉnh Nghệ An")], ["assistant", txt("Dạ mình cho em xin tên phường / xã (theo địa giới mới) của địa chỉ nhận hàng với ạ?")]]), start);
  assert.deepEqual(anhSon.causes, ["OLD_WARD_CONVERT_ASK"], "thị trấn + huyện cũ (tên cũ không có trong danh mục)");
  // «Xa La» không phải «xã», «khu đô thị» không chứa «thị xã»: chỉ quận cũ ⇒ không phải nhóm này (vẫn như ca «Lê Văn Dụ» ở trên).
  assert.equal(once.causes.includes("OLD_WARD_CONVERT_ASK"), false);
  // Không gửi địa chỉ ⇒ ngoài mẫu số; câu hỏi giá không phải địa chỉ.
  assert.equal(auditAddressReask(convo([["user", txt("chả cá bao nhiêu em?")], ["assistant", txt("Dạ mình cho em xin địa chỉ nhé?")]]), start).givenAt, null);
  // Cửa sổ: sự việc TRƯỚC mốc không đếm.
  assert.equal(auditAddressReask(convo(TUYET_CONVO, 120), new Date(Date.now() - 60 * 60_000)).reasked, false);
}

function testSource() {
  const src = readFileSync("scripts/address-reask-audit.ts", "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(!/\.(insert|update|delete)\(/.test(code) && !/\b(insert into|update \w+ set|delete from)\b/i.test(code), "script không có câu ghi nào");
  assert.match(src, /process\.env\.ERP_READ_ONLY = "1"/);
  assert.match(src, /show default_transaction_read_only/);
  assert.match(src, /getDbForInspection/);
  assert.ok(!/\bgetDb\(|withOrganization/.test(code), "không gọi lib đọc getDb() — chỉ handle chỉ đọc của tổ chức đã chọn");
  // TỰ CHỨA: mọi tệp script import phải CÓ trên main trước bản sửa — không kéo tệp lib mới của nhánh này.
  for (const m of code.matchAll(/from "@\/([^"]+)"/g)) assert.ok(existsSync(`${m[1]}.ts`) || existsSync(`${m[1]}/index.ts`), `import @/${m[1]} phải có sẵn`);
  assert.ok(!code.includes("address-memory"), "không import lib/sales-chatbot/address-memory (chưa có trên image)");
  assert.ok(!/customerStatedAddresses|wardFromCustomerWords|MAX_WARDS_NAMED_IN_QUESTION|legacyAddressUnmapped|addressGapOf/.test(code), "không dùng hàm lib mới của nhánh này");
  assert.ok(!/\(\?<[=!]/.test(code), "không nhìn-ngược");
  assert.match(src, /process\.stdout\.write\("", \(\) => done\(\)\)/, "xả stdout trước khi thoát");
  const ops = readFileSync(".github/workflows/ops-vps.yml", "utf8").replace(/\r\n/g, "\n");
  assert.match(ops, /- address-reask-audit\s+#/, "ops-vps khai lựa chọn");
  assert.match(ops, /OPS_THAO_TAC_MA_HOA: "[^"]*\baddress-reask-audit\b/, "kết quả MÃ HOÁ");
  assert.match(ops, /DOC_NANG="[^"]*\baddress-reask-audit\b/, "làn ĐỌC nặng");
  assert.match(ops, /\n\s+address-reask-audit\)\n[\s\S]*?ma_hoa_ket_qua chay_voi_arg[^\n]*scripts\/address-reask-audit\.ts ;;/, "nhánh chạy đúng script, trong ma_hoa_ket_qua");
  assert.ok(readFileSync("tests/platform-isolation-static.test.ts", "utf8").includes('"scripts/address-reask-audit.ts":'), "khai getDbForInspection ở platform-isolation-static");
}

async function capture(fn: () => Promise<unknown>): Promise<string[]> {
  const printed: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => void printed.push(a.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return printed;
}

async function testDb() {
  const db = await getDb();
  const bad = randomUUID();
  const good = randomUUID();
  const now = Date.now();
  const rows = (conv: string, parts: [string, unknown][]) => parts.map(([role, content], i) => ({ conversationId: conv, seq: i + 1, role: role as "user" | "assistant", content: content as Record<string, unknown>[], createdAt: new Date(now - (parts.length - i) * 60_000) }));
  try {
    await db.insert(schema.salesChatConversations).values([
      { id: bad, channel: "WEB", status: "OPEN" },
      { id: good, channel: "WEB", status: "OPEN" },
    ]);
    await db.insert(schema.salesChatMessages).values([
      ...rows(bad, TUYET_CONVO),
      ...rows(good, [["user", txt(TUYET)], ["user", result({ order_code: "#CD34EF56", lines: [] })], ["assistant", txt("Dạ em lên đơn cho mình rồi ạ.")]]),
    ]);
    let res: Awaited<ReturnType<typeof runAddressReaskAudit>> | null = null;
    const printed = await capture(async () => {
      res = await runAddressReaskAudit(db, { windowStart: new Date(now - 86_400_000), now: new Date(), label: "kiểm thử", convIds: [bad, good] });
    });
    assert.ok(res);
    const r = res as Awaited<ReturnType<typeof runAddressReaskAudit>>;
    assert.deepEqual([r.conversations, r.given, r.clear, r.clearAskedWard], [2, 2, 2, 1]);
    assert.deepEqual(r.reaskConvs, [bad]);
    assert.deepEqual([...r.questionsToOrder].sort(), [0, 2]);
    const all = printed.filter((l) => l.startsWith("[ops:tom-tat]")).join("\n");
    assert.match(all, /HỎI LẠI ĐỊA CHỈ \(ESTIMATED[^)]*\): 1\/2 \(50,0%\) · mẫu nhỏ/, all);
    assert.match(all, /PHƯỜNG ĐÃ RÕ MÀ VẪN HỎI: 1\/2 \(50,0%\)/, all);
    assert.match(all, /WARD_ALREADY_CLEAR 1 · TOOL_LINE_DEGRADED 1 · WARD_LIST 1 · REPEAT_WARD_ASK 0/, all);
    assert.match(all, /trung bình 1,0 · trung vị 1,0 \(n=2/, all);
    assert.ok(!all.includes(bad) && !all.includes(good), "kênh tóm tắt không in mã hội thoại");
    assert.ok(printed.some((l) => !l.startsWith("[ops:tom-tat]") && l.includes(bad)), "mã hội thoại theo nguyên nhân nằm ở phần MÃ HOÁ");
    for (const p of printed) assert.ok(!p.includes(PHONE) && !p.includes("Phan Huy Ích") && !p.includes("An Hội Tây"), `không lọt SĐT / địa chỉ / chữ tin: ${p}`);
  } finally {
    await db.delete(schema.salesChatMessages).where(inArray(schema.salesChatMessages.conversationId, [bad, good]));
    await db.delete(schema.salesChatConversations).where(inArray(schema.salesChatConversations.id, [bad, good]));
  }
}

export async function testAddressReaskAudit() {
  testArgs();
  testPure();
  testSource();
  await testDb();
  console.log("  ✓ ops address-reask-audit: ca «Tuyet Nguyen Thi» ⇒ WARD_ALREADY_CLEAR + TOOL_LINE_DEGRADED + WARD_LIST · «Lê Văn Dụ» hỏi lần hai ⇒ REPEAT_WARD_ASK · câu hỏi đầu cho địa chỉ mơ hồ không đếm · số câu hỏi tới đơn · bản sao bộ nhận khớp lib (mã nguồn + câu mẫu) · «Đại Kim cũ» ⇒ OLD_WARD_CONVERT_ASK · tóm tắt không lọt PII; chỉ đọc, tự chứa, khai đủ bốn chỗ");
}

if (process.argv[1] && /address-reask-audit\.test\.ts$/.test(process.argv[1])) {
  import("./setup-env")
    .then(() => import("@/db/migrate"))
    .then(({ ensureMigrated }) => ensureMigrated())
    .then(testAddressReaskAudit)
    .then(
      () => process.exit(0),
      (e: unknown) => {
        console.error(e);
        process.exit(1);
      },
    );
}
