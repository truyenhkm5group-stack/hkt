import assert from "node:assert/strict";
import { and, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import { afterShipmentStateChange, applyCarrierEventToCare, reconcileCareCoverage } from "@/lib/care/lifecycle";
import { setCareStatus, type CareActor } from "@/lib/care/service";
import { canOpenNewEpisode, chuaAiXuLyXongSql } from "@/lib/care/reopen-guard";
import { classifyReopen, REOPEN_CLASS_COUNTS_AS_CASE, REOPEN_GUARD_LIVE_AT } from "@/lib/constants/care-reopen-class";
import { getCareAudit } from "@/lib/queries/care-case-audit";
import { rowsOf } from "@/lib/sql-rows";

/**
 * ═══════════ LỖI PRODUCTION 18/09/2026: CA ĐÃ XỬ LÝ XONG TỰ QUAY LẠI ═══════════
 *
 * Nhân viên xử lý xong một ca, ghi note, bấm hoàn tất. Ca biến khỏi "Cần care". Tải lại trang: ca
 * quay về, trạng thái về "Chưa xử lý", note biến mất. Nhân viên phải làm lại từ đầu.
 *
 * Đo được trên toàn bộ dữ liệu care trước khi sửa:
 *
 *   18 cặp đợt liên tiếp trên cùng một kiện
 *   16 cặp có mốc kích hoạt CŨ HƠN HOẶC BẰNG mốc đóng của đợt trước  ⇒ dựng lại vô cớ
 *   12 trong số đó làm "mất" một note đã ghi
 *   16 do BỘ ĐỐI CHIẾU ĐỊNH KỲ (10 phút/lần) tạo ra
 *    2 cặp hợp lệ — có sự kiện ĐVVC MỚI sau khi đóng
 *
 * Bài này khoá cả HAI đường mở ca và khoá cả việc hai bản của luật (TS và SQL) phải nói cùng một điều.
 */

const P = "crp-";
const gio = (h: number) => new Date(Date.now() - h * 3600_000);
const NGUOI: CareActor = { id: `${P}u1`, email: "truc@shop.vn", name: "Trực ca" };

async function dungKien(db: Db, id: string, over: Partial<typeof schema.shipments.$inferInsert> = {}) {
  await db.insert(schema.orders).values({ id: `${P}o-${id}`, stage: "SHIPPED", status: 2, insertedAt: gio(72) }).onConflictDoNothing();
  await db
    .insert(schema.shipments)
    .values({ id: `${P}${id}`, orderId: `${P}o-${id}`, carrier: "Viettel Post", vtpOrderNumber: `${P}${id}`.toUpperCase(), stage: "DELIVERY_FAILED", codAmount: 300_000, ...over })
    .onConflictDoNothing();
  return `${P}${id}`;
}

const suKien = (db: Db, shipmentId: string, p: { stage: typeof schema.shipments.$inferSelect.stage; code?: number | null; text?: string | null; at: Date }) =>
  applyCarrierEventToCare(db, {
    shipmentId,
    orderId: `${P}o-${shipmentId.slice(P.length)}`,
    trackingNumber: shipmentId.toUpperCase(),
    stage: p.stage,
    vtpStatus: p.code ?? null,
    vtpStatusName: p.text ?? null,
    legType: null,
    occurredAt: p.at,
  });

const dot = (db: Db, shipmentId: string) => db.query.shipmentCare.findMany({ where: eq(schema.shipmentCare.shipmentId, shipmentId), orderBy: (t, { asc }) => [asc(t.episodeNo)] });
const dangMo = (db: Db, shipmentId: string) => db.query.shipmentCare.findFirst({ where: and(eq(schema.shipmentCare.shipmentId, shipmentId), eq(schema.shipmentCare.active, true)) });

export async function testCareReopen(db: Db) {
  await db.insert(schema.users).values({ id: `${P}u1`, email: "truc@shop.vn", name: "Trực ca", passwordHash: "x", role: "CS" }).onConflictDoNothing();

  /* ═════════ 1 · LUẬT THUẦN: BA NHÁNH, VÀ NHÁNH LỖI RƠI VỀ PHÍA HẸP ═════════ */
  assert.deepEqual(canOpenNewEpisode({ triggerAt: gio(1), lastClosedAt: null }), { open: true }, "chưa từng có đợt nào đóng ⇒ mở bình thường");
  assert.equal(canOpenNewEpisode({ triggerAt: gio(1), lastClosedAt: gio(5) }).open, true, "sự kiện ĐVVC MỚI HƠN lúc đóng ⇒ sự cố mới, được mở");
  assert.equal(canOpenNewEpisode({ triggerAt: gio(5), lastClosedAt: gio(1) }).open, false, "mốc kích hoạt cũ hơn lúc đóng ⇒ người đã xử lý tình trạng này rồi");
  // Biên: BẰNG NHAU cũng không mở. Chính lúc người bấm hoàn tất là lúc họ nhìn thấy trạng thái đó.
  const bang = gio(3);
  assert.equal(canOpenNewEpisode({ triggerAt: bang, lastClosedAt: bang }).open, false, "bằng nhau KHÔNG phải mới hơn — biên phải đóng");
  /*
    ĐVVC KHÔNG CHO MỐC ⇒ KHÔNG MỞ. Nếu ở đây lùi về "giờ hiện tại" thì mốc kích hoạt luôn mới hơn
    mốc đóng, và bộ đối chiếu sẽ dựng lại một đợt MỖI MƯỜI PHÚT, mãi mãi.
  */
  assert.equal(canOpenNewEpisode({ triggerAt: null, lastClosedAt: gio(1) }).open, false, "không chứng minh được là mới thì không mở — nhánh lỗi rơi về phía HẸP hơn");

  /* ═════════ 2 · WEBHOOK NHẮC LẠI TÌNH TRẠNG CŨ KHÔNG DỰNG LẠI CA ═════════ */
  const s1 = await dungKien(db, "s1");
  const mocSuCo = gio(5);
  assert.ok((await suKien(db, s1, { stage: "DELIVERY_FAILED", text: "Chờ phát lại", at: mocSuCo })).opened, "sự cố đầu tiên mở ca");

  // Người xử lý: ghi note + bấm hoàn tất.
  const xong = await setCareStatus(NGUOI, { shipmentIds: [s1], status: "RESOLVED", note: "Đã gọi khách, khách hẹn nhận chiều mai" });
  assert.ok("ok" in xong, "bấm hoàn tất phải thành công");
  assert.equal((await dot(db, s1))[0].active, false, "đợt đã đóng");

  // ĐVVC nhắc lại ĐÚNG tình trạng cũ (mốc cũ) — đây là ca lỗi đã đo được.
  const nhacLai = await suKien(db, s1, { stage: "DELIVERY_FAILED", text: "Chờ phát lại", at: mocSuCo });
  assert.equal(nhacLai.opened, false, "gói tin nhắc lại tình trạng CŨ KHÔNG được dựng lại ca");
  assert.equal((await dot(db, s1)).length, 1, "vẫn đúng MỘT đợt — không có đợt thứ hai");
  assert.equal(await dangMo(db, s1), undefined, "và không có đợt nào đang mở ⇒ ca không quay lại hàng đợi 'Cần care'");

  /* ═════════ 3 · NOTE KHÔNG MẤT — VÀ NÓ CHƯA BAO GIỜ MẤT KHỎI CSDL ═════════ */
  //
  // Đây là điểm dễ hiểu sai nhất của lỗi này: note luôn được ghi vào `care_actions` (append-only)
  // và vào `last_note` của đợt. Nó "biến mất" vì màn hình đọc đợt ĐANG MỞ, mà đợt đang mở lại là
  // một đợt MỚI trắng trơn. Sửa đường MỞ CA là sửa đúng chỗ; đường ghi note vốn không hỏng.
  const dotSau = (await dot(db, s1))[0];
  assert.equal(dotSau.lastNote, "Đã gọi khách, khách hẹn nhận chiều mai", "note còn nguyên trên đợt");
  const hanhDong = await db.query.careActions.findMany({ where: eq(schema.careActions.shipmentId, s1) });
  assert.equal(hanhDong.length, 1, "note cũng vào bảng hành động append-only");
  assert.equal(hanhDong[0].actorId, `${P}u1`, "và mang KHOÁ TÀI KHOẢN của người ghi, không chỉ ô chữ");

  /* ═════════ 4 · BỘ ĐỐI CHIẾU ĐỊNH KỲ — THỦ PHẠM CỦA 16/18 LẦN DỰNG LẠI ═════════ */
  await db.update(schema.shipments).set({ vtpStatus: 507, vtpStatusName: "Chờ phát lại", stage: "DELIVERY_FAILED", vtpStatusDate: mocSuCo, isFinal: false }).where(eq(schema.shipments.id, s1));
  const lan1 = await reconcileCareCoverage(db, new Date(), { shipmentIds: [s1] });
  assert.equal(lan1.opened, 0, "bộ đối chiếu KHÔNG được dựng lại ca mà người vừa xử lý xong");
  const lan2 = await reconcileCareCoverage(db, new Date(), { shipmentIds: [s1] });
  assert.equal(lan2.opened, 0, "chạy lần thứ hai cũng vậy — idempotent");
  assert.equal((await dot(db, s1)).length, 1, "sau hai vòng đối chiếu vẫn đúng MỘT đợt");

  /* ═════════ 5 · SỰ CỐ MỚI THẬT SỰ VẪN PHẢI MỞ ĐƯỢC CA MỚI ═════════ */
  //
  // Luật gắn với MỐC, không gắn với mã vận đơn. Chặn theo vận đơn là bịt luôn lần hỏng thứ hai —
  // và hai cặp hợp lệ đo được trên production chính là loại này.
  const mocMoi = new Date();
  const suCoMoi = await suKien(db, s1, { stage: "DELIVERY_FAILED", text: "Chờ phát lại", at: mocMoi });
  assert.equal(suCoMoi.opened, true, "sự kiện ĐVVC MỚI sau khi đóng ⇒ đây là sự cố mới, phải mở đợt mới");
  const haiDot = await dot(db, s1);
  assert.equal(haiDot.length, 2, "hai đợt RIÊNG — nhật ký phải phân biệt được chúng");
  assert.equal(haiDot[0].episodeNo, 1);
  assert.equal(haiDot[1].episodeNo, 2);
  assert.equal(haiDot[0].lastNote, "Đã gọi khách, khách hẹn nhận chiều mai", "đợt cũ giữ nguyên note của nó");

  /* ═════════ 6 · BẤM HAI LẦN CHỈ RA MỘT LẦN HOÀN TẤT ═════════ */
  const s2 = await dungKien(db, "s2");
  await suKien(db, s2, { stage: "DELIVERY_FAILED", text: "Chờ phát lại", at: gio(4) });
  await setCareStatus(NGUOI, { shipmentIds: [s2], status: "RESOLVED", note: "Xong" });
  const lanHai = await setCareStatus(NGUOI, { shipmentIds: [s2], status: "RESOLVED", note: "Xong" });
  assert.ok("ok" in lanHai, "bấm lần hai không được ném lỗi cho người dùng");
  assert.equal("ok" in lanHai && lanHai.data.skipped.length, 1, "…mà phải nói rõ là đã bỏ qua");
  const suKienCa = await db.query.careCaseEvents.findMany({ where: and(eq(schema.careCaseEvents.shipmentId, s2), eq(schema.careCaseEvents.action, "RESOLVE")) });
  assert.equal(suKienCa.length, 1, "chỉ MỘT mốc hoàn tất trong nhật ký dù bấm hai lần");
  assert.equal((await db.query.careActions.findMany({ where: eq(schema.careActions.shipmentId, s2) })).length, 1, "và chỉ MỘT dòng hành động — không nhân đôi note");

  /* ═════════ 7 · HAI BẢN CỦA LUẬT PHẢI NÓI CÙNG MỘT ĐIỀU ═════════ */
  //
  // Luật sống ở hai nơi: TypeScript (đường webhook) và SQL (bộ đối chiếu lọc ngay trong truy vấn).
  // Hai bản trôi xa nhau là cách hỏng tệ nhất — mỗi đường vào cho một kết quả khác nhau và không
  // lỗi nào phát ra. Nên chạy cả hai trên cùng dữ liệu và so từng kiện.
  for (const kien of [s1, s2]) {
    for (const mocThu of [gio(9), gio(2), new Date()]) {
      await db.update(schema.shipments).set({ vtpStatusDate: mocThu }).where(eq(schema.shipments.id, kien));
      const [sql_] = rowsOf<{ cho_mo: boolean }>(
        await db.execute(sql`select ${chuaAiXuLyXongSql(sql`s.id`, sql`s.vtp_status_date`)} as cho_mo from shipments s where s.id = ${kien}`),
      );
      const dong = await db.query.shipmentCare.findMany({ where: and(eq(schema.shipmentCare.shipmentId, kien), eq(schema.shipmentCare.active, false)) });
      const moc = dong.map((d) => d.doneAt ?? d.outcomeAt ?? d.updatedAt).filter((x): x is Date => Boolean(x));
      const ts = canOpenNewEpisode({ triggerAt: mocThu, lastClosedAt: moc.length ? new Date(Math.max(...moc.map((m) => m.getTime()))) : null });
      assert.equal(Boolean(sql_?.cho_mo), ts.open, `bản SQL và bản TypeScript phải cùng kết luận (${kien} @ ${mocThu.toISOString()})`);
    }
  }

  /* ═════════ 8 · BẢNG CHÂN LÝ MỞ LẠI — NĂM TÌNH HUỐNG CHỦ SHOP CHỐT ═════════ */
  //
  // Năm tình huống này là đặc tả, không phải ví dụ: chúng phân định chính xác ranh giới giữa "sự cố
  // cũ" và "sự cố mới", và mỗi cái đi qua một ĐƯỜNG VÀO khác nhau (webhook, bộ đối chiếu, nhập tệp).

  // ── A · Bộ đối chiếu chạy nhiều vòng sau khi người xử lý xong ⇒ KHÔNG mở lại ──
  const sA = await dungKien(db, "sa");
  const mocA = gio(6);
  await suKien(db, sA, { stage: "DELIVERY_FAILED", text: "Chờ phát lại", at: mocA });
  await setCareStatus(NGUOI, { shipmentIds: [sA], status: "RESOLVED", note: "A: đã gọi khách" });
  await db.update(schema.shipments).set({ vtpStatus: 507, vtpStatusName: "Chờ phát lại", stage: "DELIVERY_FAILED", vtpStatusDate: mocA, isFinal: false }).where(eq(schema.shipments.id, sA));
  for (let i = 0; i < 3; i++) await reconcileCareCoverage(db, new Date(), { shipmentIds: [sA] });
  assert.equal((await dot(db, sA)).length, 1, "A · ba vòng đối chiếu sau khi xử lý xong KHÔNG được dựng lại ca");

  // ── B · ĐVVC có sự kiện MỚI THẬT ⇒ ĐƯỢC mở đợt mới ──
  const mocB = new Date();
  await db.update(schema.shipments).set({ vtpStatusDate: mocB }).where(eq(schema.shipments.id, sA));
  await reconcileCareCoverage(db, new Date(), { shipmentIds: [sA] });
  const sauB = await dot(db, sA);
  assert.equal(sauB.length, 2, "B · sự kiện ĐVVC mới hơn lúc đóng ⇒ đây là sự cố MỚI, phải mở đợt mới");
  assert.equal(sauB[1].sourceTrigger, "RECONCILE");

  // ── C · Webhook GỬI LẠI một sự kiện CŨ sau khi đã xử lý xong ⇒ KHÔNG mở lại ──
  //
  // Viettel Post thử lại tới 5 lần, nên đây không phải tình huống hiếm. Gói tin gửi lại mang mốc
  // ĐVVC CŨ, và mốc mới là thứ quyết định — không phải lúc ERP nhận được gói tin.
  const sC = await dungKien(db, "sc");
  const mocC = gio(8);
  await suKien(db, sC, { stage: "DELIVERY_FAILED", text: "Chờ phát lại", at: mocC });
  await setCareStatus(NGUOI, { shipmentIds: [sC], status: "RESOLVED", note: "C: xong" });
  for (let i = 0; i < 5; i++) {
    const lai = await suKien(db, sC, { stage: "DELIVERY_FAILED", text: "Chờ phát lại", at: mocC });
    assert.equal(lai.opened, false, "C · webhook gửi lại sự kiện cũ KHÔNG được dựng lại ca");
  }
  assert.equal((await dot(db, sC)).length, 1);

  /*
    ── D · NHẬP TỆP mang một sự kiện CŨ ⇒ KHÔNG mở lại ──

    Đường nhập tệp đi qua `afterShipmentStateChange`, và hàm đó lấy mốc từ `shipments.vtp_status_date`
    — ảnh chụp đã dựng từ lịch sử, nên một dòng tệp CŨ không đẩy mốc ấy lùi lại được. Bài kiểm dựng
    đúng tình huống đó: ảnh chụp giữ mốc cũ, gọi lại đường vòng đời, và ca không được quay lại.
  */
  const sD = await dungKien(db, "sd");
  const mocD = gio(12);
  await suKien(db, sD, { stage: "DELIVERY_FAILED", text: "Chờ phát lại", at: mocD });
  await setCareStatus(NGUOI, { shipmentIds: [sD], status: "RESOLVED", note: "D: xong" });
  await db.update(schema.shipments).set({ vtpStatus: 507, vtpStatusName: "Chờ phát lại", stage: "DELIVERY_FAILED", vtpStatusDate: mocD, isFinal: false }).where(eq(schema.shipments.id, sD));
  const nhapCu = await afterShipmentStateChange(db, sD, { source: "VTP_IMPORT" });
  assert.equal(nhapCu.opened, false, "D · nhập tệp mang sự kiện CŨ KHÔNG được dựng lại ca");
  await reconcileCareCoverage(db, new Date(), { shipmentIds: [sD] });
  assert.equal((await dot(db, sD)).length, 1, "D · và vòng đối chiếu sau đó cũng vậy");

  // ── E · NHẬP TỆP mang một sự kiện MỚI THẬT ⇒ ĐƯỢC mở đợt mới ──
  await db.update(schema.shipments).set({ vtpStatusDate: new Date() }).where(eq(schema.shipments.id, sD));
  const nhapMoi = await afterShipmentStateChange(db, sD, { source: "VTP_IMPORT" });
  assert.equal(nhapMoi.opened, true, "E · nhập tệp mang sự kiện MỚI HƠN lúc đóng ⇒ được mở đợt mới");
  assert.equal((await dot(db, sD)).length, 2);

  /* ═════════ 9 · HAI NGƯỜI CÙNG MỞ MỘT CA, MỘT NGƯỜI ĐÓNG TRƯỚC ═════════ */
  //
  // Người thứ hai bấm từ một màn hình CŨ (chưa thấy là ca đã đóng). Không được: mở lại ca, đè kết
  // quả, mất note, hay sinh thêm một kết cục thứ hai.
  const sF = await dungKien(db, "sf");
  await suKien(db, sF, { stage: "DELIVERY_FAILED", text: "Chờ phát lại", at: gio(3) });
  await setCareStatus(NGUOI, { shipmentIds: [sF], status: "RESOLVED", note: "A đóng trước" });
  const truocKhiB = (await dot(db, sF))[0];

  const NGUOI_B: CareActor = { id: `${P}u2`, email: "b@shop.vn", name: "Người B" };
  await db.insert(schema.users).values({ id: `${P}u2`, email: "b@shop.vn", name: "Người B", passwordHash: "x", role: "CS" }).onConflictDoNothing();
  const bBam = await setCareStatus(NGUOI_B, { shipmentIds: [sF], status: "IN_PROGRESS", note: "B bấm từ màn hình cũ" });
  assert.ok("ok" in bBam && bBam.data.skipped.length === 1, "B bấm từ màn hình cũ phải bị TỪ CHỐI kèm lý do, không âm thầm ghi");

  const sauB2 = (await dot(db, sF))[0];
  assert.equal(sauB2.careStatus, "RESOLVED", "kết quả của A không bị đè");
  assert.equal(sauB2.active, false, "ca KHÔNG bị mở lại");
  assert.equal(sauB2.lastNote, truocKhiB.lastNote, "note của A còn nguyên");
  assert.equal(sauB2.doneAt?.getTime(), truocKhiB.doneAt?.getTime(), "mốc hoàn tất không bị đẩy đi");
  assert.equal((await dot(db, sF)).length, 1, "và không sinh đợt thứ hai");

  /* ═════════ 10 · BẢN SAO DO LỖI CŨ KHÔNG ĐƯỢC ĐẾM NHƯ MỘT CA NGHIỆP VỤ ═════════ */
  //
  // Đo 18/09/2026 trên 19 cặp đợt liên tiếp: 10 bản sao chắc chắn · 6 chưa đủ bằng chứng · 3 hợp lệ.
  // Nếu không gọi tên chúng thì mọi con số care còn nói sai rất lâu sau khi lỗi đã hết.
  assert.equal(classifyReopen({ episodeNo: 1, triggerAt: gio(2), previousClosedAt: null, carrierEventBetween: false }), "FIRST_EPISODE");
  assert.equal(classifyReopen({ episodeNo: 2, triggerAt: gio(1), previousClosedAt: gio(5), carrierEventBetween: false }), "LEGITIMATE_REOPEN", "mốc mới hơn lúc đóng ⇒ sự cố thật");
  assert.equal(classifyReopen({ episodeNo: 2, triggerAt: gio(5), previousClosedAt: gio(1), carrierEventBetween: false }), "FALSE_REOPEN_LEGACY", "mốc cũ hơn và không có sự kiện xen giữa ⇒ bản sao");
  /*
    SỰ KIỆN ĐVVC XEN GIỮA LÀ RANH GIỚI GIỮA "CHẮC CHẮN" VÀ "CHƯA RÕ".

    Gộp nhóm này vào "lỗi" là khẳng định một điều không chứng minh được — và nó làm con số lỗi to
    lên 60% (10 → 16). Gộp vào "thật" thì giấu mất chúng. Đứng riêng mới là câu trả lời đúng.
  */
  assert.equal(classifyReopen({ episodeNo: 2, triggerAt: gio(5), previousClosedAt: gio(1), carrierEventBetween: true }), "REOPEN_UNVERIFIED");
  assert.equal(REOPEN_CLASS_COUNTS_AS_CASE.FALSE_REOPEN_LEGACY, false, "bản sao KHÔNG vào mẫu số của bất kỳ con số nào");
  assert.equal(REOPEN_CLASS_COUNTS_AS_CASE.REOPEN_UNVERIFIED, true, "chưa rõ thì VẪN đếm — loại bỏ một ca vì không chắc là giấu việc");

  /* ═════════ 11 · TRUY VẤN KIỂM KÊ CHẠY ĐƯỢC VÀ LOẠI ĐÚNG BẢN SAO ═════════ */
  //
  // `getCareAudit` là nơi duy nhất mọi màn hình care đọc số. Truy vấn của nó phải chạy được THẬT —
  // một câu SQL chỉ hỏng lúc chạy sẽ không lỗi nào phát ra ở typecheck.
  const sG = await dungKien(db, "sg");
  const mocG = gio(20);
  await suKien(db, sG, { stage: "DELIVERY_FAILED", text: "Chờ phát lại", at: mocG });
  await setCareStatus(NGUOI, { shipmentIds: [sG], status: "RESOLVED", note: "G: xong" });
  /*
    ═══ MỐC CỦA BẢN SAO DỰNG TỪ CHÍNH HẰNG SỐ ĐANG ĐO, KHÔNG TỪ "20 GIỜ TRƯỚC" (luật 50) ═══

    Bản trước gieo `openedAt = gio(20)` rồi so với `REOPEN_GUARD_LIVE_AT` — một hằng số NGÀY CỐ
    ĐỊNH (18/09/2026 04:10Z). Đó là một cửa sổ TRƯỢT theo đồng hồ thật quét qua một mốc đứng yên:
    bài kiểm xanh ngày 18/09 và ĐỎ ngày 19/09, vì "20 giờ trước" đã đi qua bên kia cái mốc và bản
    sao di sản bỗng bị đếm là "lỗi còn đang xảy ra". Đúng quả bom mà mục 50 của AGENTS.md sinh ra
    để cấm — và nó chặn mọi lần deploy, vì workflow chạy `npm test` trước khi đụng máy chủ.

    Nay mốc dựng TỪ CHÍNH `REOPEN_GUARD_LIVE_AT`: bản sao này ở TRƯỚC lúc luật mới chạy theo ĐỊNH
    NGHĨA, nên nó là DI SẢN mãi mãi, hôm nay là thứ mấy cũng vậy.
  */
  const mocDiSan = new Date(REOPEN_GUARD_LIVE_AT.getTime() - 3600_000);
  await db.insert(schema.shipmentCare).values({
    shipmentId: sG, orderId: `${P}o-sg`, episodeNo: 2, active: true, careStatus: "NEW",
    entryCarrierState: "WAITING_REDELIVERY", sourceTrigger: "RECONCILE", openedAt: mocDiSan, careOutcome: "PENDING", updatedBy: "SYSTEM",
  });
  /*
    ═══ VẾ ĐỐI CHỨNG: MỘT BẢN SAO NẰM *SAU* MỐC VÁ PHẢI ĐƯỢC ĐẾM ═══

    Chỉ khẳng định "cái cũ không bị đếm nhầm" thì bài kiểm vẫn xanh kể cả khi bộ đếm hỏng thành
    đếm-không-cái-gì — và lúc ấy `falseReopenAfterFix` sẽ mãi mãi báo 0, tức là mãi mãi báo "lỗi
    đã hết", kể cả giữa lúc nó đang xảy ra. Con số này chỉ có nghĩa khi nó chia ĐÔI đúng ở mốc
    vá, nên phải kiểm cả hai bên của cái mốc.

    `mocSauVa` cũng neo vào hằng số, nên nó không bao giờ trôi: mốc kích hoạt vẫn cũ hơn lúc đóng
    (đợt 1 đóng ở "bây giờ") ⇒ vẫn là FALSE_REOPEN_LEGACY, nhưng nằm SAU lúc luật vá chạy.
  */
  const mocSauVa = new Date(REOPEN_GUARD_LIVE_AT.getTime() + 3600_000);
  const sH = await dungKien(db, "sh");
  await suKien(db, sH, { stage: "DELIVERY_FAILED", text: "Chờ phát lại", at: gio(20) });
  await setCareStatus(NGUOI, { shipmentIds: [sH], status: "RESOLVED", note: "H: xong" });
  await db.insert(schema.shipmentCare).values({
    shipmentId: sH, orderId: `${P}o-sh`, episodeNo: 2, active: true, careStatus: "NEW",
    entryCarrierState: "WAITING_REDELIVERY", sourceTrigger: "RECONCILE", openedAt: mocSauVa, careOutcome: "PENDING", updatedBy: "SYSTEM",
  });

  clearMemo();
  // Kỳ phải PHỦ được mốc di sản dù hôm nay cách nó bao xa — nếu không, dòng rơi ra ngoài kỳ và
  // `dongG.length` tụt xuống 1 vào một ngày nào đó. Cùng một quả bom, chỉ chậm hơn vài tuần.
  const tuLuc = new Date(Math.min(gio(72).getTime(), mocDiSan.getTime() - 3600_000));
  const kiemKe = await getCareAudit({ from: tuLuc, to: new Date(Date.now() + 3600_000) }, "CASE_OPENED_AT");
  const dongG = kiemKe.rows.filter((r) => r.shipmentId === sG);
  assert.equal(dongG.length, 2, "cả hai đợt vẫn nằm trong danh sách để tra lịch sử — không xoá gì");
  assert.equal(dongG.find((r) => r.careId !== undefined && r.outcome !== undefined && r.reopenClass === "FALSE_REOPEN_LEGACY") !== undefined, true, "bản sao phải được gọi đúng tên");
  assert.ok(kiemKe.reopen.byClass.FALSE_REOPEN_LEGACY >= 1, "bộ đếm theo loại phải thấy nó");
  /*
    Con số DUY NHẤT nói lỗi có còn đang xảy ra hay không. Bản sao trong bài kiểm mang mốc kích hoạt
    CŨ (20 giờ trước) nên nó là DI SẢN, không phải lỗi mới — đúng như các đợt thật trên production.
  */
  assert.equal(kiemKe.reopen.falseReopenAfterFix, 1, "đúng MỘT bản sao nằm sau mốc vá: cái TRƯỚC mốc không được tính, cái SAU mốc không được bỏ sót — con số này chia đôi ở đó hoặc nó vô nghĩa");
  assert.equal(kiemKe.reopen.guardLiveAt.getTime(), REOPEN_GUARD_LIVE_AT.getTime(), "và màn hình phải nói ra nó đang chia đôi ở mốc nào");

  /* ───── dọn ───── */
  const ids = [s1, s2, sA, sC, sD, sF, sG, sH];
  await db.delete(schema.careActions).where(sql`${schema.careActions.shipmentId} in ${ids}`);
  await db.delete(schema.careCaseEvents).where(sql`${schema.careCaseEvents.shipmentId} in ${ids}`);
  await db.delete(schema.shipmentCare).where(sql`${schema.shipmentCare.shipmentId} in ${ids}`);
  await db.delete(schema.shipmentEvents).where(sql`${schema.shipmentEvents.shipmentId} in ${ids}`);
  await db.delete(schema.shipments).where(sql`${schema.shipments.id} in ${ids}`);
  await db.delete(schema.orders).where(sql`${schema.orders.id} like ${`${P}o-%`}`);
  await db.delete(schema.users).where(sql`${schema.users.id} in ${[`${P}u1`, `${P}u2`]}`);
  clearMemo();

  console.log("✓ Ca đã xử lý xong KHÔNG tự quay lại: webhook nhắc lại tình trạng cũ · bộ đối chiếu 10 phút/lần · bấm hai lần ra một hoàn tất · note còn nguyên · sự cố MỚI vẫn mở được đợt mới · hai bản TS/SQL của luật nói cùng một điều · bảng chân lý A–E · màn hình cũ không đè được kết quả mới · bản sao do lỗi cũ không vào con số nào");
}
