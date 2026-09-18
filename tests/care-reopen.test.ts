import assert from "node:assert/strict";
import { and, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import { applyCarrierEventToCare, reconcileCareCoverage } from "@/lib/care/lifecycle";
import { setCareStatus, type CareActor } from "@/lib/care/service";
import { canOpenNewEpisode, chuaAiXuLyXongSql } from "@/lib/care/reopen-guard";
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

  /* ───── dọn ───── */
  const ids = [s1, s2];
  await db.delete(schema.careActions).where(sql`${schema.careActions.shipmentId} in ${ids}`);
  await db.delete(schema.careCaseEvents).where(sql`${schema.careCaseEvents.shipmentId} in ${ids}`);
  await db.delete(schema.shipmentCare).where(sql`${schema.shipmentCare.shipmentId} in ${ids}`);
  await db.delete(schema.shipmentEvents).where(sql`${schema.shipmentEvents.shipmentId} in ${ids}`);
  await db.delete(schema.shipments).where(sql`${schema.shipments.id} in ${ids}`);
  await db.delete(schema.orders).where(sql`${schema.orders.id} like ${`${P}o-%`}`);
  await db.delete(schema.users).where(eq(schema.users.id, `${P}u1`));
  clearMemo();

  console.log("✓ Ca đã xử lý xong KHÔNG tự quay lại: webhook nhắc lại tình trạng cũ · bộ đối chiếu 10 phút/lần · bấm hai lần ra một hoàn tất · note còn nguyên · sự cố MỚI vẫn mở được đợt mới · hai bản TS/SQL của luật nói cùng một điều");
}
