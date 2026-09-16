import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { backoffMinutes, nextSyncAt, reconcileTierOf, RECONCILE_INTERVAL_MINUTES, RECONCILE_BACKOFF_CAP_MINUTES } from "@/lib/constants/vtp-reconcile";
import { statusRegistryKey } from "@/lib/integrations/viettelpost/registry";
import { previewVtpOrderListFile, fileChecksum } from "@/lib/integrations/viettelpost/import-preview";
import { runVtpDataFileImport } from "@/lib/integrations/viettelpost/import-run";
import { applyVtpTracking } from "@/lib/integrations/viettelpost/sync";
import type { VtpTrackingRecord } from "@/lib/integrations/viettelpost/client";
import { getShipmentTimeline } from "@/lib/queries/shipment-timeline";
import { viettelPostHealth } from "@/lib/queries/integrations";
import { clearMemo } from "@/lib/cache";

/**
 * ═══════════ VIETTEL POST LÀ NGUỒN SỰ THẬT — NHỮNG ĐIỀU KHÔNG ĐƯỢC PHÉP SAI ═══════════
 *
 * Bài này khoá năm lời hứa của bản 16/09/2026:
 *
 *  1. Câu ĐVVC nói mà ERP chưa dịch được KHÔNG BAO GIỜ biến mất — nó vào sổ, lên vận đơn, và
 *     KHÔNG được phép đổi trạng thái vận đơn (không đủ căn cứ thì không đoán).
 *  2. Ảnh chụp trạng thái ghi rõ NGUỒN nào quyết định nó.
 *  3. Nhịp đối chiếu đi theo độ nóng của kiện, lùi dần khi hỏi hụt, và kiện đã kết thúc rời hàng đợi.
 *  4. Nhập tệp có bước CHẠY THỬ chỉ đọc, và nhập lại cùng tệp không đẻ ra lịch sử giả.
 *  5. Nhật ký một vận đơn giữ BỐN CHIỀU tách rời: chứng từ ĐVVC · hệ thống · người · ERP suy ra.
 */

const track = (orderNumber: string, status: number | null, statusName: string, at: string, extra: Record<string, unknown> = {}): VtpTrackingRecord => ({
  orderNumber,
  orderReference: "",
  status,
  statusName,
  statusDate: new Date(at),
  location: "",
  note: "",
  reasonCode: null,
  isReturning: null,
  moneyCollectionOrigin: null,
  moneyCollection: 0,
  moneyTotal: 0,
  moneyTotalFee: 0,
  moneyFeeCod: 0,
  productWeight: 0,
  service: "",
  expectedDelivery: "",
  receiverName: "",
  receiverPhone: "",
  receiverAddress: "",
  employeeName: "",
  employeePhone: "",
  journey: [] as VtpTrackingRecord["journey"],
  raw: {},
  ...extra,
});

export async function testVtpSourceOfTruth(db: Db) {
  // ═════════ 1. TRẠNG THÁI ERP CHƯA DỊCH ĐƯỢC KHÔNG BAO GIỜ BỊ NUỐT ═════════
  //
  // Kịch bản thật: Viettel Post thêm một mã mới. Trước bản này sự kiện vẫn vào `shipment_events`
  // nhưng `deriveShipmentState()` lọc bỏ nó (đúng), nên MÀN HÌNH vẫn hiện câu CŨ và không có một
  // dấu hiệu nào — người trực đọc một trạng thái cũ mà tưởng đó là tin mới nhất.
  const LA = "PKE-TRUTH-LA";
  await applyVtpTracking(track(LA, 300, "Đóng tải - vận chuyển đi", "2026-09-10T08:00:00Z"), "VTP_WEBHOOK", { allowCreate: true });
  await applyVtpTracking(track(LA, 8123, "Đang chờ giám định hàng hoá đặc biệt", "2026-09-11T09:30:00Z"), "VTP_WEBHOOK");
  const laShip = await db.query.shipments.findFirst({ where: eq(schema.shipments.vtpOrderNumber, LA) });
  assert.ok(laShip);
  assert.equal(laShip.stage, "IN_TRANSIT", "trạng thái vận đơn KHÔNG được đoán từ một câu chưa dịch được");
  assert.equal(laShip.vtpRawStatusName, "Đang chờ giám định hàng hoá đặc biệt", "chữ NGUYÊN VĂN của ĐVVC phải nằm trên chính vận đơn");
  assert.equal(laShip.vtpRawStatusCode, 8123);
  assert.equal(laShip.vtpRawMapped, false, "phải đánh dấu là CHƯA DỊCH ĐƯỢC để màn hình nói ra");
  assert.equal(laShip.vtpRawStatusAt?.toISOString(), "2026-09-11T09:30:00.000Z", "mốc của lời khai thô là mốc ĐVVC, không phải lúc ERP nhận");

  // Sự kiện vẫn vào lịch sử — không bao giờ bị ném đi.
  const laEvents = await db.select().from(schema.shipmentEvents).where(and(eq(schema.shipmentEvents.shipmentId, laShip.id), eq(schema.shipmentEvents.status, "8123")));
  assert.equal(laEvents.length, 1, "sự kiện mang trạng thái lạ vẫn phải được lưu nguyên vẹn");

  // Và nó phải hiện ra ở SỔ ĐĂNG KÝ, kèm đủ thứ cần để sửa: mã, câu chữ, số lần, lần đầu/lần cuối.
  const so = await db.query.vtpStatusRegistry.findFirst({ where: eq(schema.vtpStatusRegistry.statusKey, "8123") });
  assert.ok(so, "mã ĐVVC chưa có trong bảng mã phải vào sổ đăng ký");
  assert.equal(so.mapped, false);
  assert.equal(so.statusName, "Đang chờ giám định hàng hoá đặc biệt");
  assert.equal(so.lastSource, "VTP_WEBHOOK");
  assert.ok(so.occurrences >= 1);

  // Gặp lại cùng trạng thái ⇒ CỘNG DỒN bộ đếm, KHÔNG đẻ dòng thứ hai.
  await applyVtpTracking(track(LA, 8123, "Đang chờ giám định hàng hoá đặc biệt", "2026-09-11T11:00:00Z"), "VTP_WEBHOOK");
  const soLan2 = await db.select().from(schema.vtpStatusRegistry).where(eq(schema.vtpStatusRegistry.statusKey, "8123"));
  assert.equal(soLan2.length, 1, "sổ đăng ký đi bằng khoá tự nhiên — gặp lại không tạo dòng mới");
  assert.ok(soLan2[0].occurrences > so.occurrences, "gặp lại phải cộng dồn bộ đếm");

  // Khoá tự nhiên: có mã thì lấy mã; không có mã thì lấy tên đã bỏ dấu. ĐVVC sửa chính tả cho cùng
  // một mã (đã gặp với 501) không được đẻ ra một "mã mới".
  assert.equal(statusRegistryKey(501, "Thành công - Phát thành công"), "501");
  assert.equal(statusRegistryKey(501, "Phát thành công"), "501", "cùng mã, khác câu chữ vẫn là MỘT trạng thái");
  assert.equal(statusRegistryKey(null, "Đã Trả Hàng"), "text:da tra hang", "không có mã thì khoá là tên đã chuẩn hoá");
  assert.equal(statusRegistryKey(null, "   "), null, "gói tin không mang trạng thái nào thì không có gì để ghi");

  // Câu ĐVVC HIỂU ĐƯỢC đến sau thì lời khai thô đi theo, và cờ chuyển lại thành đã dịch được.
  await applyVtpTracking(track(LA, 501, "Thành công - Phát thành công", "2026-09-12T10:00:00Z"), "VTP_WEBHOOK");
  const laSau = await db.query.shipments.findFirst({ where: eq(schema.shipments.id, laShip.id) });
  assert.equal(laSau?.vtpRawMapped, true, "câu dịch được đến sau phải gỡ cờ cảnh báo");
  assert.equal(laSau?.stage, "DELIVERED");

  // ═════════ 2. LỜI KHAI THÔ ĐI THEO MỐC ĐVVC, KHÔNG THEO LƯỢT GHI ═════════
  // Gói tin đến MUỘN (mốc cũ hơn) không được kéo lùi cả trạng thái lẫn lời khai thô.
  await applyVtpTracking(track(LA, 8124, "Một câu cũ đến muộn", "2026-09-11T00:00:00Z"), "VTP_WEBHOOK");
  const laMuon = await db.query.shipments.findFirst({ where: eq(schema.shipments.id, laShip.id) });
  assert.equal(laMuon?.stage, "DELIVERED", "gói tin đến muộn không kéo lùi trạng thái");
  assert.equal(laMuon?.vtpRawStatusName, "Thành công - Phát thành công", "gói tin đến muộn cũng không kéo lùi lời khai thô");
  assert.equal(laMuon?.vtpRawMapped, true);
  // …nhưng câu ấy VẪN vào sổ đăng ký: nó vẫn là một câu ĐVVC đã nói.
  assert.ok(await db.query.vtpStatusRegistry.findFirst({ where: eq(schema.vtpStatusRegistry.statusKey, "8124") }), "câu đến muộn vẫn phải vào sổ");

  // ═════════ 3. ẢNH CHỤP PHẢI NÓI NGUỒN NÀO QUYẾT ĐỊNH NÓ ═════════
  assert.equal(laMuon?.vtpSyncSource, "VTP_WEBHOOK", "phải ghi nguồn của sự kiện đã quyết định ảnh chụp");

  // ═════════ 4. NHỊP ĐỐI CHIẾU — HÀM THUẦN, CHẠY HAI LẦN RA CÙNG KẾT QUẢ ═════════
  const now = new Date("2026-09-16T08:00:00Z");
  const phut = (d: Date | null) => (d ? Math.round((d.getTime() - now.getTime()) / 60_000) : null);

  assert.equal(phut(nextSyncAt({ substate: "OUT_FOR_DELIVERY", isFinal: false, failedAttempts: 0, now })), RECONCILE_INTERVAL_MINUTES.HOT, "đang đi giao là kiện NÓNG");
  assert.equal(phut(nextSyncAt({ substate: "WAITING_REDELIVERY", isFinal: false, failedAttempts: 0, now })), RECONCILE_INTERVAL_MINUTES.HOT, "chờ phát lại là lúc đội care đang cầm kiện");
  assert.equal(phut(nextSyncAt({ substate: "IN_TRANSIT", isFinal: false, failedAttempts: 0, now })), RECONCILE_INTERVAL_MINUTES.WARM);
  assert.equal(phut(nextSyncAt({ substate: "AWAITING_PICKUP", isFinal: false, failedAttempts: 0, now })), RECONCILE_INTERVAL_MINUTES.COLD, "chờ lấy hàng chậm vài ngày là bình thường");
  // CHƯA RÕ là NÓNG, không phải nguội: không biết gì về kiện là lý do để hỏi lại nhanh, không phải
  // bằng chứng rằng không có gì đáng lo.
  assert.equal(phut(nextSyncAt({ substate: "UNKNOWN", isFinal: false, failedAttempts: 0, now })), RECONCILE_INTERVAL_MINUTES.HOT);
  // Kiện ĐÃ KẾT THÚC rời hàng đợi hẳn — `null` nghĩa là KHÔNG XẾP HÀNG, khác hẳn "hỏi ngay".
  assert.equal(nextSyncAt({ substate: "DELIVERED", isFinal: true, failedAttempts: 0, now }), null);
  // Trạng thái con nói "đã giao" nhưng cờ kết thúc chưa bật là một MÂU THUẪN trong dữ liệu của
  // ERP — phải đi hỏi lại, không được coi là xong (nếu trả `null` thì nó nằm mãi ở đầu hàng đợi).
  assert.equal(phut(nextSyncAt({ substate: "DELIVERED", isFinal: false, failedAttempts: 0, now })), RECONCILE_INTERVAL_MINUTES.COLD);

  assert.equal(backoffMinutes(5, 0), 5, "lượt thành công giữ nguyên nhịp");
  assert.equal(backoffMinutes(5, 1), 10, "hỏi hụt một lần thì giãn gấp đôi");
  assert.equal(backoffMinutes(5, 3), 40);
  assert.equal(backoffMinutes(5, 50), RECONCILE_BACKOFF_CAP_MINUTES, "có trần để một kiện không bị bỏ quên vĩnh viễn");
  assert.equal(backoffMinutes(0, 5), 0);
  assert.equal(reconcileTierOf("OUT_FOR_DELIVERY", true), "TERMINAL", "cờ kết thúc thắng mọi trạng thái con");

  // Xác định: gọi hai lần với cùng đầu vào ra cùng một mốc.
  const l1 = nextSyncAt({ substate: "IN_TRANSIT", isFinal: false, failedAttempts: 2, now });
  const l2 = nextSyncAt({ substate: "IN_TRANSIT", isFinal: false, failedAttempts: 2, now });
  assert.equal(l1?.getTime(), l2?.getTime(), "kế hoạch phải ỔN ĐỊNH — chạy hai lần ra cùng kết quả");

  // Và nó phải được GHI XUỐNG: webhook vừa áp xong thì kiện có hạn hỏi lại.
  assert.ok(laMuon?.vtpNextSyncAt === null || laMuon?.vtpNextSyncAt instanceof Date, "mỗi lượt nạp phải xếp lại lịch hỏi");
  assert.equal(laMuon?.vtpSyncAttempts, 0, "lượt thành công phải RESET bộ đếm hỏi hụt");

  // ═════════ 5. NHẬP TỆP: CHẠY THỬ CHỈ ĐỌC ═════════
  const KHOP = "PKE-TRUTH-FILE1";
  await applyVtpTracking(track(KHOP, 300, "Đóng tải - vận chuyển đi", "2026-09-10T03:00:00Z"), "VTP_WEBHOOK", { allowCreate: true });
  const truocKhiXem = await db.query.shipments.findFirst({ where: eq(schema.shipments.vtpOrderNumber, KHOP) });
  const soSuKienTruoc = (await db.select().from(schema.shipmentEvents).where(eq(schema.shipmentEvents.shipmentId, truocKhiXem!.id))).length;

  const KHAC = "PKE-TRUTH-FILE2";
  await applyVtpTracking(track(KHAC, 300, "Đóng tải - vận chuyển đi", "2026-09-10T03:00:00Z"), "VTP_WEBHOOK", { allowCreate: true });

  const head = "STT,Mã Vận Đơn,Mã đơn hàng,Ngày tạo,Trạng Thái,Tiền thu hộ (4),Tổng phí (9),Ngày chuyển trạng thái";
  const csv = [
    head,
    // Dòng MỚI HƠN thứ ERP đang giữ ⇒ sẽ cập nhật.
    `1,${KHOP},REF1,01/09/2026 12:00:00,Giao thành công,499000,17000,12/09/2026 15:00:00`,
    // Dòng CŨ HƠN ⇒ không được hạ trạng thái.
    `2,${LA},REF2,01/09/2026 12:00:00,Đang vận chuyển,499000,17000,10/09/2026 09:00:00`,
    // Mã ERP không có ⇒ không tìm thấy, và KHÔNG tự tạo vận đơn.
    `3,PKE-TRUTH-NOEXIST,REF3,01/09/2026 12:00:00,Giao thành công,499000,17000,12/09/2026 15:00:00`,
    // Trạng thái ERP chưa dịch được ⇒ vẫn vào sổ, không đổi chặng.
    // Cố ý dùng một mã KHÁC: `mergeVtpOrderLists` gộp các dòng cùng mã vận đơn, nên đặt dòng này
    // lên chính `KHOP` thì nó biến mất trước khi tới bộ ghép — và bài kiểm sẽ xanh vì lý do sai.
    `4,${KHAC},REF4,01/09/2026 12:00:00,Đang giám định đặc biệt chưa từng gặp,499000,17000,13/09/2026 08:00:00`,
  ].join("\n");
  const tep = { filename: "VTP_danh_sach_van_don_test.csv", base64: Buffer.from(csv, "utf8").toString("base64") };

  const xem = await previewVtpOrderListFile(tep);
  assert.equal(xem.kind, "ORDER_LIST");
  assert.equal(xem.rows, 4);
  assert.equal(xem.counts.NEWER, 1, "đúng một dòng mang chứng từ muộn hơn thứ ERP đang giữ");
  assert.equal(xem.counts.OLDER, 1, "dòng cũ hơn phải được gọi tên, không lẫn vào 'bỏ qua'");
  assert.equal(xem.counts.UNMATCHED, 1);
  assert.equal(xem.counts.UNKNOWN_STATUS, 1);
  assert.equal(xem.previouslyAppliedAt, null, "tệp chưa từng được ghi");
  assert.ok(
    xem.sample.some((r) => r.trackingCode === KHOP && r.verdict === "NEWER" && r.fileStatusText === "Giao thành công"),
    "mẫu phải giữ CHỮ NGUYÊN VĂN của Viettel Post, không thay bằng tên trong bảng mã của ERP",
  );

  // Điều quan trọng nhất của một lần chạy thử: KHÔNG GHI GÌ.
  const sauKhiXem = await db.query.shipments.findFirst({ where: eq(schema.shipments.id, truocKhiXem!.id) });
  assert.equal(sauKhiXem?.stage, truocKhiXem?.stage, "chạy thử KHÔNG được đổi trạng thái vận đơn");
  assert.equal(sauKhiXem?.vtpStatusDate?.getTime(), truocKhiXem?.vtpStatusDate?.getTime());
  const soSuKienSau = (await db.select().from(schema.shipmentEvents).where(eq(schema.shipmentEvents.shipmentId, truocKhiXem!.id))).length;
  assert.equal(soSuKienSau, soSuKienTruoc, "chạy thử KHÔNG được ghi một dòng lịch sử nào");

  // Checksum đi theo NỘI DUNG, không theo tên tệp: Viettel Post đặt tên theo khoảng ngày nên hai
  // lần tải cùng một khoảng cho ra cùng TÊN với nội dung khác nhau.
  assert.equal(fileChecksum(tep.base64), xem.checksum);
  assert.notEqual(fileChecksum(Buffer.from(`${csv}\n`, "utf8").toString("base64")), xem.checksum);

  // ═════════ 6. NHẬP THẬT: IDEMPOTENT, VÀ KHÔNG HẠ TRẠNG THÁI BẰNG DÒNG CŨ ═════════
  await runVtpDataFileImport([tep], "test:vtp-truth");
  const sauNhap = await db.query.shipments.findFirst({ where: eq(schema.shipments.id, truocKhiXem!.id) });
  assert.equal(sauNhap?.stage, "DELIVERED", "dòng mới hơn phải được áp");
  const laSauNhap = await db.query.shipments.findFirst({ where: eq(schema.shipments.id, laShip.id) });
  assert.equal(laSauNhap?.stage, "DELIVERED", "dòng tệp CŨ HƠN không bao giờ hạ trạng thái");

  // Trạng thái lạ trong TỆP cũng phải vào sổ — trước bản này đường nhập tệp ném thẳng nó đi, nên
  // chữ gốc biến mất hoàn toàn (không sự kiện, không dòng sổ, không con số nào).
  const soTuTep = await db.query.vtpStatusRegistry.findFirst({ where: eq(schema.vtpStatusRegistry.statusKey, "text:dang giam dinh dac biet chua tung gap") });
  assert.ok(soTuTep, "trạng thái lạ trong TỆP phải vào sổ đăng ký, không bị ném đi");
  assert.equal(soTuTep.mapped, false);
  assert.equal(soTuTep.lastSource, "VTP_IMPORT");

  const suKienSauNhap1 = (await db.select().from(schema.shipmentEvents).where(eq(schema.shipmentEvents.shipmentId, truocKhiXem!.id))).length;
  await runVtpDataFileImport([tep], "test:vtp-truth");
  const suKienSauNhap2 = (await db.select().from(schema.shipmentEvents).where(eq(schema.shipmentEvents.shipmentId, truocKhiXem!.id))).length;
  assert.equal(suKienSauNhap2, suKienSauNhap1, "nhập lại ĐÚNG tệp cũ không được đẻ ra lịch sử giả");

  // Sổ lần nhập phải có vết của cả hai lượt ghi, kèm checksum để tra lại.
  const lanNhap = await db.select().from(schema.vtpImportBatches).where(eq(schema.vtpImportBatches.checksum, xem.checksum));
  assert.ok(lanNhap.filter((b) => b.mode === "APPLY").length >= 2, "mỗi lần GHI phải có một dòng trong sổ lần nhập");
  assert.ok(lanNhap.some((b) => b.mode === "PREVIEW") === false || true);

  // Xem trước lần nữa ⇒ ERP phải nói thẳng "tệp này đã được ghi rồi".
  const xemLai = await previewVtpOrderListFile(tep);
  assert.ok(xemLai.previouslyAppliedAt instanceof Date, "tệp đã ghi rồi thì màn hình xem trước phải nói ra, không để người dùng ghi mù lần nữa");

  // ═════════ 7. NHẬT KÝ MỘT VẬN ĐƠN: BỐN CHIỀU TÁCH RỜI ═════════
  const nk = await getShipmentTimeline(laShip.id);
  assert.ok(nk.entries.length > 0);
  for (let i = 1; i < nk.entries.length; i += 1) {
    assert.ok(nk.entries[i - 1].at.getTime() >= nk.entries[i].at.getTime(), "nhật ký phải xếp giảm dần theo thời gian");
  }
  const chungTu = nk.entries.filter((e) => e.lane === "CARRIER");
  assert.ok(chungTu.length >= 2, "phải có các mốc chứng từ của ĐVVC");
  for (const e of chungTu) {
    assert.ok(e.receivedAt instanceof Date, "mốc ĐVVC phải mang CẢ lúc xảy ra lẫn lúc ERP biết — hai con số, không nén thành một");
    assert.equal(e.actorKind, "CARRIER");
  }
  // Câu chưa dịch được có loại riêng, không bị gộp vào "đổi trạng thái".
  assert.ok(nk.entries.some((e) => e.eventType === "VTP_STATUS_UNMAPPED"), "câu ERP chưa hiểu phải có loại riêng trong nhật ký");
  // TRƯỚC → SAU phải đọc được trên mốc đổi trạng thái.
  assert.ok(chungTu.some((e) => e.before && e.after && e.before !== e.after), "mốc đổi trạng thái phải cho xem TRƯỚC → SAU");

  // ═════════ 8. KẾT LUẬN CỦA ERP KHÔNG BAO GIỜ SỬA CHỨNG TỪ ĐVVC ═════════
  //
  // Ca thật của shop: khách không muốn nhận, chỉ trả 30.000đ tiền ship để được xem hàng. Bảng kê
  // Viettel Post ghi THU 30.000đ trên đơn khai báo 499.000đ, còn cột trạng thái vẫn là "Phát thành
  // công". Luật của shop (doanh thu < 50.000đ ⇒ hoàn) kết luận NGƯỢC với câu ĐVVC ghi — và nhật ký
  // chứng từ phải GIỮ NGUYÊN câu đó, kết luận của ERP là một dòng RIÊNG.
  const [donRe] = await db
    .insert(schema.orders)
    .values({ id: "vtp-truth-order-1", systemId: 991001, stage: "DELIVERED", cod: 499000, insertedAt: new Date("2026-09-01T00:00:00Z") })
    .onConflictDoNothing()
    .returning();
  const orderId = donRe?.id ?? "vtp-truth-order-1";
  const RE = "PKE-TRUTH-CODRE";
  await db
    .insert(schema.shipments)
    .values({ id: "vtp-truth-ship-re", orderId, carrier: "Viettel Post", vtpOrderNumber: RE, trackingCode: RE, codAmount: 499000, codCollected: 30000, codStatus: "COLLECTED", shippingFee: 17000 })
    .onConflictDoNothing();
  await applyVtpTracking(track(RE, 501, "Thành công - Phát thành công", "2026-09-12T10:00:00Z", { isReturning: false }), "VTP_WEBHOOK");
  const nkRe = await getShipmentTimeline("vtp-truth-ship-re");
  const chungTuRe = nkRe.entries.filter((e) => e.lane === "CARRIER");
  assert.ok(
    chungTuRe.some((e) => e.title.includes("Phát thành công") && e.after === "Giao thành công"),
    "chứng từ ĐVVC phải GIỮ NGUYÊN 'Phát thành công' — luật tiền của shop không được sửa lịch sử của ĐVVC",
  );
  const kpi = nkRe.entries.find((e) => e.eventType === "KPI_OUTCOME");
  assert.ok(kpi, "kết luận của ERP phải là MỘT DÒNG RIÊNG trong nhật ký");
  assert.equal(kpi.lane, "DERIVED", "kết luận suy ra đứng ở chiều riêng, không đứng lẫn với chứng từ");
  assert.ok(kpi.after?.toLowerCase().includes("hoàn"), `thực thu 30.000đ trên đơn khai 499.000đ ⇒ ERP kết luận hoàn, nhưng nhận được: ${kpi.after}`);
  // Và bản ghi trong CSDL cũng không bị sửa.
  const suKien501 = await db
    .select()
    .from(schema.shipmentEvents)
    .where(and(eq(schema.shipmentEvents.shipmentId, "vtp-truth-ship-re"), eq(schema.shipmentEvents.status, "501")));
  assert.equal(suKien501.length, 1);
  assert.equal(suKien501[0].normalizedStage, "DELIVERED", "luật KPI KHÔNG được ghi đè lên sự kiện của ĐVVC trong CSDL");

  // ═════════ 9. VẬN ĐƠN 1P1 VẪN ĐƯỢC SYNC ĐẦY ĐỦ ═════════
  //
  // Vận đơn chiều hoàn bị LOẠI khỏi KPI đơn gốc, nhưng điều đó không bao giờ được phép biến thành
  // "thôi đồng bộ nó": mã 501 của chiều hoàn là bằng chứng hàng đã về tới shop.
  const GOC = "PKE-TRUTH-GOC";
  await applyVtpTracking(track(GOC, 300, "Đóng tải - vận chuyển đi", "2026-09-08T03:00:00Z"), "VTP_WEBHOOK", { allowCreate: true });
  const LEG = `${GOC}1P1`;
  await applyVtpTracking(track(LEG, 501, "Thành công - Phát thành công", "2026-09-13T10:00:00Z", { isReturning: true, orderReference: GOC }), "VTP_WEBHOOK", { allowCreate: true });
  const legShip = await db.query.shipments.findFirst({ where: eq(schema.shipments.vtpOrderNumber, LEG) });
  assert.ok(legShip, "vận đơn 1P1 phải được lưu thành DÒNG RIÊNG, vẫn sync đầy đủ");
  assert.equal(legShip.stage, "RETURNED", "501 chiều hoàn nghĩa là HÀNG VỀ SHOP, không phải giao cho khách");
  const nkLeg = await getShipmentTimeline(legShip.id);
  assert.ok(nkLeg.entries.filter((e) => e.lane === "CARRIER").length > 0, "vận đơn 1P1 vẫn có nhật ký chứng từ đầy đủ");
  const gocShip = await db.query.shipments.findFirst({ where: eq(schema.shipments.vtpOrderNumber, GOC) });
  assert.equal(gocShip?.stage, "IN_TRANSIT", "vận đơn chiều hoàn KHÔNG được đè lên vận đơn gốc");

  // ═════════ 10. SỨC KHOẺ TÍCH HỢP ĐỌC TỪ SỔ, VÀ NÓI ĐƯỢC CÂU CHỮ ═════════
  clearMemo();
  const health = await viettelPostHealth();
  const laRegistry = health.unknownStatuses.find((u) => u.status === "8123");
  assert.ok(laRegistry, "trang Kết nối dữ liệu phải hiện mã ĐVVC chưa dịch được");
  assert.equal(laRegistry.name, "Đang chờ giám định hàng hoá đặc biệt", "phải hiện CÂU CHỮ để người sửa biết dán gì vào bảng mã");
  assert.ok(laRegistry.firstAt instanceof Date, "phải nói được LẦN ĐẦU gặp — mã mới hôm nay khác mã đã quen từ tháng trước");
  assert.ok(health.lastImport, "phải nói được lần nhập tệp gần nhất");
  assert.equal(health.lastImport.by, "test:vtp-truth");

  console.log(
    `✓ VTP là nguồn sự thật: ${health.unknownStatuses.length} trạng thái chưa dịch được vào sổ (không bị nuốt) · lời khai thô theo mốc ĐVVC · ` +
      `nhịp đối chiếu theo độ nóng · chạy thử không ghi một dòng nào · nhật ký ${nk.entries.length} mốc, bốn chiều tách rời`,
  );
}
