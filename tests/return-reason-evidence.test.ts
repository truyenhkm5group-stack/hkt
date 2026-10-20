import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inArray } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import { RETURN_REASONS, RETURN_REASON_TEXT_RULES, VTP_REASON_TO_RETURN_REASON, type ReturnReason } from "@/lib/constants/return-reason";
import { REASON_SOURCES, SOURCE_CAN_CONCLUDE_SHOP_FAULT, carrierCodeText, vtpCodeOfObservation } from "@/lib/constants/return-reason-source";
import {
  AUTHORITY_REQUIRED_GROUPS,
  EVIDENCE_GROUPS,
  REASON_EVIDENCE,
  REASON_TAXONOMY_KEY,
  buildReasonGrouping,
  evidenceGroupDepartment,
  evidenceGroupOf,
  parseReasonTaxonomy,
  reasonPickerGroups,
  resolveEvidence,
  transitionGroupOverrides,
  type ReasonEvidenceItem,
} from "@/lib/constants/return-reason-evidence";
import { reasonGroupTable } from "@/lib/constants/return-reason-mapping";
import { carrierCodeObservation, carrierEventObservations, humanReasonObservation, reasonDedupeKey } from "@/lib/returns/reason-observe";
import { reasonsForShipments } from "@/lib/queries/return-reason";
import { getReturnReasonReport, listReasonShipments } from "@/lib/queries/return-reason-report";
import { setSettingJson } from "@/lib/settings";
import type { Period } from "@/lib/search-params";

/**
 * ═══════════ NHÓM LÝ DO THEO CHỨNG CỨ — LUẬT KHOÁ BẰNG BÀI KIỂM ═══════════
 *
 * Mỗi khẳng định dưới đây là một câu chủ shop đã nói (20/10/2026) và một lỗi đã đo được:
 * "không liên lạc được" bị đếm là giao chậm (858 ca), "khách từ chối" bị đếm là boom (712 ca),
 * ghi chú chăm sóc mang nhãn "Người xác nhận", và cùng một sự kiện nằm nhiều dòng quan sát.
 */

const it = (source: ReasonEvidenceItem["source"], reason: ReturnReason, at: number): ReasonEvidenceItem => ({ source, reason, at });

/* ───── 1 · Bảng ánh xạ: lời ĐVVC KHÔNG BAO GIỜ thành kết luận về lỗi ───── */
export function testEvidenceTaxonomyContract() {
  assert.equal(Object.keys(REASON_EVIDENCE).length, RETURN_REASONS.length, "mọi lý do trong sổ phải có dòng ánh xạ — thiếu một dòng là một ca biến mất khỏi bảng nhóm");
  for (const r of RETURN_REASONS) {
    const m = REASON_EVIDENCE[r];
    assert.ok(EVIDENCE_GROUPS.includes(m.verified) && EVIDENCE_GROUPS.includes(m.unverified), `${r}: nhóm không có thật`);
  }
  assert.equal(REASON_EVIDENCE.UNKNOWN.verified, "CHUA_XAC_DINH", "chỗ trống đứng riêng, không vào nhóm nguyên nhân nào");

  /*
    LÁ CHẮN CHÍNH: mọi lý do mà ĐVVC sinh ra được (mã + luật chữ) đi qua vế `unverified` khi nguồn
    là ĐVVC, và vế ấy KHÔNG BAO GIỜ là một nhóm đòi thẩm quyền (chất lượng, size, boom, sai hàng,
    giao chậm). Thêm một luật chữ/mã mới trỏ thẳng vào nhóm quy lỗi thì bài này đỏ.
  */
  const tuDvvc = new Set<ReturnReason>([...Object.values(VTP_REASON_TO_RETURN_REASON), ...RETURN_REASON_TEXT_RULES.map((l) => l.reason)]);
  for (const r of tuDvvc) {
    for (const src of ["CARRIER_CODE", "CARRIER_TEXT", "PANCAKE_RETURN"] as const) {
      const g = evidenceGroupOf(r, src);
      assert.ok(!AUTHORITY_REQUIRED_GROUPS.includes(g), `lời của ${src} "${r}" vào nhóm quy lỗi ${g} — chỉ người của shop mới kết luận được điều đó`);
    }
  }
  assert.ok(AUTHORITY_REQUIRED_GROUPS.includes("BOM_DA_XAC_MINH") && AUTHORITY_REQUIRED_GROUPS.includes("CHAT_LUONG") && AUTHORITY_REQUIRED_GROUPS.includes("GIAO_CHAM_XAC_NHAN"), "boom, chất lượng, giao chậm phải đòi thẩm quyền");
  assert.equal(evidenceGroupOf("BOOM_NO_REASON", "CARRIER_TEXT"), "KHACH_TU_CHOI_CHUA_RO", "bưu tá gõ 'boom' ⇒ khách từ chối chưa rõ, KHÔNG phải boom đã xác minh");
  assert.equal(evidenceGroupOf("BOOM_NO_REASON", "CARE_NOTE"), "BOM_DA_XAC_MINH", "nhân viên đã hỏi khách ⇒ được kết luận boom");
  assert.equal(evidenceGroupOf("DAMAGED", "CARRIER_TEXT"), "KHACH_TU_CHOI_CHUA_RO", "ĐVVC ghi 'hư hỏng' chưa phải shop đã mở kiện xem");

  /* "Không liên lạc được" KHÔNG BAO GIỜ là giao chậm — ai nói cũng vậy. */
  for (const src of REASON_SOURCES) {
    assert.equal(evidenceGroupOf("CUSTOMER_UNREACHABLE", src), "KHONG_LIEN_LAC", `${src}: không liên lạc được phải ở nhóm của nó`);
    assert.notEqual(evidenceGroupOf("CUSTOMER_RESCHEDULE_FAILED", src), "GIAO_CHAM_XAC_NHAN", "hẹn lại không thành KHÔNG phải giao chậm");
  }
  /* Giao chậm chỉ khi có người xác nhận HOẶC chứng cứ thời gian. */
  assert.equal(evidenceGroupOf("SLOW_DELIVERY", "PANCAKE_ORDER_NOTE"), "LY_DO_KHAC");
  assert.equal(evidenceGroupOf("SLOW_DELIVERY", "PANCAKE_ORDER_NOTE", { slowByTime: true }), "GIAO_CHAM_XAC_NHAN", "có chứng cứ thời gian ⇒ được nói giao chậm");
  assert.equal(evidenceGroupOf("SLOW_DELIVERY", "PANCAKE_ORDER_NOTE", { slowByTime: null }), "LY_DO_KHAC", "chưa đo thời gian (null) ≠ đã đo được chậm");
  assert.equal(evidenceGroupOf("SLOW_DELIVERY", "HUMAN_CONFIRMED"), "GIAO_CHAM_XAC_NHAN");

  /* Phòng ban dẫn xuất từ CÙNG bảng; nhóm chưa đủ căn cứ không chỉ phòng nào (mục 24). */
  assert.equal(evidenceGroupDepartment("KHACH_TU_CHOI_CHUA_RO"), null, "khách từ chối chưa rõ ⇒ chưa được chỉ phòng nào");
  assert.equal(evidenceGroupDepartment("SAI_HANG"), null, "sai hàng gồm kho đóng sai lẫn sale chốt sai ⇒ không đổ cho một phòng");
  assert.equal(evidenceGroupDepartment("CHAT_LUONG"), null, "chất lượng: sản phẩm (xưởng) lẫn hư hỏng (kho) ⇒ xổ ra mới thấy");
  assert.equal(evidenceGroupDepartment("KHONG_LIEN_LAC"), "SALES");
  assert.equal(evidenceGroupDepartment("CHUA_XAC_DINH"), null);

  /* Cờ: chuỗi lạ / thiếu ⇒ cách đọc ĐANG CHẠY, không bao giờ cách mới. */
  assert.equal(parseReasonTaxonomy("EVIDENCE"), "EVIDENCE");
  for (const x of [undefined, null, "", "evidence", 1, {}]) assert.equal(parseReasonTaxonomy(x), "LEGACY");

  /* Mã ĐVVC đọc lại được từ chữ gốc của quan sát CARRIER_CODE (lỗi b). */
  assert.equal(vtpCodeOfObservation("CARRIER_CODE", carrierCodeText(36)), 36);
  assert.equal(vtpCodeOfObservation("CARRIER_TEXT", carrierCodeText(36)), null, "chỉ nguồn mã mới mang mã");
  assert.equal(vtpCodeOfObservation("CARRIER_CODE", "Mã lý do ĐVVC 36 — kèm chữ"), null, "không đoán mã từ một câu khác dạng");
  console.log(`✓ Nhóm theo chứng cứ: ${EVIDENCE_GROUPS.length} nhóm · lời ĐVVC không vào nhóm quy lỗi · không liên lạc ≠ giao chậm · phòng dẫn xuất từ cùng bảng · cờ lạ ⇒ LEGACY`);
}

/* ───── 2 · Một đơn, một nguyên nhân chính; mâu thuẫn được NÓI RA ───── */
export function testEvidenceResolution() {
  /* Ca chủ shop nêu: ĐVVC "không có nhu cầu" + chăm sóc "chê vải mỏng" ⇒ CHẤT LƯỢNG (nguồn có thẩm quyền). */
  const a = resolveEvidence([it("CARRIER_TEXT", "CUSTOMER_CHANGED_MIND", 1), it("CARE_NOTE", "QUALITY_FABRIC_THIN", 2)]);
  assert.equal(a.primary?.group, "CHAT_LUONG");
  assert.equal(a.tier, "CARE_REPORTED", "nhân viên ghi nhận — CHƯA phải người xác nhận");
  assert.deepEqual(a.secondary.map((x) => x.group), ["KHACH_DOI_Y"], "lời ĐVVC vẫn được giữ làm nguyên nhân phụ, không bị xoá");

  /* Hai nguồn nói hai nhóm, không nhóm nào cần thẩm quyền ⇒ MÂU THUẪN, vẫn một nguyên nhân chính để đếm. */
  const b = resolveEvidence([it("CARRIER_TEXT", "CUSTOMER_REFUSED", 3), it("CARE_NOTE", "CUSTOMER_UNREACHABLE", 1)]);
  assert.equal(b.tier, "CONFLICTED");
  assert.equal(b.primary?.group, "KHONG_LIEN_LAC", "nguồn hạng cao vẫn là nguyên nhân chính — cộng các nhóm luôn bằng tổng");
  assert.deepEqual(b.secondary.map((x) => x.group), ["KHACH_TU_CHOI_CHUA_RO"]);

  /* Người xác nhận thắng — nhưng lời nhân viên khác ý vẫn còn. */
  const c = resolveEvidence([it("CARE_NOTE", "QUALITY_FABRIC_THIN", 9), it("HUMAN_CONFIRMED", "SIZE_TIGHT", 2), it("CARRIER_TEXT", "CUSTOMER_REFUSED", 1)]);
  assert.equal(c.tier, "HUMAN_CONFIRMED");
  assert.equal(c.primary?.reason, "SIZE_TIGHT", "người xác nhận thắng ghi chú chăm sóc MUỘN HƠN");
  assert.deepEqual(c.secondary.map((x) => x.group).sort(), ["CHAT_LUONG", "KHACH_TU_CHOI_CHUA_RO"], "cả hai lời khác ý đều được giữ");

  /* Hai người xác nhận: lần muộn hơn thắng. */
  assert.equal(resolveEvidence([it("HUMAN_CONFIRMED", "SIZE_TIGHT", 1), it("HUMAN_CONFIRMED", "SIZE_LOOSE", 2)]).primary?.reason, "SIZE_LOOSE");

  /* Cùng HỌ nguồn đổi lời theo thời gian KHÔNG phải mâu thuẫn. */
  const d = resolveEvidence([it("CARRIER_TEXT", "CUSTOMER_UNREACHABLE", 1), it("CARRIER_TEXT", "CUSTOMER_REFUSED", 2)]);
  assert.equal(d.tier, "CARRIER_OBSERVED");
  assert.equal(d.primary?.reason, "CUSTOMER_REFUSED", "lời muộn hơn của cùng nguồn thắng");
  assert.equal(d.secondary.length, 0);
  /* Mã có cấu trúc thắng chữ của chính ĐVVC, kể cả chữ muộn hơn. */
  assert.equal(resolveEvidence([it("CARRIER_CODE", "WRONG_PHONE", 1), it("CARRIER_TEXT", "CUSTOMER_REFUSED", 5)]).primary?.reason, "WRONG_PHONE");

  /* Ghi chú chung chung (UNKNOWN) không đè được gì, và không tạo mâu thuẫn. */
  const e = resolveEvidence([it("CARRIER_TEXT", "CUSTOMER_UNREACHABLE", 1), it("CARE_NOTE", "UNKNOWN", 5)]);
  assert.equal(e.primary?.group, "KHONG_LIEN_LAC");
  assert.equal(e.tier, "CARRIER_OBSERVED");
  assert.deepEqual(resolveEvidence([]), { primary: null, secondary: [], tier: "UNKNOWN" });
  assert.equal(resolveEvidence([it("CARE_NOTE", "UNKNOWN", 1)]).tier, "UNKNOWN");

  /* Chạy hai lần, đảo thứ tự đầu vào ⇒ cùng kết quả. */
  const ds = [it("CARRIER_TEXT", "CUSTOMER_REFUSED", 3), it("CARE_NOTE", "CUSTOMER_UNREACHABLE", 1), it("CARRIER_CODE", "WRONG_ADDRESS", 2)];
  assert.deepEqual(resolveEvidence(ds), resolveEvidence([...ds].reverse()), "kết quả không được phụ thuộc thứ tự đọc từ CSDL");
  console.log("✓ Giải chứng cứ: thẩm quyền thắng · mâu thuẫn được nói ra mà vẫn một nguyên nhân chính · người thắng nhưng không xoá · cùng nguồn đổi lời ≠ mâu thuẫn");
}

/* ───── 3 · Ghi đè nhóm cũ: chỉ chuyển khi nghĩa không đổi; không bao giờ kéo lời ĐVVC vào nhóm quy lỗi ───── */
export function testEvidenceOverrideTransition() {
  const { applied, unmappable } = transitionGroupOverrides({ CUSTOMER_UNREACHABLE: "BOOM", DUPLICATE_ORDER: "QUALITY", WRONG_ITEM: "SLOW" });
  assert.deepEqual(applied, { DUPLICATE_ORDER: "CHAT_LUONG" });
  assert.deepEqual(unmappable.map((u) => u.reason).sort(), ["CUSTOMER_UNREACHABLE", "WRONG_ITEM"], "giao lâu / boom cũ gộp quan sát với kết luận — không dịch tự động");
  assert.equal(evidenceGroupOf("CUSTOMER_REFUSED", "CARRIER_TEXT", { overrides: { CUSTOMER_REFUSED: "CHAT_LUONG" } }), "KHACH_TU_CHOI_CHUA_RO", "ghi đè không được kéo lời ĐVVC vào nhóm quy lỗi");

  const ghiDe = { CUSTOMER_UNREACHABLE: "BOOM" } as const;
  const g = buildReasonGrouping("EVIDENCE", reasonGroupTable(ghiDe), ghiDe);
  assert.equal(g.notes.length, 1, "ghi đè không chuyển được phải HIỆN RA màn hình");
  assert.ok(g.notes[0].includes("CUSTOMER_UNREACHABLE"));
  assert.equal(buildReasonGrouping("LEGACY", reasonGroupTable(ghiDe), ghiDe).notes.length, 0, "cách xếp cũ không có gì phải báo");
  assert.equal(g.groupOf({ reason: "CUSTOMER_UNREACHABLE", items: [it("CARRIER_TEXT", "CUSTOMER_UNREACHABLE", 1)] }), "KHONG_LIEN_LAC", "ghi đè không chuyển được ⇒ theo bảng mặc định");
  assert.equal(g.groupOf({ reason: "UNKNOWN", items: [] }), null, "chỗ trống không vào bảng nhóm");
  assert.ok(!g.groups.some((x) => x.key === "CHUA_XAC_DINH"), "chưa xác định là ô độ phủ, không phải một nhóm của bảng");

  /* Ô chọn lý do xếp theo cách xếp đang bật (lỗi g). */
  const chon = reasonPickerGroups(g, RETURN_REASONS);
  assert.ok(chon.find((x) => x.key === "CHAT_LUONG")?.reasons.includes("QUALITY_FABRIC_THIN"));
  assert.ok(!chon.some((x) => x.reasons.includes("UNKNOWN") || x.reasons.includes("OTHER")), "chỗ trống không phải lựa chọn");
  const cu = reasonPickerGroups(buildReasonGrouping("LEGACY", reasonGroupTable(ghiDe), ghiDe), RETURN_REASONS);
  assert.ok(cu.find((x) => x.key === "BOOM")?.reasons.includes("CUSTOMER_UNREACHABLE"), "ô chọn phải đi theo ghi đè của chủ shop, không theo bảng tĩnh");
  console.log("✓ Ghi đè nhóm cũ: chuyển tường minh · không chuyển được thì hiện ra · không kéo lời ĐVVC vào nhóm quy lỗi · ô chọn theo cách xếp đang bật");
}

/* ───── 4 · Một sự việc, một khoá — webhook, lượt rút và action dựng CÙNG chữ (lỗi a, d) ───── */
export function testEvidenceObservationShapes() {
  const at = new Date("2026-09-01T00:00:00Z");
  const webhook = carrierEventObservations({ shipmentId: "s", orderId: "o", statusName: "Tồn - Khách từ chối nhận", note: "khách bảo không đặt", at, sourceRef: "vtp:WEBHOOK" });
  const backfill = carrierEventObservations({ shipmentId: "s", orderId: "o", statusName: "Tồn - Khách từ chối nhận ", note: " khách bảo không đặt", at, sourceRef: "shipment_events:e1" });
  assert.equal(webhook.length, 2, "trạng thái và ghi chú là HAI quan sát — bản cũ nối thành một dòng nên không bao giờ khớp lượt rút");
  assert.deepEqual(webhook.map(reasonDedupeKey), backfill.map(reasonDedupeKey), "webhook và lượt rút phải ra CÙNG khoá cho cùng sự kiện");
  assert.ok(webhook.every((q) => q.vtpCode === undefined), "chữ của từng bước không mang mã lý do — mã là quan sát riêng");
  const ma = carrierCodeObservation({ shipmentId: "s", orderId: "o", code: 36, at, sourceRef: "x" });
  assert.equal(reasonDedupeKey(ma), reasonDedupeKey(carrierCodeObservation({ shipmentId: "s", orderId: "o", code: 36, at, sourceRef: "y" })));

  const nguoi = humanReasonObservation({ shipmentId: "s", reason: "SIZE_TIGHT", note: " chật vai ", at, actorId: "u1", actorEmail: "a@x", sourceRef: "action:setReturnReason" });
  const nguoiRut = humanReasonObservation({ shipmentId: "s", reason: "SIZE_TIGHT", note: "chật vai", at, actorId: "u1", actorEmail: "a@x", sourceRef: "shipment_return_reasons:1" });
  assert.equal(reasonDedupeKey(nguoi), reasonDedupeKey(nguoiRut), "action và lượt rút dựng CÙNG chữ cho cùng một lần xác nhận");
  assert.equal(nguoi.chosenReason, "SIZE_TIGHT", "lựa chọn của người đi kèm, không để máy đọc lại nhãn");

  /*
    BẤM LẠI ĐÚNG LÝ DO CŨ = KHÔNG GHI (lỗi a). Khoá chứa mốc, nên chỉ có một cách để hai cú bấm ra
    MỘT quan sát: cú thứ hai không ghi gì. Kiểm ở mức mã nguồn rằng phép so đứng TRƯỚC mọi lệnh ghi.
  */
  const nguon = readFileSync("lib/actions/return-reason.ts", "utf8");
  const so = nguon.indexOf("daCo.reason === reason");
  assert.ok(so > 0, "setReturnReason phải so với kết luận đang có trước khi ghi");
  assert.ok(so < nguon.indexOf("insert(schema.shipmentReturnReasons") && so < nguon.indexOf("ghiQuanSat("), "phép so phải đứng TRƯỚC lệnh ghi kết luận và lệnh ghi quan sát");
  assert.ok(!nguon.includes("occurredAt: new Date()"), "mốc quan sát phải là mốc của dòng kết luận, không phải một new Date() thứ hai");
  assert.ok(!nguon.includes("RETURN_REASON_GROUP_OF[reason]"), "ảnh chụp nhóm theo cách xếp đang chạy, không theo bảng tĩnh (lỗi g)");

  const sync = readFileSync("lib/integrations/viettelpost/sync.ts", "utf8");
  assert.ok(!sync.includes('.filter(Boolean).join(" — ")'), "webhook không được nối trạng thái + ghi chú thành một quan sát");
  const care = readFileSync("lib/care/service.ts", "utf8");
  assert.ok((care.match(/ghiQuanSatChamSoc\(/g) ?? []).length >= 4, "mọi đường ghi note của ca chăm sóc phải để lại quan sát CARE_NOTE");
  console.log("✓ Hình dạng quan sát: webhook = lượt rút (hai dòng, cùng khoá) · mã lý do là quan sát riêng · bấm lại không ghi · ghi chú chăm sóc vào sổ ngay");
}

/* ───── 5 · Trên CSDL: bảy lỗi + tổng hoàn KHÔNG đổi khi bật cờ ───── */
const P = "rre-";
const KY = (from: string, to: string): Period => ({ key: "custom", label: "thử", from: new Date(from), to: new Date(to), fromKey: from, toKey: to });

export async function testEvidenceOnDb(db: Db) {
  const KIEN = [1, 2, 3, 4, 5, 6, 7].map((i) => `${P}s${i}`);
  const DON = [1, 2, 3, 4, 5, 6, 7].map((i) => `${P}o${i}`);
  const t = (ngay: number) => new Date(Date.UTC(2026, 7, ngay, 3, 0, 0));
  const don: { stage: "RETURNED" | "DELIVERED"; status: string; cod: number }[] = [
    { stage: "RETURNED", status: "Tồn - Khách hàng nghỉ, không có nhà", cod: 0 },
    { stage: "RETURNED", status: "Tồn - Khách từ chối nhận", cod: 0 },
    { stage: "RETURNED", status: "Tồn - Khách từ chối nhận", cod: 0 },
    { stage: "RETURNED", status: "Tồn - Khách từ chối nhận", cod: 0 },
    { stage: "RETURNED", status: "Đã trả", cod: 0 },
    { stage: "RETURNED", status: "Đã trả", cod: 0 },
    { stage: "DELIVERED", status: "Giao thành công", cod: 500_000 },
  ];
  await db.insert(schema.products).values({ id: `${P}p1`, name: "Đầm RRE", customId: "RRE1", isRemoved: false }).onConflictDoNothing();
  await db.insert(schema.productVariants).values({ id: `${P}v1`, productId: `${P}p1`, sku: "RRE1-S", detail: "S" }).onConflictDoNothing();
  for (const [i, d] of don.entries()) {
    const so = i + 1;
    await db.insert(schema.orders).values({ id: `${P}o${so}`, stage: "CONFIRMED", status: 2, insertedAt: t(10), totalPriceAfterDiscount: 500_000, billFullName: `RRE ${so}`, billPhone: "0900000000" }).onConflictDoNothing();
    await db.insert(schema.orderItems).values({ id: `${P}i${so}`, orderId: `${P}o${so}`, variantId: `${P}v1`, sku: "RRE1-S", productName: "Đầm RRE", quantity: 1, lineTotal: 500_000, isBonus: false }).onConflictDoNothing();
    await db
      .insert(schema.shipments)
      .values({
        id: `${P}s${so}`,
        orderId: `${P}o${so}`,
        vtpOrderNumber: `${P}T${so}`,
        trackingCode: `${P}T${so}`,
        stage: d.stage,
        vtpStatusName: d.status,
        vtpStatusDate: t(24),
        codCollected: d.cod,
        pickedUpAt: t(20),
        deliveredAt: d.stage === "DELIVERED" ? t(24) : null,
        returnedAt: d.stage === "RETURNED" ? t(24) : null,
        createdAt: t(10),
        isFinal: true,
      })
      .onConflictDoNothing();
    await db.insert(schema.shipmentEvents).values({ id: `${P}e${so}`, shipmentId: `${P}s${so}`, source: "VTP_WEBHOOK", status: "300", statusName: d.status, normalizedStage: d.stage, occurredAt: t(20) }).onConflictDoNothing();
  }
  const q = (shipmentId: string | null, orderId: string | null, source: string, rawText: string, ngay: number, reasonAtWrite = "UNKNOWN") => ({
    shipmentId,
    orderId,
    source,
    rawText,
    reasonAtWrite,
    occurredAt: t(ngay),
    dedupeKey: `${P}${shipmentId ?? orderId}|${source}|${ngay}`,
  });
  await db.insert(schema.returnReasonObservations).values([
    // s2: ĐVVC "từ chối" + chăm sóc "chê vải mỏng" ⇒ chất lượng (nhân viên ghi nhận, CHƯA xác nhận).
    q(`${P}s2`, `${P}o2`, "CARE_NOTE", "khách chê vải mỏng", 22),
    // s3: ĐVVC "từ chối" + chăm sóc "không liên lạc được" ⇒ MÂU THUẪN.
    q(`${P}s3`, `${P}o3`, "CARE_NOTE", "gọi 3 lần không liên lạc được khách", 22),
    // s4: người đã xác nhận (bảng kết luận, KHÔNG có quan sát người) + ghi chú chăm sóc MUỘN HƠN nói khác (lỗi f).
    q(`${P}s4`, `${P}o4`, "CARE_NOTE", "khách chê vải mỏng", 26),
    // s5: phiếu đổi trả Pancake gắn ĐƠN, không gắn kiện (lỗi c).
    q(null, `${P}o5`, "PANCAKE_RETURN", "Khách từ chối nhận hàng", 23),
    // s6: mã lý do ĐVVC lưu thành quan sát (lỗi b).
    q(`${P}s6`, `${P}o6`, "CARRIER_CODE", carrierCodeText(36), 23),
  ]);
  await db.insert(schema.shipmentReturnReasons).values({ shipmentId: `${P}s4`, reason: "SIZE_TIGHT", reasonGroup: "SIZE", source: "MANUAL", confidence: "CONFIRMED", actorEmail: "cs@shop.vn", updatedAt: t(21), createdAt: t(21) });

  try {
    const ra = await reasonsForShipments(KIEN);
    const v = (i: number) => {
      const x = ra.get(`${P}s${i}`);
      assert.ok(x, `thiếu kết luận cho s${i}`);
      return x;
    };
    assert.equal(v(2).reason, "QUALITY_FABRIC_THIN");
    assert.equal(v(2).confidence, "STAFF_REPORTED", "ghi chú chăm sóc KHÔNG được mang nhãn 'Người xác nhận' (lỗi e)");
    assert.equal(v(2).manual, false, "ghi chú chăm sóc không phải một lần người bấm xác nhận");
    assert.equal(v(4).reason, "SIZE_TIGHT", "ghi chú chăm sóc muộn hơn KHÔNG được đè kết luận người đã chốt (lỗi f)");
    assert.equal(v(4).confidence, "CONFIRMED");
    assert.ok(v(4).items.some((x) => x.source === "CARE_NOTE"), "lời khác ý vẫn còn trong danh sách lời khai");
    assert.equal(v(5).reason, "CUSTOMER_REFUSED", "quan sát chỉ gắn đơn phải được đọc (lỗi c)");
    assert.equal(v(5).confidence, "EXTERNAL_TEXT", "chữ Pancake không mang nhãn ĐVVC");
    assert.equal(v(6).reason, "CUSTOMER_UNREACHABLE", "quan sát mã lý do phải xếp được bằng mã (lỗi b)");
    assert.equal(v(6).confidence, "CARRIER_CODE");

    /* ─── HAI CÁCH XẾP, CÙNG TẬP CA ─── */
    const loc = { period: KY("2026-08-18T00:00:00Z", "2026-08-28T23:59:59Z"), basis: "SHIPPED" as const, codes: ["RRE1"] };
    clearMemo();
    const cu = await getReturnReasonReport({ ...loc, taxonomy: "LEGACY" });
    const moi = await getReturnReasonReport({ ...loc, taxonomy: "EVIDENCE" });
    const tong = (bc: typeof cu) => bc.groups.reduce((n, g) => n + g.count, 0) + bc.reasonCoverage.unknown;
    assert.equal(cu.returned, 6);
    assert.equal(moi.returned, cu.returned, "bật cách xếp mới KHÔNG được đổi tổng ca hoàn");
    assert.equal(moi.finished, cu.finished);
    assert.equal(tong(cu), cu.returned, "cách cũ: nhóm + chưa xác định = tổng");
    assert.equal(tong(moi), moi.returned, "cách mới: nhóm + chưa xác định = tổng");
    assert.equal(Object.values(moi.evidenceTiers).reduce((a, b) => a + b, 0), moi.returned, "bậc chứng cứ cộng lại = tổng ca hoàn");
    assert.equal(cu.taxonomy, "LEGACY");
    assert.equal(moi.taxonomy, "EVIDENCE");

    const nhom = (bc: typeof cu, key: string) => bc.groups.find((g) => g.group === key);
    assert.equal(nhom(cu, "SLOW")?.details.find((d) => d.reason === "CUSTOMER_UNREACHABLE")?.count, 3, "cờ TẮT: số cũ y nguyên — không liên lạc vẫn ở nhóm giao lâu");
    assert.equal(nhom(moi, "KHONG_LIEN_LAC")?.count, 3, "cờ BẬT: không liên lạc (s1 · s3 · s6) đứng riêng, KHÔNG ở giao chậm");
    assert.equal(nhom(moi, "GIAO_CHAM_XAC_NHAN")?.count ?? 0, 0, "không ca nào có chứng cứ giao chậm");
    assert.equal(nhom(moi, "CHAT_LUONG")?.count, 1, "s2: chất lượng do nhân viên ghi nhận");
    assert.equal(nhom(moi, "CHAT_LUONG")?.tiers.CARE_REPORTED, 1);
    assert.equal(nhom(moi, "SAI_SIZE")?.tiers.HUMAN_CONFIRMED, 1, "s4: người xác nhận");
    assert.equal(nhom(moi, "KHACH_TU_CHOI_CHUA_RO")?.count, 1, "s5: khách từ chối — chưa rõ vì sao, KHÔNG phải boom");
    assert.equal(nhom(moi, "BOM_DA_XAC_MINH")?.count ?? 0, 0, "không ai xác minh boom ⇒ nhóm boom rỗng");
    assert.equal(moi.evidenceTiers.CONFLICTED, 1, "s3: hai nguồn nói khác nhau phải được đếm là mâu thuẫn");

    /* Bấm vào nhóm / dòng ra đúng số ca bảng in. */
    for (const g of moi.groups) {
      if (!g.count) continue;
      const dong = await listReasonShipments({ ...loc, taxonomy: "EVIDENCE", group: g.group });
      assert.equal(dong.length, g.count, `nhóm ${g.group}: drilldown ${dong.length} ≠ bảng ${g.count}`);
      for (const d of g.details.filter((x) => x.count)) {
        assert.equal((await listReasonShipments({ ...loc, taxonomy: "EVIDENCE", group: g.group, reason: d.reason })).length, d.count, `${g.group}/${d.reason}: drilldown ≠ bảng`);
      }
    }

    /* Cờ thật trong settings đổi cách xếp của lượt đọc không ép — và nằm trong khoá nhớ đệm. */
    await setSettingJson(REASON_TAXONOMY_KEY, "EVIDENCE");
    clearMemo();
    assert.equal((await getReturnReasonReport(loc)).taxonomy, "EVIDENCE");
    await setSettingJson(REASON_TAXONOMY_KEY, "LEGACY");
    clearMemo();
    assert.equal((await getReturnReasonReport(loc)).taxonomy, "LEGACY", "đặt lại LEGACY là về số cũ — đảo ngược được");
  } finally {
    await setSettingJson(REASON_TAXONOMY_KEY, "LEGACY");
    clearMemo();
    await db.delete(schema.returnReasonObservations).where(inArray(schema.returnReasonObservations.orderId, DON));
    await db.delete(schema.shipmentReturnReasons).where(inArray(schema.shipmentReturnReasons.shipmentId, KIEN));
    await db.delete(schema.shipmentEvents).where(inArray(schema.shipmentEvents.shipmentId, KIEN));
    await db.delete(schema.shipments).where(inArray(schema.shipments.id, KIEN));
    await db.delete(schema.orderItems).where(inArray(schema.orderItems.orderId, DON));
    await db.delete(schema.orders).where(inArray(schema.orders.id, DON));
  }
  console.log("✓ Lý do theo chứng cứ trên CSDL: bảy lỗi đã vá · tổng hoàn trước = sau · cờ tắt = số cũ · không liên lạc ≠ giao chậm · từ chối ≠ boom · mâu thuẫn đếm được · drilldown = bảng");
}

/** Chủ thể của mục 0 trong đặc tả: nguồn có thẩm quyền khai ở MỘT chỗ — bảng mới không khai lại. */
export function testEvidenceUsesOneAuthorityTable() {
  const src = readFileSync("lib/constants/return-reason-evidence.ts", "utf8");
  assert.ok(src.includes("SOURCE_CAN_CONCLUDE_SHOP_FAULT[source]"), "thẩm quyền đọc từ return-reason-source, không khai bảng thứ hai");
  assert.ok(Object.values(SOURCE_CAN_CONCLUDE_SHOP_FAULT).some(Boolean));
  console.log("✓ Thẩm quyền nguồn: một bảng duy nhất (return-reason-source)");
}
