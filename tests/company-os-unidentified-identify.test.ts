import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { and, eq, inArray, like, or, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import { DOMAIN_EVENT_BY_NAME, domainEventLabel } from "@/lib/constants/domain-events";
import { checkVariantIdentify, unidentifiedStockReceived, VARIANT_FIX_ADJUSTMENT_HREF } from "@/lib/constants/return-unidentified";
import { getModelReturnDispositions } from "@/lib/queries/model-returns";
import { domainEventDimension } from "@/lib/queries/models";
import { unassignedUnidentifiedDispositions } from "@/lib/queries/return-dispositions";
import { setReturnDispositionCore, type DispositionGate } from "@/lib/returns/disposition";
import {
  createUnidentifiedReturn,
  identifyUnidentifiedVariant,
  listUnidentifiedReturns,
  restockUnidentifiedReturn,
  setUnidentifiedCondition,
  unidentifiedSummary,
  variantsOfProductCode,
} from "@/lib/returns/unidentified";

/**
 * ═══════════ COMPANY OS · AGENT U — XÁC ĐỊNH MẪU MÃ CỦA MÓN HÀNG HOÀN KHÔNG NHÃN SAU KHI NHẬN ═══════════
 *
 * Khoá bảy điều:
 *  1. Gán mẫu mã là lời xác nhận của NGƯỜI: ghi mẫu + ai (khoá tài khoản, luật 34) + lúc nào + ghi chú;
 *     không có tài khoản thì không xác nhận được.
 *  2. Đổi mẫu đã gán: chỉ khi món CHƯA có hàng vào tồn (không phiếu nguyên món, không dòng
 *     `RESTOCK_AFTER_REWORK`), và BẮT BUỘC lý do. Sau đó chặn — thông điệp trỏ phiếu điều chỉnh.
 *  3. Gán KHÔNG ghi một dòng kho / sổ kết cục nào (hàng hoàn không tự vào tồn — luật 4, 10); nó chỉ mở
 *     các đường vào tồn đã có (tái nhập nguyên món · sửa xong → nhập lại) với luật quyền + lý do của chúng.
 *  4. Tóm tắt theo mẫu chuyển món từ "không nhãn, chưa gán mẫu" sang ĐÚNG mẫu.
 *  5. Dòng bàn không nhãn in số món CÒN GIỮ TẠM (một biểu thức với tiêu đề bàn).
 *  6. `return.variant_identified` LIVE, cùng giao dịch, chiều INVENTORY, không phát khi chọn lại đúng mẫu.
 *  7. Quyền: action đòi `inventory:write` (cùng bàn không nhãn); không có đường thứ hai ghi mẫu mã.
 *
 * Không phụ thuộc đồng hồ (luật 50, 65): mốc gieo cố định; không khẳng định nào lọc theo "N ngày trước";
 * con số toàn cục đo bằng HIỆU trước / sau.
 */

const P = "cosu-";
const DAY0 = new Date("2026-03-10T03:00:00Z");
const boChuThich = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** Thân một hàm export trong tệp nguồn — từ chữ ký tới hàm export kế tiếp (hoặc hết tệp). */
function thanHam(src: string, ten: string): string {
  const i = src.indexOf(`export async function ${ten}(`);
  assert.ok(i >= 0, `không thấy hàm ${ten}`);
  const j = src.indexOf("\nexport ", i + 10);
  return src.slice(i, j < 0 ? undefined : j);
}

export function testCompanyOsUnidentifiedIdentifyPure() {
  // ───────── Bảng chân lý của luật xác định mẫu mã ─────────
  const gan = checkVariantIdentify({ current: null, next: "v1", stockReceived: false, note: "" });
  assert.deepEqual(gan, { ok: true, kind: "ASSIGN", note: "" }, "gán lần đầu: ghi chú không bắt buộc");
  const thieu = checkVariantIdentify({ current: null, next: "  ", stockReceived: false, note: "x" });
  assert.ok("error" in thieu && thieu.code === "NO_VARIANT");
  assert.deepEqual(checkVariantIdentify({ current: "v1", next: "v1", stockReceived: true, note: "" }), { ok: true, kind: "SAME", note: "" }, "chọn lại đúng mẫu ⇒ không làm gì, kể cả khi đã có tồn");
  const doiKhongLyDo = checkVariantIdentify({ current: "v1", next: "v2", stockReceived: false, note: "   " });
  assert.ok("error" in doiKhongLyDo && doiKhongLyDo.code === "NEEDS_REASON", "đổi mẫu đã gán ⇒ bắt buộc lý do");
  assert.deepEqual(checkVariantIdentify({ current: "v1", next: "v2", stockReceived: false, note: " tem ghi L " }), { ok: true, kind: "CHANGE", note: "tem ghi L" });
  const daCoTon = checkVariantIdentify({ current: "v1", next: "v2", stockReceived: true, note: "có lý do" });
  assert.ok("error" in daCoTon && daCoTon.code === "STOCK_RECEIVED" && daCoTon.error.includes(VARIANT_FIX_ADJUSTMENT_HREF), "đã có tồn ⇒ chặn, trỏ phiếu điều chỉnh");
  const daCoTonKhongLyDo = checkVariantIdentify({ current: "v1", next: "v2", stockReceived: true, note: "" });
  assert.ok("error" in daCoTonKhongLyDo && daCoTonKhongLyDo.code === "STOCK_RECEIVED", "chặn vì tồn TRƯỚC lý do");
  const ganKhiCoPhieu = checkVariantIdentify({ current: null, next: "v2", stockReceived: true, note: "" });
  assert.ok("error" in ganKhiCoPhieu && ganKhiCoPhieu.code === "STOCK_RECEIVED", "mẫu cũ bị xoá khỏi danh mục mà phiếu còn ⇒ gán cũng phải đi phiếu điều chỉnh");
  const cu = checkVariantIdentify({ current: "v1", next: "v2", stockReceived: false, note: "x", expectedCurrent: null });
  assert.ok("error" in cu && cu.code === "STALE", "người bấm nhìn thấy 'chưa gán' mà CSDL đã có mẫu ⇒ từ chối");
  assert.ok("ok" in checkVariantIdentify({ current: null, next: "v2", stockReceived: false, note: "", expectedCurrent: null }), "khai đúng mẫu đang lưu ⇒ đi tiếp");
  assert.equal(unidentifiedStockReceived({ stockReceiptId: null, reworkRestockRows: 0 }), false);
  assert.equal(unidentifiedStockReceived({ stockReceiptId: "rc", reworkRestockRows: 0 }), true, "tái nhập nguyên món = đã có tồn");
  assert.equal(unidentifiedStockReceived({ stockReceiptId: null, reworkRestockRows: 1 }), true, "nhập lại sau sửa = đã có tồn");

  // ───────── Migration 0144: bốn cột NULL được, không backfill, mốc Tech Lead cấp ─────────
  const mig = readFileSync("drizzle/0144_company_os_unidentified_identify.sql", "utf8");
  for (const c of ["variant_identified_at", "variant_identified_by", "variant_identified_by_user_id", "variant_identify_note"]) {
    assert.ok(new RegExp(`ADD COLUMN IF NOT EXISTS "${c}" [a-z ]+;`).test(mig), `0144 phải thêm ${c} (idempotent, không NOT NULL / DEFAULT)`);
  }
  assert.ok(!/(DEFAULT|NOT NULL)/i.test(mig.replace(/--.*$/gm, "")), "0144: không DEFAULT, không NOT NULL — dòng cũ là CHƯA BIẾT");
  assert.ok(!/(^|;|\s)(INSERT INTO|UPDATE\s+"?return_unidentified)/im.test(mig.replace(/--.*$/gm, "")), "0144 không gieo / sửa dòng nào (mục 8.8, 35)");
  const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as { entries: { tag: string; when: number }[] };
  const e144 = journal.entries.find((e) => e.tag === "0144_company_os_unidentified_identify");
  assert.ok(e144 && e144.when === 1790006483765, "sổ migration phải có 0144 đúng mốc Tech Lead cấp");

  // ───────── Sự kiện: LIVE, đúng tệp, chiều INVENTORY, có nhãn ─────────
  const ev = DOMAIN_EVENT_BY_NAME["return.variant_identified"];
  assert.ok(ev && ev.status === "LIVE" && ev.emitter === "lib/returns/unidentified.ts" && ev.subjectType === "return_inspection", "return.variant_identified LIVE, subject return_inspection (quy ước của R)");
  assert.equal(domainEventDimension("return.variant_identified"), "INVENTORY");
  assert.notEqual(domainEventLabel("return.variant_identified"), "return.variant_identified", "sự kiện LIVE phải có nhãn tiếng Việt");

  // ───────── Quét mã nguồn: một đường ghi mẫu mã, không chạm tồn, quyền đọc từ phiên ─────────
  const uni = boChuThich(readFileSync("lib/returns/unidentified.ts", "utf8"));
  const dinh = thanHam(uni, "identifyUnidentifiedVariant");
  assert.ok(!/schema\.stockReceipt|returnDispositions|\.insert\(|writeUnidentifiedRestockReceipt/.test(dinh), "xác định mẫu mã KHÔNG lập phiếu kho, KHÔNG ghi sổ kết cục");
  assert.ok(/\.for\("update"\)/.test(dinh) && /unidentifiedReworkRestockRows\(tx,/.test(dinh), "khoá dòng món rồi đọc sổ TRONG khoá");
  assert.ok(/checkVariantIdentify\(/.test(dinh), "dùng CHÍNH luật thuần");
  const doiKetLuan = thanHam(uni, "setUnidentifiedCondition");
  assert.ok(!/variantId/.test(doiKetLuan), "đổi kết luận KHÔNG còn là cửa thứ hai ghi mẫu mã");
  const ghiMau = [...uni.matchAll(/variantIdentifiedAt:\s*now/g)].length;
  assert.equal(ghiMau, 2, "chỉ hai chỗ ghi người xác nhận: lúc nhận kiện và identifyUnidentifiedVariant");
  assert.equal((uni.match(/HOLDING_QTY_SQL/g) ?? []).length, 3, "một biểu thức 'còn giữ tạm' cho tiêu đề bàn và từng dòng (khai + hai chỗ dùng)");
  const act = boChuThich(readFileSync("lib/actions/returns-unidentified.ts", "utf8"));
  for (const ten of ["identifyUnidentifiedVariantAction", "variantsOfProductCodeAction"]) {
    const than = thanHam(act, ten);
    assert.ok(/requireUser\(\)/.test(than) && /can\(user, "inventory:write"\)/.test(than), `${ten} phải đòi inventory:write từ phiên`);
  }
  const thanAct = thanHam(act, "identifyUnidentifiedVariantAction");
  assert.ok(thanAct.indexOf('can(user, "inventory:write")') < thanAct.indexOf("identifyUnidentifiedVariant({"), "kiểm quyền TRƯỚC khi chạm dữ liệu");
  assert.ok(/before:/.test(thanAct) && /after:/.test(thanAct), "nhật ký mang trước / sau");
  const conditionSchema = act.slice(act.indexOf("const conditionSchema"), act.indexOf("export async function setUnidentifiedConditionAction"));
  assert.ok(conditionSchema.length > 0 && !/variantId/.test(conditionSchema) && !/variantId/.test(thanHam(act, "setUnidentifiedConditionAction")), "action đổi kết luận không nhận mẫu mã");
  // Màn hình: MỘT ô chọn mẫu mã cho cả nhận kiện lẫn xác định sau.
  const ui = readFileSync("app/(dashboard)/inventory/returns/unidentified-section.tsx", "utf8");
  assert.ok(!/function VariantPicker/.test(ui) && /from "@\/app\/\(dashboard\)\/inventory\/returns\/identify-variant"/.test(ui), "bàn không nhãn dùng ô chọn chung, không giữ bản thứ hai");
  assert.ok(/row\.holdingQty/.test(ui), "dòng bàn không nhãn in số món còn giữ tạm");
  const disp = readFileSync("app/(dashboard)/inventory/returns/disposition-section.tsx", "utf8");
  assert.ok(/IdentifyVariantPanel/.test(disp), "khối Hàng hoàn không tái nhập có lối xác định mẫu mã cho món không nhãn");

  console.log("✓ Company OS · xác định mẫu mã hàng không nhãn (thuần): gán / đổi (lý do) / chọn lại · chặn khi đã có tồn (trỏ phiếu điều chỉnh) · 0144 không backfill · sự kiện LIVE chiều Kho · một đường ghi, không chạm tồn · quyền inventory:write");
}

function congMo(): DispositionGate {
  return async (input) => ({ mode: "PROCEED", recorded: true, group: input.group });
}

async function donDep(db: Db) {
  const uniIds = (await db.select({ id: schema.returnUnidentified.id, receipt: schema.returnUnidentified.stockReceiptId }).from(schema.returnUnidentified).where(or(like(schema.returnUnidentified.code, "UR-COSU-%"), eq(schema.returnUnidentified.receivedByUserId, `${P}u1`))));
  const ids = uniIds.map((r) => r.id);
  await db.delete(schema.domainEvents).where(and(inArray(schema.domainEvents.name, ["return.variant_identified", "return.disposition_set"]), like(schema.domainEvents.subjectId, "unidentified:%"), inArray(schema.domainEvents.actorId, [`${P}u1`])));
  const receipts = uniIds.map((r) => r.receipt).filter((x): x is string => Boolean(x));
  if (ids.length) {
    const rd = schema.returnDispositions;
    receipts.push(...(await db.select({ id: rd.stockReceiptId }).from(rd).where(inArray(rd.unidentifiedId, ids))).map((r) => r.id).filter((x): x is string => Boolean(x)));
    await db.delete(rd).where(inArray(rd.unidentifiedId, ids));
    await db.delete(schema.returnUnidentified).where(inArray(schema.returnUnidentified.id, ids));
  }
  if (receipts.length) await db.delete(schema.stockReceipts).where(inArray(schema.stockReceipts.id, receipts));
  await db.delete(schema.productModels).where(like(schema.productModels.id, `${P}%`));
  await db.delete(schema.products).where(like(schema.products.id, `${P}%`));
  await db.delete(schema.users).where(like(schema.users.id, `${P}%`));
}

async function demKho(db: Db) {
  const [a] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.stockReceipts);
  const [b] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.stockReceiptItems);
  const [c] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.returnDispositions);
  return { receipts: Number(a?.n ?? 0), items: Number(b?.n ?? 0), dispositions: Number(c?.n ?? 0) };
}

async function suKien(db: Db, id: string) {
  return db.select().from(schema.domainEvents).where(and(eq(schema.domainEvents.name, "return.variant_identified"), eq(schema.domainEvents.subjectId, `unidentified:${id}`)));
}

export async function testCompanyOsUnidentifiedIdentifyDb(db: Db) {
  await donDep(db);
  try {
    // ═══ Gieo (mốc cố định) ═══
    const U = `${P}u1`;
    await db.insert(schema.users).values({ id: U, email: `${P}kho@t.local`, name: "Kho kiểm thử U", role: "CS", passwordHash: "x", active: true });
    const actor = { id: U, label: "Kho kiểm thử U" };
    await db.insert(schema.products).values({ id: `${P}prod`, name: "Đầm kiểm U", customId: "COSU1" });
    await db.insert(schema.productVariants).values([
      { id: `${P}v1`, productId: `${P}prod`, sku: "COSU1-DEN-S", color: "Đen", size: "S", retailPrice: 400_000 },
      { id: `${P}v2`, productId: `${P}prod`, sku: "COSU1-DEN-M", color: "Đen", size: "M", retailPrice: 400_000 },
      { id: `${P}v3`, productId: `${P}prod`, sku: "COSU1-DO-M", color: "Đỏ", size: "M", retailPrice: 400_000, isHidden: true },
    ]);
    await db.insert(schema.productModels).values({ id: `${P}m1`, code: "COSU1", name: "Đầm kiểm U", productId: `${P}prod`, registeredBy: "USER" });
    const moc = { receivedAt: DAY0, receivedBy: "kho", source: "NO_TRACKING_LABEL" };
    await db.insert(schema.returnUnidentified).values([
      // ur1: hỏng 3 món, KHÔNG lần ra đơn, kho chưa nhận ra mẫu.
      { id: `${P}ur1`, code: "UR-COSU-1", status: "UNIDENTIFIABLE", unidentifiableReason: "tra SĐT không ra", variantId: null, quantity: 3, condition: "DAMAGED", note: "rách tà", warehouseNote: "kệ B2", ...moc },
      // ur2: còn bán được 1 món, chưa nhận ra mẫu — đường tái nhập NGUYÊN MÓN.
      { id: `${P}ur2`, code: "UR-COSU-2", status: "UNIDENTIFIABLE", unidentifiableReason: "mất nhãn", variantId: null, quantity: 1, condition: "OK", note: "", ...moc },
    ]);
    clearMemo();
    const K1 = `unidentified:${P}ur1`;
    const gate = congMo();

    // ═══ Mã hàng → màu → size ═══
    const tra = await variantsOfProductCode(" cosu1 ");
    assert.equal(tra.code, "COSU1", "mã chuẩn hoá IN HOA, bỏ khoảng trắng");
    assert.equal(tra.product?.id, `${P}prod`);
    assert.deepEqual(tra.variants.map((v) => [v.color, v.size, v.selling]), [["Đen", "M", true], ["Đen", "S", true], ["Đỏ", "M", false]], "mọi màu × size của đúng sản phẩm; mẫu ẩn VẪN hiện, đánh dấu ngừng bán");
    assert.equal((await variantsOfProductCode("KHONGCO")).product, null);

    const chuaGan0 = await unassignedUnidentifiedDispositions(db);
    const mau0 = await getModelReturnDispositions(`${P}prod`);
    assert.equal(mau0.basis.unidentifiedSubjects, 0, "chưa gán mẫu ⇒ không thuộc mẫu nào");

    // ═══ Món chưa có mẫu: sửa được, nhập lại thì chưa ═══
    const sua = await setReturnDispositionCore(db, { subjectKey: K1, disposition: "REWORK", qty: null, note: "đưa đi vá", actor, gate });
    assert.ok("ok" in sua, "chưa có mẫu vẫn đưa đi sửa được");
    const nhapSom = await setReturnDispositionCore(db, { subjectKey: K1, disposition: "RESTOCK_AFTER_REWORK", qty: 2, note: "vá xong", canRestockUnidentified: true, actor, gate });
    assert.ok("error" in nhapSom && /Xác định mẫu mã/.test(nhapSom.error), "chưa xác định mẫu ⇒ nhập lại bị chặn, chỉ đúng lối ra");

    // ═══ 1. Gán = lời xác nhận của người ═══
    const khoTruoc = await demKho(db);
    const khongNguoi = await identifyUnidentifiedVariant({ id: `${P}ur1`, variantId: `${P}v1`, note: "", actor: { id: null, label: "Bot ERP" } });
    assert.ok("error" in khongNguoi, "máy không xác nhận được món hàng trên tay ai (luật 34)");
    const khongMau = await identifyUnidentifiedVariant({ id: `${P}ur1`, variantId: "", note: "", actor });
    assert.ok("error" in khongMau);
    const mauLa = await identifyUnidentifiedVariant({ id: `${P}ur1`, variantId: `${P}khong-co`, note: "", actor });
    assert.ok("error" in mauLa && /danh mục/.test(mauLa.error));
    const gan = await identifyUnidentifiedVariant({ id: `${P}ur1`, variantId: `${P}v1`, note: "tem mác còn chữ S", expectedVariantId: null, actor });
    assert.ok("ok" in gan && gan.kind === "ASSIGN", "gán lần đầu (món đã có dòng sổ REWORK vẫn gán được)");
    const [r1] = await db.select().from(schema.returnUnidentified).where(eq(schema.returnUnidentified.id, `${P}ur1`));
    assert.equal(r1.variantId, `${P}v1`);
    assert.equal(r1.variantIdentifiedByUserId, U, "khoá tài khoản người xác nhận");
    assert.equal(r1.variantIdentifiedBy, "Kho kiểm thử U", "ảnh chụp tên do máy chủ đọc");
    assert.ok(r1.variantIdentifiedAt instanceof Date, "mốc xác nhận");
    assert.equal(r1.variantIdentifyNote, "tem mác còn chữ S");
    assert.deepEqual([r1.sku, r1.productName, r1.color, r1.size], ["COSU1-DEN-S", "Đầm kiểm U", "Đen", "S"], "ảnh chụp mẫu mã");
    assert.equal(r1.condition, "DAMAGED", "kết luận kiểm giữ nguyên");
    assert.deepEqual(await demKho(db), khoTruoc, "gán mẫu KHÔNG ghi phiếu kho, dòng phiếu hay dòng sổ kết cục nào");
    const ev1 = await suKien(db, `${P}ur1`);
    assert.equal(ev1.length, 1, "một sự kiện cho một lượt xác nhận");
    assert.equal(ev1[0].modelId, `${P}m1`, "mẫu của sản phẩm đã vào sổ mẫu");
    assert.equal(ev1[0].subjectType, "return_inspection");
    assert.equal(ev1[0].actorId, U);
    assert.equal((ev1[0].payload as Record<string, unknown>).kind, "ASSIGN");

    // Chọn lại đúng mẫu: không ghi, không phát.
    const lai = await identifyUnidentifiedVariant({ id: `${P}ur1`, variantId: `${P}v1`, note: "", expectedVariantId: `${P}v1`, actor });
    assert.ok("ok" in lai && lai.kind === "SAME");
    const [r1b] = await db.select().from(schema.returnUnidentified).where(eq(schema.returnUnidentified.id, `${P}ur1`));
    assert.equal(r1b.variantIdentifiedAt?.getTime(), r1.variantIdentifiedAt?.getTime(), "chọn lại không đổi mốc xác nhận");
    assert.equal((await suKien(db, `${P}ur1`)).length, 1, "chọn lại không phát sự kiện thứ hai");
    const cu = await identifyUnidentifiedVariant({ id: `${P}ur1`, variantId: `${P}v2`, note: "x", expectedVariantId: null, actor });
    assert.ok("error" in cu && /vừa được người khác/.test(cu.error), "màn hình cũ (thấy 'chưa gán') không được đè lên lượt xác nhận");

    // ═══ 4. Tóm tắt theo mẫu: món chuyển từ "chưa gán" sang đúng mẫu ═══
    clearMemo();
    const mau1 = await getModelReturnDispositions(`${P}prod`);
    assert.equal(mau1.basis.unidentifiedSubjects, 1, "món không nhãn nay thuộc mẫu");
    assert.equal(mau1.reworkQty, 3, "3 món đang sửa của món không nhãn nay đếm ở mẫu");
    const chuaGan1 = await unassignedUnidentifiedDispositions(db);
    assert.equal(chuaGan0.subjects - chuaGan1.subjects, 1, "con số cấp shop 'không nhãn, chưa gán mẫu' giảm đúng một món");
    assert.equal(chuaGan0.openQty - chuaGan1.openQty, 3);

    // ═══ 2. Đổi trước khi có tồn: được, và bắt buộc lý do ═══
    const doiKhongLyDo = await identifyUnidentifiedVariant({ id: `${P}ur1`, variantId: `${P}v2`, note: " ", expectedVariantId: `${P}v1`, actor });
    assert.ok("error" in doiKhongLyDo && doiKhongLyDo.code === "NEEDS_REASON");
    const doi = await identifyUnidentifiedVariant({ id: `${P}ur1`, variantId: `${P}v2`, note: "đo lại thì là size M", expectedVariantId: `${P}v1`, actor });
    assert.ok("ok" in doi && doi.kind === "CHANGE" && doi.before.variantId === `${P}v1` && doi.after.variantId === `${P}v2`, "đổi trả về trước / sau cho nhật ký");
    assert.equal((await suKien(db, `${P}ur1`)).length, 2);
    assert.deepEqual(await demKho(db), khoTruoc, "đổi mẫu cũng không chạm kho");

    // ═══ Đường vào tồn đã có nay mở: sửa xong → nhập lại (luật quyền + lý do giữ nguyên) ═══
    const khongQuyen = await setReturnDispositionCore(db, { subjectKey: K1, disposition: "RESTOCK_AFTER_REWORK", qty: 2, note: "vá xong", actor, gate });
    assert.ok("error" in khongQuyen, "gán mẫu KHÔNG nới luật quyền của lượt nhập không chứng từ");
    const nhap = await setReturnDispositionCore(db, { subjectKey: K1, disposition: "RESTOCK_AFTER_REWORK", qty: 2, note: "vá xong 2 cái", canRestockUnidentified: true, actor, gate });
    assert.ok("ok" in nhap && nhap.receiptId, "sau khi xác định mẫu, nhập lại sau sửa chạy");
    const [dongPhieu] = await db.select().from(schema.stockReceiptItems).where(eq(schema.stockReceiptItems.receiptId, "ok" in nhap ? (nhap.receiptId ?? "") : ""));
    assert.equal(dongPhieu?.variantId, `${P}v2`, "phiếu mang mẫu đã xác nhận");

    // ═══ 2b. Đã có tồn ⇒ chặn, thông điệp trỏ phiếu điều chỉnh ═══
    const doiSau = await identifyUnidentifiedVariant({ id: `${P}ur1`, variantId: `${P}v1`, note: "hình như là S", expectedVariantId: `${P}v2`, actor });
    assert.ok("error" in doiSau && doiSau.code === "STOCK_RECEIVED" && doiSau.error.includes(VARIANT_FIX_ADJUSTMENT_HREF), "đã nhập lại sau sửa ⇒ đổi mẫu bị chặn, trỏ phiếu điều chỉnh");
    assert.equal((await suKien(db, `${P}ur1`)).length, 2, "lượt bị chặn không phát gì");
    // Bàn không nhãn R: đổi kết luận khi món đã vào sổ vẫn bị chặn (không có cửa mẫu mã nào nữa).
    const ketLuan = await setUnidentifiedCondition({ id: `${P}ur1`, condition: "OK", note: "", actor });
    assert.ok("error" in ketLuan && /sổ kết cục/.test(ketLuan.error));

    // ═══ 5. Dòng bàn không nhãn in số món CÒN GIỮ TẠM ═══
    const ds = await listUnidentifiedReturns({ limit: 1000 });
    const d1 = ds.find((r) => r.id === `${P}ur1`);
    assert.ok(d1);
    assert.equal(d1.quantity, 3);
    assert.equal(d1.holdingQty, 1, "3 món − 2 đã nhập lại = còn 1 món giữ tạm (không phải 3)");
    assert.equal(d1.reworkRestockRows, 1);
    assert.equal(d1.variantIdentifiedByUserId, U);

    // ═══ Tái nhập NGUYÊN MÓN: chưa có mẫu thì không, gán xong thì được, sau đó khoá đổi mẫu ═══
    const tongTruoc = await unidentifiedSummary();
    const som = await restockUnidentifiedReturn({ id: `${P}ur2`, reason: "mất nhãn, còn tem", actor });
    assert.ok("error" in som && /mẫu mã/.test(som.error));
    assert.ok("ok" in (await identifyUnidentifiedVariant({ id: `${P}ur2`, variantId: `${P}v1`, note: "", expectedVariantId: null, actor })));
    const nguyenMon = await restockUnidentifiedReturn({ id: `${P}ur2`, reason: "mất nhãn, còn tem", actor });
    assert.ok("ok" in nguyenMon && nguyenMon.restocked === 1);
    const doiUr2 = await identifyUnidentifiedVariant({ id: `${P}ur2`, variantId: `${P}v2`, note: "nhầm", expectedVariantId: `${P}v1`, actor });
    assert.ok("error" in doiUr2 && doiUr2.code === "STOCK_RECEIVED", "đã tái nhập nguyên món ⇒ đổi mẫu bị chặn");
    const tongSau = await unidentifiedSummary();
    assert.equal(tongTruoc.holdingUnits - tongSau.holdingUnits, 1, "tiêu đề bàn: giữ tạm giảm đúng món vừa vào tồn");
    const d2 = (await listUnidentifiedReturns({ limit: 1000 })).find((r) => r.id === `${P}ur2`);
    assert.equal(d2?.holdingQty, 0, "món đã vào tồn nguyên món không còn giữ tạm");

    // ═══ Nhận kiện có chọn mẫu ngay: cũng ghi ai / lúc nào (không phát sự kiện) ═══
    const tao = await createUnidentifiedReturn({ source: "NO_TRACKING_LABEL", variantId: `${P}v1`, quantity: 1, condition: "DIRTY", note: "bẩn cổ", warehouseNote: "", actor });
    assert.ok("ok" in tao);
    if ("ok" in tao) {
      await db.update(schema.returnUnidentified).set({ code: "UR-COSU-3" }).where(eq(schema.returnUnidentified.id, tao.row.id));
      assert.equal(tao.row.variantIdentifiedByUserId, U);
      assert.ok(tao.row.variantIdentifiedAt && tao.row.variantIdentifiedAt.getTime() === tao.row.receivedAt.getTime(), "chọn lúc nhận ⇒ mốc xác nhận = mốc nhận");
      assert.equal((await suKien(db, tao.row.id)).length, 0);
    }
    const taoKhongMau = await createUnidentifiedReturn({ source: "NO_TRACKING_LABEL", variantId: null, quantity: 1, condition: "DIRTY", note: "bẩn", warehouseNote: "", actor });
    assert.ok("ok" in taoKhongMau);
    if ("ok" in taoKhongMau) {
      await db.update(schema.returnUnidentified).set({ code: "UR-COSU-4" }).where(eq(schema.returnUnidentified.id, taoKhongMau.row.id));
      assert.equal(taoKhongMau.row.variantIdentifiedAt, null, "không chọn mẫu ⇒ không có người xác nhận (CHƯA BIẾT, không bịa)");
      assert.equal(taoKhongMau.row.variantIdentifiedBy, null);
    }
    // CSDL: mốc mà không tên ⇒ chặn.
    await assert.rejects(
      db.update(schema.returnUnidentified).set({ variantIdentifiedBy: null }).where(eq(schema.returnUnidentified.id, `${P}ur1`)),
      (err: unknown) => /return_unidentified_variant_identified_check/.test(`${err instanceof Error ? err.message : ""} ${err instanceof Error && err.cause instanceof Error ? err.cause.message : ""}`),
      "mốc xác nhận mà không có tên người ⇒ CSDL chặn",
    );

    console.log("✓ Company OS · xác định mẫu mã hàng không nhãn (CSDL): gán ghi người + lúc + ghi chú, không chạm kho · chọn lại không ghi · đổi cần lý do, bị chặn khi đã có tồn · mở đường nhập lại sau sửa / tái nhập nguyên món (luật quyền giữ nguyên) · mẫu nhận món, 'chưa gán' giảm · dòng in số còn giữ tạm");
  } finally {
    await donDep(db);
    clearMemo();
  }
}
