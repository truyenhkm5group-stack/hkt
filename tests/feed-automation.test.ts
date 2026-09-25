import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { eq, inArray } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { collectCandidates } from "@/lib/alerts/rules";
import { ALERT_CONFIG_KEY, DEFAULT_ALERT_CONFIG } from "@/lib/constants/alerts";
import { CASE_ACTION, CASE_SLA_HOURS, CASE_TEAM, caseTypeOf } from "@/lib/constants/action-queue";
import { COD_STATEMENT_MATCH_WINDOW_DAYS, statementCoverage, statementNumberOf, VTP_ORDER_LIST_MAX_AGE_HOURS, VTP_ORDER_LIST_REMIND_FROM_HOUR_VN, vtpOrderListDue } from "@/lib/constants/feed-freshness";
import { STATEMENT_MAIL_HEARTBEAT_KEY } from "@/lib/integrations/viettelpost/statement-mail";
import type { ManagerDay } from "@/lib/queries/manager-day";
import { getSettingJson, setSettingJson } from "@/lib/settings";
import { soBangKe } from "@/scripts/cod-statement-audit";
import { MORNING_BRIEF_HOUR_VN, morningBriefMessage, runMorningBrief } from "@/lib/work/morning-brief";

/**
 * ═══════════ TỰ ĐỘNG HOÁ KHÔNG TỐN AI: MÁY NHẮC ĐÚNG LÚC, KHÔNG NÓI QUÁ ═══════════
 *
 * Ba việc máy tự nhắc (tệp Danh sách vận đơn đến hạn · tiền COD về mà thiếu bảng kê · script Gmail
 * im lặng) và một bản tin sáng. Bài kiểm khoá hai chiều cho mỗi thứ:
 *
 *  · CÓ vấn đề thì PHẢI nhắc — im lặng ở đây là tiền bị đòi nhầm, kiện lấy hỏng không ai thấy;
 *  · KHÔNG có vấn đề thì KHÔNG được nhắc — một kênh báo sai ba lần là kênh không ai đọc nữa.
 *
 * Mốc thời gian: phần hàm thuần nhận `now` tường minh; phần chạm CSDL gieo dữ liệu TƯƠNG ĐỐI với
 * đồng hồ thật, cùng nhịp với truy vấn (AGENTS.md mục 50).
 */

/** Một thời điểm có giờ Việt Nam cho trước, trong ngày 20/09/2026. */
const luc = (gioVn: number) => new Date(Date.UTC(2026, 8, 20, gioVn - 7, 0));

export async function testFeedAutomation(db: Db) {
  /* ═══════════ 1 · TỆP DANH SÁCH VẬN ĐƠN ĐẾN HẠN ═══════════ */

  assert.deepEqual(vtpOrderListDue(null, luc(VTP_ORDER_LIST_REMIND_FROM_HOUR_VN - 1)), { due: false }, "trước giờ nhắc thì không nhắc, kể cả khi chưa từng nhập");
  assert.deepEqual(vtpOrderListDue(null, luc(VTP_ORDER_LIST_REMIND_FROM_HOUR_VN)), { due: true, ageHours: null }, "chưa từng nhập là ĐẾN HẠN — và không bịa ra số giờ");
  const cu = new Date(luc(11).getTime() - (VTP_ORDER_LIST_MAX_AGE_HOURS + 1) * 3_600_000);
  const han = vtpOrderListDue(cu, luc(11));
  assert.equal(han.due, true, "tệp cũ hơn hạn ⇒ đến hạn");
  assert.equal(han.due && Math.round(han.ageHours ?? 0), VTP_ORDER_LIST_MAX_AGE_HOURS + 1);
  assert.deepEqual(vtpOrderListDue(new Date(luc(11).getTime() - 2 * 3_600_000), luc(11)), { due: false }, "vừa nhập 2 giờ trước ⇒ không nhắc");

  /* ═══════════ 2 · SỐ BẢNG KÊ TRONG NỘI DUNG CHUYỂN KHOẢN ═══════════ */

  assert.equal(statementNumberOf("VTP GLMTQY12 110926 30601124"), "30601124", "mẫu thật: số bảng kê là cụm số cuối, không phải cụm ngày ddmmyy");
  assert.equal(statementNumberOf("MBVCB.123 VTP GLMTQY18 180926 30873899 thanh toan"), "30873899");
  assert.equal(statementNumberOf("VTP GLMTQY12 110926"), null, "chỉ có ngày ⇒ KHÔNG ĐỌC ĐƯỢC, không đoán");
  assert.equal(statementNumberOf("Nguyen Van A chuyen tien 30601124"), null, "không phải chuyển khoản Viettel Post ⇒ không đọc");
  assert.equal(statementNumberOf("BangKeChiCOD_30873899_1790000000000.xlsx"), "30873899", "tên tệp bảng kê mang cùng số");

  /*
    HAI BẢN CỦA MỘT LUẬT PHẢI NÓI CÙNG MỘT ĐIỀU. Ops `cod-statement-audit` giữ bản riêng `soBangKe`
    CÓ CHỦ Ý: ops lấy script từ `main` nhưng lấy `lib/` từ bản đang chạy, nên script import một tệp
    lib mới sẽ sập cho tới lần deploy sau. Cái giá của bản sao là phải khoá chúng vào nhau ở đây —
    đổi một bên mà quên bên kia thì cảnh báo và bản kiểm tra kết luận khác nhau về cùng một khoản tiền.
  */
  const mau = [
    "VTP GLMTQY18 180926 30873899",
    "Tong cong ty co phan Buu chinh Viet VTP GLMTQY09 090926 30566351. TU: TONG CTY",
    "MBVCB.123 VTP GLMTQY18 180926 30873899 thanh toan",
    "BangKeChiCOD_30873899_1790000000000.xlsx",
    "BangKeChiCOD_31031025.xlsx",
    "VTP GLMTQY12 110926",
    "HO KHAC TRUYEN chuyen tien 0912345678",
    "Nguyen Van A chuyen tien 30601124",
    "",
  ];
  for (const s of mau) assert.equal(statementNumberOf(s), soBangKe(s), `hai bản luật số bảng kê lệch nhau ở: "${s}"`);

  /* ═══════════ 3 · BA CĂN CỨ "ĐÃ CÓ BẢNG KÊ", CHỈ THIẾU KHI CẢ BA ĐỀU KHÔNG ═══════════ */

  const ck = { id: "tx-1", txnAt: new Date("2026-09-14T09:00:00Z"), amount: 33_082_937, description: "VTP GLMTQY14 140926 30751602" };
  const dot = (over: Partial<{ id: string; receivedAt: Date; totalAmount: number; note: string; reference: string }> = {}) => ({
    id: "b-1",
    receivedAt: new Date("2026-09-13T17:00:00Z"),
    totalAmount: 1,
    note: "",
    reference: "BK-2026-09-14",
    ...over,
  });
  assert.deepEqual(statementCoverage(ck, [], [], ["b-9"]), { covered: true, by: "LINKED", batchId: "b-9" }, "đã nối tay ⇒ đủ");
  assert.equal(statementCoverage(ck, [], ["BangKeChiCOD_30751602_14092026.xlsx"], []).covered, true, "số bảng kê có trong tên tệp đã nhập ⇒ đủ");
  assert.equal(statementCoverage(ck, [dot({ note: "BangKeChiCOD_30751602_x.xlsx" })], [], []).covered, true, "số bảng kê có ở ghi chú đợt ⇒ đủ");
  assert.equal(statementCoverage(ck, [dot({ totalAmount: ck.amount })], [], []).covered, true, "cùng số tiền, sát ngày ⇒ cùng đợt");
  const xa = dot({ totalAmount: ck.amount, receivedAt: new Date(ck.txnAt.getTime() - (COD_STATEMENT_MATCH_WINDOW_DAYS + 1) * 86_400_000) });
  assert.deepEqual(statementCoverage(ck, [xa], [], []), { covered: false, statementNumber: "30751602" }, "cùng số tiền nhưng xa ngày ⇒ KHÔNG coi là cùng đợt");
  assert.deepEqual(statementCoverage(ck, [dot()], ["BangKeChiCOD_30601124.xlsx"], []), { covered: false, statementNumber: "30751602" }, "tệp của đợt KHÁC không phủ được đợt này");
  // Tệp tải tay từ web: tên không mang số, không lập đợt — chỉ khớp được bằng Σ thực nhận của tệp.
  assert.deepEqual(statementCoverage(ck, [], ["Bao_cao_chi_tiet_bang_ke_25_09_2026 02_07_48.xlsx"], [], [ck.amount]), { covered: true, by: "AMOUNT", batchId: null }, "tổng thực nhận của một bảng kê trong sổ bằng đúng khoản chuyển ⇒ đủ");
  assert.equal(statementCoverage(ck, [], [], [], [ck.amount - 1, 3_250_997]).covered, false, "lệch một đồng hay bảng kê của đợt khác ⇒ vẫn thiếu");

  /* ═══════════ 4 · LUẬT CHẠY TRÊN CSDL: CÓ THIẾU THÌ BÁO, ĐỦ RỒI THÌ THÔI ═══════════ */

  const cauHinhCu = await getSettingJson(ALERT_CONFIG_KEY, DEFAULT_ALERT_CONFIG);
  const nhipCu = await db.query.syncState.findFirst({ where: eq(schema.syncState.key, STATEMENT_MAIL_HEARTBEAT_KEY) });
  const ids = ["feed-tx-thieu", "feed-tx-du", "feed-tx-moi"];
  const batchId = "feed-batch-du";
  try {
    await setSettingJson(ALERT_CONFIG_KEY, { ...cauHinhCu, enabled: { ...DEFAULT_ALERT_CONFIG.enabled, ...(cauHinhCu.enabled ?? {}), codStatementMissing: true } });
    const ngay = (n: number) => new Date(Date.now() - n * 86_400_000);
    await db.insert(schema.bankTransactions).values([
      { id: ids[0], txnAt: ngay(3), amount: 7_900_195, description: "VTP GLMTQY23 230926 31031025", bankRef: "feed-ref-1", accountingGroup: "COD_SETTLEMENT", source: "IMPORT" },
      { id: ids[1], txnAt: ngay(3), amount: 11_268_242, description: "VTP GLMTQY18 180926 30873899", bankRef: "feed-ref-2", accountingGroup: "COD_SETTLEMENT", source: "IMPORT" },
      // Mới về một giờ: còn trong thời gian chờ thư bảng kê ⇒ chưa được đòi.
      { id: ids[2], txnAt: new Date(Date.now() - 3_600_000), amount: 3_250_997, description: "VTP GLMTQY11 110926 30601124", bankRef: "feed-ref-3", accountingGroup: "COD_SETTLEMENT", source: "IMPORT" },
    ]);
    await db.insert(schema.codBatches).values({ id: batchId, reference: "FEED-BK-TEST", receivedAt: ngay(3), totalAmount: 11_268_242, source: "VTP_STATEMENT_MAIL", note: "BangKeChiCOD_30873899.xlsx", createdBy: "test" });
    // Script Gmail liên lạc lần cuối 5 giờ trước.
    const nhip = { at: new Date(Date.now() - 5 * 3_600_000).toISOString(), actor: "GMAIL:test", files: 0, imported: 0, outcome: "PING" };
    await db.insert(schema.syncState).values({ key: STATEMENT_MAIL_HEARTBEAT_KEY, value: nhip }).onConflictDoUpdate({ target: schema.syncState.key, set: { value: nhip } });

    const { candidates, activeKinds } = await collectCandidates();
    assert.ok(activeKinds.includes("COD_STATEMENT_MISSING") && activeKinds.includes("STATEMENT_MAIL_SILENT"), "loại đang bật phải khai active để việc tự đóng khi hết điều kiện");
    const thieu = candidates.filter((c) => c.kind === "COD_STATEMENT_MISSING" && ids.includes(c.entityId));
    assert.deepEqual(thieu.map((c) => c.entityId), ["feed-tx-thieu"], "chỉ đợt KHÔNG có tệp mới là việc; đợt đã có tệp và đợt vừa về không phải");
    assert.ok(thieu[0].title.includes("31031025"), "tiêu đề phải nêu số bảng kê để người làm tìm đúng thư");
    assert.ok(thieu[0].body.includes("ĐỪNG đi đòi"), "phải nói rõ tiền đã về — không đẩy người đọc đi đòi khoản đã nhận");

    const im = candidates.filter((c) => c.kind === "STATEMENT_MAIL_SILENT");
    assert.equal(im.length, 1, "script im 5 giờ ⇒ một việc");

    // Script liên lạc lại ⇒ việc biến mất ở lượt sau (phép chiếu, không có nút "xong").
    const nhipMoi = { ...nhip, at: new Date().toISOString() };
    await db.update(schema.syncState).set({ value: nhipMoi }).where(eq(schema.syncState.key, STATEMENT_MAIL_HEARTBEAT_KEY));
    const lai = await collectCandidates();
    assert.equal(lai.candidates.filter((c) => c.kind === "STATEMENT_MAIL_SILENT").length, 0, "script đã liên lạc lại ⇒ không còn việc");

    /* Hai dấu hiệu, MỘT loại việc, về đúng phòng Kế toán — và loại Viettel Post về phòng Giao vận. */
    assert.equal(caseTypeOf("COD_STATEMENT_MISSING"), "COD_STATEMENT_MISSING");
    assert.equal(caseTypeOf("STATEMENT_MAIL_SILENT"), "COD_STATEMENT_MISSING");
    assert.equal(CASE_TEAM[caseTypeOf("COD_STATEMENT_MISSING")], "FINANCE");
    assert.equal(CASE_TEAM[caseTypeOf("VTP_ORDER_LIST_DUE")], "LOGISTICS");
    for (const k of ["VTP_ORDER_LIST_DUE", "COD_STATEMENT_MISSING"] as const) {
      assert.ok(CASE_ACTION[k].length > 40, `${k} phải nói việc cần làm`);
      assert.ok(typeof CASE_SLA_HOURS[k] === "number", `${k} phải có hạn xử lý`);
    }
  } finally {
    await db.delete(schema.bankTransactions).where(inArray(schema.bankTransactions.id, ids));
    await db.delete(schema.codBatches).where(eq(schema.codBatches.id, batchId));
    await db.delete(schema.notifications).where(inArray(schema.notifications.entityId, [...ids, "vtp-statement-mail"]));
    if (nhipCu) await db.update(schema.syncState).set({ value: nhipCu.value }).where(eq(schema.syncState.key, STATEMENT_MAIL_HEARTBEAT_KEY));
    else await db.delete(schema.syncState).where(eq(schema.syncState.key, STATEMENT_MAIL_HEARTBEAT_KEY));
    await setSettingJson(ALERT_CONFIG_KEY, cauHinhCu);
  }

  /* ═══════════ 5 · BẢN TIN SÁNG: CHÉP ĐÚNG MÀN HÌNH, KHÔNG NÓI QUÁ ═══════════ */

  const viec = (title: string, url: string) => ({ title, sourceUrl: url }) as unknown as NonNullable<ManagerDay["morning"]>["picks"][number]["item"];
  const day = {
    backlog: 42,
    overdue: 7,
    dueSoon: 3,
    unassigned: 5,
    blocked: 1,
    waiting: 4,
    money: { atRisk: 12_500_000, recoverable: 0, unknown: 6, known: 36 },
    morning: {
      picks: [
        { rank: 1, item: viec("Giao thất bại · PKE1", "/shipments/1"), departmentLabel: "Giao vận", moneyAtRisk: 850_000, escalation: { label: "Quá hạn 5 giờ" } },
        { rank: 2, item: viec("Dòng tiền chưa phân loại", "/bank"), departmentLabel: "Kế toán", moneyAtRisk: null, escalation: null },
      ],
    },
    interventions: [],
    emptyDepartments: [{ department: "PRODUCTION", label: "Sản xuất", open: 2 }],
    failedSources: [{ source: "SHIPMENT_CARE", error: "timeout" }],
  } as unknown as ManagerDay;
  const tin = morningBriefMessage(day, luc(MORNING_BRIEF_HOUR_VN), "https://erp.test");
  const chu = tin.lines.map((l) => l.map((p) => p.text).join("")).join("\n");
  assert.ok(tin.title.includes("20/09"), "tiêu đề mang ngày Việt Nam");
  assert.ok(chu.includes("42 việc mở") && chu.includes("7 quá hạn") && chu.includes("5 chưa ai nhận"), "đúng các con số của màn hình");
  assert.ok(chu.includes("6 việc chưa tra được tiền"), "tổng tiền treo phải đi kèm số việc CHƯA BIẾT tiền (mục 42)");
  assert.ok(chu.includes("Dòng tiền chưa phân loại — chưa tra được tiền"), "việc không có số tiền KHÔNG được in thành 0 ₫");
  assert.ok(!/— 0\s?₫/.test(chu), "không một việc nào được in tiền 0 khi chưa biết");
  assert.ok(chu.includes("Sản xuất: 2 việc mở mà phòng chưa có thành viên"), "phòng không người phải được nói ra");
  assert.ok(chu.includes("THIẾU phần của các nguồn này"), "nguồn đọc hỏng ⇒ phải nói số liệu thiếu, không để trông như đủ");
  const lienKet = tin.lines.flat().filter((p) => p.href).map((p) => p.href);
  assert.ok(lienKet.includes("https://erp.test/shipments/1") && lienKet.includes("https://erp.test/work/today"), "liên kết phải tuyệt đối để bấm được từ Lark");

  /* Không khai webhook nhóm Quản lý ⇒ KHÔNG gửi, và không lùi về nhóm vận đơn. */
  const cfgGoc = await getSettingJson(ALERT_CONFIG_KEY, DEFAULT_ALERT_CONFIG);
  try {
    await setSettingJson(ALERT_CONFIG_KEY, { ...cfgGoc, larkWebhookUrl: "https://open.larksuite.com/open-apis/bot/v2/hook/nhom-van-don", larkManagerWebhookUrl: "" });
    const r = await runMorningBrief(luc(9));
    assert.equal(r.sent, false);
    assert.equal(r.reason, "chưa khai webhook nhóm Quản lý", "thiếu webhook nhóm Quản lý thì dừng — tuyệt đối không gửi vào nhóm vận đơn");
    await setSettingJson(ALERT_CONFIG_KEY, { ...cfgGoc, larkManagerWebhookUrl: "https://open.larksuite.com/open-apis/bot/v2/hook/quan-ly", enabled: { ...DEFAULT_ALERT_CONFIG.enabled, morningBrief: false } });
    assert.equal((await runMorningBrief(luc(9))).reason, "đã tắt ở trang Cảnh báo");
  } finally {
    await setSettingJson(ALERT_CONFIG_KEY, cfgGoc);
  }

  /* ═══════════ 6 · KHOÁ BÍ MẬT KHÔNG ĐI XUỐNG TRÌNH DUYỆT, Ô TRỐNG LÀ GIỮ ═══════════ */

  const trang = readFileSync("app/(dashboard)/alerts/page.tsx", "utf8");
  for (const k of ["telegramBotToken", "larkSecret", "larkBillingSecret", "larkInventorySecret", "larkManagerSecret"]) {
    assert.ok(trang.includes(`${k}: ""`), `trang Cảnh báo phải xoá trắng ${k} trước khi gửi xuống trình duyệt`);
  }
  const hanhDong = readFileSync("lib/actions/alerts.ts", "utf8");
  for (const k of ["telegramBotToken", "larkSecret", "larkBillingSecret", "larkInventorySecret", "larkManagerSecret"]) {
    assert.ok(hanhDong.includes(`${k}: giu(parsed.data.${k}, stored.${k})`), `lưu cấu hình với ô ${k} trống phải GIỮ khoá cũ, không ghi đè thành rỗng`);
  }

  console.log("✓ tự động hoá không tốn AI: nhắc tệp VTP / bảng kê thiếu / script Gmail im lặng, bản tin sáng chép đúng màn hình");
}
