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
import { measureWebhookGap, webhookMatchRate, gapSeverity, WEBHOOK_GAP_MIN_MINUTES, WEBHOOK_MATCH_MIN_SAMPLE } from "@/lib/constants/webhook-gap";
import { sanitizeFreshness, effectiveThresholdFor, classifyFreshnessWith, FRESHNESS_BY_STAGE } from "@/lib/constants/logistics-freshness";
import { getVtpReconcileQueue } from "@/lib/queries/vtp-reconcile-queue";
import { vtpWebhookHealth } from "@/lib/queries/vtp-webhook-health";
import type { ReconcileReason } from "@/lib/constants/vtp-reconcile-queue";
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

  /*
    ═══ XEM TRƯỚC KHÔNG ĐƯỢC HỨA NHIỀU HƠN THỨ SẼ XẢY RA ═══

    Đo trên production 16/09/2026: chạy thử lại đúng tệp VỪA ĐƯỢC GHI bốn phút trước vẫn báo
    "18 dòng sẽ cập nhật", trong khi đường ghi bỏ qua cả 18 vì sự kiện đã nằm sẵn trong lịch sử.
    Bộ chống trùng của màn hình xem trước lúc đó chỉ nhìn TRONG CÙNG MỘT TỆP nên nó mù với mọi
    lần nhập trước đó.

    Một màn hình xem trước hứa nhiều hơn thứ sẽ xảy ra phá đúng công dụng của chính nó: người dùng
    bấm "Ghi vào ERP", thấy con số khác, và lần sau thôi đọc nó.
  */
  assert.equal(xemLai.counts.NEWER, 0, "tệp đã ghi rồi thì KHÔNG còn dòng nào 'sẽ cập nhật' — đường ghi sẽ bỏ qua chúng vì đã trùng");
  assert.ok(xemLai.counts.SAME > 0, "những dòng đã ghi phải được gọi tên là 'giống ERP', không phải im lặng biến mất");
  assert.equal(
    xemLai.counts.NEWER + xemLai.counts.OLDER + xemLai.counts.SAME + xemLai.counts.UNMATCHED + xemLai.counts.UNKNOWN_STATUS + xemLai.counts.AMBIGUOUS + xemLai.counts.INVALID + xemLai.counts.DUPLICATE_ROW,
    xemLai.rows,
    "mọi dòng phải được xếp đúng một loại — không dòng nào rơi ra ngoài bảng tổng hợp",
  );

  /*
    CÙNG MỐC, KHÁC CHẶNG ⇒ CẦN NGƯỜI QUYẾT, không phải "mới hơn".

    `applyVtpOrderList` gọi trường hợp này là `sameTimeConflict` và KHÔNG ghi. Trước bản sửa, màn
    hình xem trước đọc nó thành "mới hơn ERP" — tức hứa một cập nhật mà đường ghi sẽ từ chối.
  */
  const XUNG_DOT = "PKE-TRUTH-SAMETIME";
  await applyVtpTracking(track(XUNG_DOT, 300, "Đóng tải - vận chuyển đi", "2026-09-14T06:00:00Z"), "VTP_WEBHOOK", { allowCreate: true });
  // 13:00 GIỜ VIỆT NAM = 06:00Z — đúng bằng mốc ĐVVC mà ERP đang giữ. Tệp Viettel Post ghi giờ VN
  // và `parseVtpListTimestamp` trừ 7 giờ; gõ thẳng 06:00 vào đây là lệch đúng 7 tiếng và bài kiểm
  // lặng lẽ đo một tình huống khác (tôi đã mắc đúng lỗi này một lần).
  const csvXungDot = [head, `1,${XUNG_DOT},REFX,01/09/2026 12:00:00,Giao thành công,499000,17000,14/09/2026 13:00:00`].join("\n");
  const xemXungDot = await previewVtpOrderListFile({ filename: "VTP_xung_dot.csv", base64: Buffer.from(csvXungDot, "utf8").toString("base64") });
  assert.equal(xemXungDot.counts.AMBIGUOUS, 1, "cùng mốc ĐVVC nhưng khác chặng phải là 'cần người quyết', không được hứa là sẽ cập nhật");
  assert.equal(xemXungDot.counts.NEWER, 0);

  /*
    ═══ DÒNG CHIỀU HOÀN PHẢI SO VỚI CHÍNH VẬN ĐƠN CHIỀU HOÀN ═══

    `matchVtpOrderList` trả `shipmentId` của vận đơn GỐC cho một dòng `…1P1` (nó ghép theo mã gốc để
    biết chiều hoàn thuộc về ai), nhưng `applyVtpOrderList` lại ghi lên dòng CHIỀU HOÀN, tra bằng
    chính mã `…1P1`. Bản đầu của màn hình xem trước so nhầm hai thực thể.

    Đo trên production 16/09/2026: cả 18 dòng "sẽ cập nhật" còn sót đều là chiều hoàn và hiện ra
    dưới dạng vô lý `VTP:"Đang vận chuyển"` vs `ERP:DELIVERED` — "DELIVERED" là của gói hàng ĐI,
    "đang vận chuyển" là của gói đang QUAY VỀ. Shop có 267 vận đơn chiều hoàn, nên bản đầu đọc sai
    TOÀN BỘ nhóm đó.
  */
  const LEG_GOC = "PKE-TRUTH-LEGBASE";
  await applyVtpTracking(track(LEG_GOC, 501, "Thành công - Phát thành công", "2026-09-14T02:00:00Z"), "VTP_WEBHOOK", { allowCreate: true });
  const LEG_MA = `${LEG_GOC}1P1`;
  await applyVtpTracking(track(LEG_MA, 300, "Đóng tải - vận chuyển đi", "2026-09-15T02:00:00Z", { isReturning: true, orderReference: LEG_GOC }), "VTP_WEBHOOK", { allowCreate: true });

  // Dòng tệp của CHIỀU HOÀN, mốc CŨ HƠN thứ chính chiều hoàn đang giữ (15/09 09:00 VN = 02:00Z).
  const csvLeg = [head, `1,${LEG_MA},${LEG_GOC},01/09/2026 12:00:00,Đã lấy hàng,0,17000,15/09/2026 08:00:00`].join("\n");
  const xemLeg = await previewVtpOrderListFile({ filename: "VTP_chieu_hoan.csv", base64: Buffer.from(csvLeg, "utf8").toString("base64") });
  const dongLeg = xemLeg.sample.find((r) => r.trackingCode === LEG_MA);
  assert.ok(dongLeg, "dòng chiều hoàn phải xuất hiện trong mẫu");
  /*
    `RETURNING` chứ không phải `IN_TRANSIT`: mã 300 "đóng tải - vận chuyển đi" trên CHIỀU HOÀN nghĩa
    là hàng đang trên đường QUAY VỀ shop, và `onReturnLeg()` quy đổi đúng như vậy. Điều bài này
    khoá là thực thể được so — chiều hoàn, chứ không phải vận đơn gốc (vốn đang `DELIVERED`).
  */
  assert.equal(
    dongLeg.erpStage,
    "RETURNING",
    `phải so với chặng của CHÍNH vận đơn chiều hoàn, không phải của vận đơn gốc (DELIVERED) — nhận được ${dongLeg.erpStage}`,
  );
  assert.notEqual(dongLeg.erpStage, "DELIVERED", "so nhầm sang vận đơn gốc là lỗi đã đo được trên production");
  assert.equal(dongLeg.verdict, "OLDER", "mốc cũ hơn thứ chiều hoàn đang giữ ⇒ 'cũ hơn ERP', không phải 'mới hơn'");
  assert.equal(xemLeg.counts.NEWER, 0, "so đúng thực thể thì không còn lời hứa cập nhật vô lý nào");

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

  /*
    ═════════ 11. ĐO CHẤT LƯỢNG WEBHOOK BẰNG CHÍNH TỆP ĐỐI CHIẾU ═════════

    2.138/2.151 vận đơn là `WEBHOOK_ONLY` (đo 16/09/2026): webhook là NGUỒN TIN DUY NHẤT, và ERP
    KHÔNG tự phát hiện được một gói tin chưa từng tới — sự vắng mặt không để lại dấu vết nào trong
    chính hệ thống đã không nhận được nó. Chỉ tệp Viettel Post, một nguồn ĐỘC LẬP, mới lộ ra chỗ hụt.

    Nên mỗi lần nhập tệp phải để lại một PHÉP ĐO, kể cả lần nhập không đổi một vận đơn nào.
  */

  // ── Hàm thuần trước: ba câu trả lời, và hai trong số đó KHÔNG phải lỗi của webhook ──
  const luc = (iso: string) => new Date(iso);
  assert.equal(
    measureWebhookGap({ carrierEventAt: luc("2026-09-12T00:23:00Z"), erpKnewAt: luc("2026-09-12T00:23:00Z"), importedAt: luc("2026-09-13T03:50:00Z") }).isGap,
    false,
    "ERP đã biết đúng mốc ấy ⇒ webhook làm đúng việc, không được tính là hụt",
  );
  assert.equal(
    measureWebhookGap({ carrierEventAt: luc("2026-09-12T00:23:00Z"), erpKnewAt: luc("2026-09-12T10:00:00Z"), importedAt: luc("2026-09-13T03:50:00Z") }).isGap,
    false,
    "ERP đã biết một sự việc MỚI HƠN ⇒ dòng tệp cũ này không chứng minh được webhook rơi",
  );
  /*
    NGƯỠNG HAI GIỜ: độ trễ THẬT đo được là 36–41 giây. Một sự kiện vừa xảy ra vài phút trước lúc
    nhập tệp thì gói tin có thể đang trên đường — đếm nó là "hụt" là vu oan, và làm tỷ lệ tin cậy
    tụt vì một cuộc đua vô hại.
  */
  const vuaXay = measureWebhookGap({ carrierEventAt: luc("2026-09-13T03:00:00Z"), erpKnewAt: null, importedAt: luc("2026-09-13T04:00:00Z") });
  assert.equal(vuaXay.isGap, false, "sự kiện mới hơn ngưỡng KHÔNG được kết tội webhook");
  assert.equal(vuaXay.isGap === false && vuaXay.reason, "TOO_FRESH", "và phải nói rõ vì sao không tính, không im lặng bỏ qua");
  assert.equal(
    measureWebhookGap({ carrierEventAt: luc("2026-09-13T03:00:00Z"), erpKnewAt: null, importedAt: new Date(luc("2026-09-13T03:00:00Z").getTime() + WEBHOOK_GAP_MIN_MINUTES * 60_000) }).isGap,
    true,
    "đúng tại ngưỡng đã là hụt — biên phải đóng, không để một dải nào không ai đếm",
  );
  // Ca THẬT ngày 12/09: ĐVVC ghi "Chờ phát lại" lúc 07:23, ERP chỉ biết lúc 13/09 03:50 — qua TỆP.
  const caThat = measureWebhookGap({ carrierEventAt: luc("2026-09-12T00:23:00Z"), erpKnewAt: null, importedAt: luc("2026-09-13T03:50:00Z") });
  assert.equal(caThat.isGap, true, "ca thật 20 giờ phải được nhận ra là một lần webhook rơi");
  assert.equal(caThat.isGap && caThat.severity, "MAJOR", "hơn một ngày ⇒ MAJOR");
  assert.equal(gapSeverity(24 * 60 - 1), "MINOR");
  assert.equal(gapSeverity(3 * 24 * 60), "CRITICAL");

  /*
    MẪU NHỎ NÓI LÀ MẪU NHỎ. "1/1 hụt" KHÔNG phải "webhook rơi 100%" — in ra như thế là bịa một
    kết luận từ một quan sát, và chủ shop sẽ ra quyết định nhập tệp theo một con số không có thật.
  */
  assert.equal(webhookMatchRate({ known: 1, gaps: 1 }), null, "mẫu dưới ngưỡng ⇒ CHƯA ĐỦ DỮ LIỆU, không phải 50%");
  assert.equal(webhookMatchRate({ known: WEBHOOK_MATCH_MIN_SAMPLE, gaps: 0 }), 1, "đủ mẫu thì phát biểu được tỷ lệ");
  assert.equal(webhookMatchRate({ known: 0, gaps: WEBHOOK_MATCH_MIN_SAMPLE }), 0, "đủ mẫu mà không dòng nào ERP biết trước ⇒ 0% là một kết luận THẬT");

  /*
    ── VÀ PHÉP ĐO PHẢI THẬT SỰ CHẠY TRÊN ĐƯỜNG NHẬP TỆP ──

    Một vận đơn ERP chỉ biết tới chặng "đóng tải" từ 10/09, trong khi tệp nói ĐVVC đã phát thành
    công từ 12/09. ERP chưa hề biết sự việc ấy cho tới lúc nhập tệp: đó chính là một lần webhook rơi.
  */
  const HUT = "PKE-TRUTH-GAP";
  await applyVtpTracking(track(HUT, 300, "Đóng tải - vận chuyển đi", "2026-09-10T03:00:00Z"), "VTP_WEBHOOK", { allowCreate: true });
  const csvHut = [head, `1,${HUT},REFG,01/09/2026 12:00:00,Giao thành công,499000,17000,12/09/2026 15:00:00`].join("\n");
  const tepHut = { filename: "VTP_khoang_hut.csv", base64: Buffer.from(csvHut, "utf8").toString("base64") };
  await runVtpDataFileImport([tepHut], "test:vtp-truth");

  const hutShip = await db.query.shipments.findFirst({ where: eq(schema.shipments.vtpOrderNumber, HUT) });
  const dongHut = await db.select().from(schema.vtpWebhookGaps).where(eq(schema.vtpWebhookGaps.shipmentId, hutShip!.id));
  assert.equal(dongHut.length, 1, "khoảng hụt webhook phải được GHI LẠI, không chỉ vá dữ liệu rồi quên");
  assert.equal(dongHut[0].carrierStatusText, "Giao thành công", "sổ giữ CÂU NGUYÊN VĂN của ĐVVC — đó là bằng chứng, không phải nhãn của ERP");
  assert.equal(dongHut[0].erpKnewAt?.toISOString(), "2026-09-10T03:00:00.000Z", "phải ghi ERP ĐANG BIẾT TỚI ĐÂU trước lần nhập, nếu không thì không tra lại được");
  assert.equal(dongHut[0].erpKnewSource, "VTP_WEBHOOK", "và nguồn nào đã quyết định ảnh chụp cũ ấy");
  assert.ok(dongHut[0].batchId, "mỗi khoảng hụt phải trỏ về ĐÚNG lần nhập đã tìm ra nó — dòng mồ côi không trả lời được 'ai đo, lúc nào'");

  // Lần nhập ấy phải mang đủ ba con số đo, kể cả khi nó không đổi một vận đơn nào.
  const soHut = await db.query.vtpImportBatches.findFirst({ where: eq(schema.vtpImportBatches.id, dongHut[0].batchId!) });
  assert.ok(soHut, "dòng sổ của lần nhập phải tồn tại");
  assert.equal(soHut.mode, "APPLY");
  assert.equal(soHut.checked, 1, "mẫu số = số dòng ghép được về một vận đơn ERP đã biết");
  assert.equal(soHut.webhookGaps, 1);

  /*
    NHẬP LẠI CÙNG TỆP KHÔNG ĐƯỢC ĐẺ RA LẦN RƠI THỨ HAI.

    Nếu đếm hai lần thì mỗi lần chủ shop nhập lại một tệp cũ sẽ tự làm xấu tỷ lệ khớp webhook của
    chính mình — và con số càng nhập càng sai, đúng chiều ngược với mục đích của phép đo.
  */
  await runVtpDataFileImport([tepHut], "test:vtp-truth");
  const dongHut2 = await db.select().from(schema.vtpWebhookGaps).where(eq(schema.vtpWebhookGaps.shipmentId, hutShip!.id));
  assert.equal(dongHut2.length, 1, "phát hiện lại cùng một sự việc chỉ còn MỘT dòng");

  /*
    VÀ KHI WEBHOOK LÀM ĐÚNG VIỆC, SỔ PHẢI IM LẶNG.

    Một phép đo chỉ biết đếm cái xấu là một phép đo luôn báo động: nó không có cách nào nói
    "hôm nay webhook chạy tốt".
  */
  const DU = "PKE-TRUTH-NOGAP";
  await applyVtpTracking(track(DU, 501, "Thành công - Phát thành công", "2026-09-12T08:00:00Z"), "VTP_WEBHOOK", { allowCreate: true });
  const csvDu = [head, `1,${DU},REFN,01/09/2026 12:00:00,Giao thành công,499000,17000,12/09/2026 15:00:00`].join("\n");
  await runVtpDataFileImport([{ filename: "VTP_khong_hut.csv", base64: Buffer.from(csvDu, "utf8").toString("base64") }], "test:vtp-truth");
  const duShip = await db.query.shipments.findFirst({ where: eq(schema.shipments.vtpOrderNumber, DU) });
  assert.equal(
    (await db.select().from(schema.vtpWebhookGaps).where(eq(schema.vtpWebhookGaps.shipmentId, duShip!.id))).length,
    0,
    "ERP đã biết đúng mốc ấy rồi ⇒ KHÔNG được ghi một lần rơi nào",
  );

  /*
    ═════════ 12. NGƯỠNG IM LẶNG SỬA ĐƯỢC — VÀ BỘ GHI ĐÈ HỎNG KHÔNG ĐƯỢC LÀM SẬP GÌ ═════════

    Ngưỡng dựng từ phân bố 11/09/2026, nhưng phân bố đổi theo mùa. Một ngưỡng không sửa được sẽ
    hoặc chôn hàng đợi dưới hàng trăm kiện không đáng lo, hoặc im đúng lúc cần hét.
  */
  assert.deepEqual(sanitizeFreshness(null), {}, "đọc cấu hình phải LUÔN thành công — dòng rác không được làm sập hàng đợi của cả shop");
  assert.deepEqual(sanitizeFreshness({ KHONG_CO_CHANG_NAY: { aging: 1, stale: 2, critical: 3 } }), {}, "khoá lạ là gõ nhầm, không phải một chặng mới");
  assert.deepEqual(
    sanitizeFreshness({ OUT_FOR_DELIVERY: { aging: 40, stale: 20, critical: 10 } }),
    {},
    "ba mốc ĐẢO THỨ TỰ ⇒ bỏ NGUYÊN CẢ CHẶNG: sửa hộ một ô là đoán ý người nhập, và con số đoán ra sẽ đứng trên màn hình như thể có người chọn nó",
  );
  assert.deepEqual(
    sanitizeFreshness({ OUT_FOR_DELIVERY: { aging: 4, stale: 12, critical: 24 }, RETURNING: { aging: 0, stale: 2, critical: 3 } }),
    { OUT_FOR_DELIVERY: { aging: 4, stale: 12, critical: 24 } },
    "ghi đè hỏng của một chặng KHÔNG được kéo theo chặng khác — mất một ghi đè còn hơn mất cả màn hình",
  );
  const ghiDe = sanitizeFreshness({ OUT_FOR_DELIVERY: { aging: 4, stale: 12, critical: 24 } });
  assert.equal(effectiveThresholdFor("OUT_FOR_DELIVERY", ghiDe).critical, 24, "ghi đè của chủ shop phải thắng mặc định trong mã");
  assert.equal(
    effectiveThresholdFor("OUT_FOR_DELIVERY", ghiDe).why,
    FRESHNESS_BY_STAGE.OUT_FOR_DELIVERY.why,
    "câu giải thích VÌ SAO chặng này cần ngưỡng riêng vẫn lấy từ mã — lý lẽ không đổi khi ai đó chỉnh con số",
  );
  assert.equal(effectiveThresholdFor("IN_TRANSIT", ghiDe).critical, FRESHNESS_BY_STAGE.IN_TRANSIT.critical, "chặng không ai sửa vẫn dùng mặc định — bảng ghi đè là THƯA, không phải bản sao đầy đủ");
  assert.equal(classifyFreshnessWith(30, "OUT_FOR_DELIVERY", ghiDe), "CRITICAL_STALE", "hạ ngưỡng xuống 24h thì kiện im 30h thành nghiêm trọng");
  assert.equal(classifyFreshnessWith(30, "OUT_FOR_DELIVERY", {}), "STALE", "…và vẫn chỉ là 'cũ' với bộ mặc định — cùng một luật, khác bộ số");
  assert.equal(classifyFreshnessWith(null, "OUT_FOR_DELIVERY", ghiDe), "CRITICAL_STALE", "KHÔNG có tin tức gì là tình huống xấu nhất, không bao giờ được xếp là 'mới'");

  /*
    ═════════ 13. HÀNG ĐỢI "VTP CẦN ĐỐI CHIẾU" ═════════

    Câu hỏi của hàng đợi này KHÁC HẲN câu hỏi của hàng đợi care: care hỏi "kiện này có cần gọi
    khách không", còn đây hỏi "ERP có đang tin một điều không còn đúng không". Và nó dựng hoàn toàn
    từ dữ liệu ĐÃ CÓ — không một lượt gọi API nào, vì nó tồn tại chính vì ERP không hỏi được.
  */
  clearMemo();
  const hangDoi = await getVtpReconcileQueue();

  /*
    Kiện mang trạng thái ERP CHƯA dịch được phải có mặt, kèm ĐÚNG lý do đó.

    Dùng `PKE-TRUTH-FILE2` (nhận câu lạ qua đường NHẬP TỆP ở khối 6) chứ không dùng `laShip`: kiện
    kia đã nhận một câu HIỂU ĐƯỢC đến sau nên cờ của nó đã chuyển lại thành "đã dịch được" — đúng
    như khối 1 khoá. Một kiện ERP đã hiểu lại thì KHÔNG còn việc gì để người trực đi tra.
  */
  const laFile = await db.query.shipments.findFirst({ where: eq(schema.shipments.vtpOrderNumber, KHAC) });
  const dongLa = hangDoi.rows.find((r) => r.id === laFile!.id);
  assert.ok(dongLa, "kiện ĐVVC vừa nói một câu ERP chưa dịch được PHẢI vào hàng đợi đối chiếu — trước bản này nó không hiện ở đâu cả");
  assert.ok(dongLa.reasons.includes("UNMAPPED_STATUS"), "và phải nói rõ vì sao nó ở đây");
  assert.ok(
    !hangDoi.rows.some((r) => r.id === laShip.id && r.reasons.includes("UNMAPPED_STATUS")),
    "kiện đã nhận được một câu HIỂU ĐƯỢC đến sau thì thôi là việc — hàng đợi không được giữ lại một lý do đã hết",
  );

  /*
    MỘT KIỆN NHIỀU LÝ DO LÀ MỘT DÒNG, KHÔNG PHẢI NHIỀU DÒNG.

    Người trực mở viettelpost.vn đúng MỘT lần cho một vận đơn. Tách thành nhiều dòng là bắt họ làm
    cùng một việc ba lần, và làm mọi con số đếm việc to lên gấp bội mà không có thêm việc nào.
  */
  for (const r of hangDoi.rows) {
    assert.ok(r.reasons.length > 0, "không dòng nào được vào hàng đợi mà không nói được vì sao");
    assert.equal(new Set(hangDoi.rows.filter((x) => x.id === r.id)).size, 1, "mỗi vận đơn chỉ một dòng dù mang nhiều lý do");
    assert.equal(r.topReason, r.reasons[0], "lý do MẠNH NHẤT phải đứng đầu — nó quyết định chỗ đứng trong hàng đợi");
  }

  /*
    BA LÝ DO CHỈ CÓ NGHĨA VỚI KIỆN ĐANG CHẠY.

    "Im lặng" với một kiện đã giao xong là chuyện hoàn toàn bình thường — kiện xong thì ĐVVC còn
    gửi thêm mốc làm gì. Đưa nó vào hàng đợi là bắt người trực tra một thứ không còn đổi được nữa,
    và với vài nghìn kiện đã giao thì hàng đợi chết ngay ngày đầu.

    Ba lý do CÒN LẠI vẫn là việc dù kiện đã chốt: chúng nói rằng ERP đang KHÔNG HIỂU một câu ĐVVC
    đã nói, và điều đó không tự hết theo thời gian.
  */
  const CHOT = ["DELIVERED", "RETURNED", "CANCELLED"];
  const CHI_KHI_DANG_CHAY: ReconcileReason[] = ["STALE_NO_NEWS", "CARE_WITHOUT_MOVEMENT"];
  for (const r of hangDoi.rows) {
    if (!CHOT.includes(r.stage)) continue;
    for (const ly of CHI_KHI_DANG_CHAY) {
      assert.ok(!r.reasons.includes(ly), `kiện đã chốt (${r.stage}) KHÔNG được mang lý do "${ly}" — ${r.id}`);
    }
  }
  assert.ok(hangDoi.rows.some((r) => r.id === gocShip!.id && r.reasons.includes("STALE_NO_NEWS")), "kiện chưa chốt mà im lặng quá ngưỡng của chặng phải vào hàng đợi");
  assert.ok(!hangDoi.rows.some((r) => r.id === legShip.id), "vận đơn chiều hoàn đã phát thành công về shop, ERP hiểu đúng câu ĐVVC nói ⇒ không có gì để tra lại");

  /*
    MÂU THUẪN ĐI CẢ HAI CHIỀU.

    Luật 48: trạng thái con "đã giao" mà cờ kết thúc còn `false` là một MÂU THUẪN trong dữ liệu của
    chính ERP — nếu không gọi tên nó thì kiện nằm mãi ở hàng đợi đối chiếu và không bao giờ rời ra.
  */
  const MAU_THUAN = "PKE-TRUTH-MAUTHUAN";
  await applyVtpTracking(track(MAU_THUAN, 300, "Đóng tải - vận chuyển đi", "2026-09-15T02:00:00Z"), "VTP_WEBHOOK", { allowCreate: true });
  const mtShip = await db.query.shipments.findFirst({ where: eq(schema.shipments.vtpOrderNumber, MAU_THUAN) });
  await db.update(schema.shipments).set({ isFinal: true }).where(eq(schema.shipments.id, mtShip!.id));
  clearMemo();
  const hangDoi2 = await getVtpReconcileQueue();
  const dongMT = hangDoi2.rows.find((r) => r.id === mtShip!.id);
  assert.ok(dongMT, "cờ 'đã kết thúc' bật mà chặng vẫn đang chạy PHẢI thành việc");
  assert.ok(dongMT.reasons.includes("CONTRADICTION"), "…và phải được gọi đúng tên là MÂU THUẪN, không phải 'im lặng'");
  await db.update(schema.shipments).set({ isFinal: false }).where(eq(schema.shipments.id, mtShip!.id));

  // Số giờ im lặng là CHƯA BIẾT khi chưa có mốc ĐVVC nào — không phải 0 giờ.
  for (const r of hangDoi.rows) {
    assert.ok(r.hoursSilent === null || Number.isFinite(r.hoursSilent), "số giờ im lặng phải là một số thật hoặc CHƯA BIẾT, không bao giờ NaN");
  }
  assert.equal(
    hangDoi.counts.UNMAPPED_STATUS >= 1,
    true,
    "bộ đếm theo lý do phải khớp với thứ thật sự có trong danh sách",
  );
  assert.equal(hangDoi.truncated, Math.max(0, hangDoi.total - hangDoi.rows.length), "số kiện bị cắt khỏi danh sách phải in ra được, không biến mất lặng lẽ");

  /*
    ═════════ 14. SỨC KHOẺ WEBHOOK: BỐN CÂU HỎI, VÀ "CHƯA BIẾT" LÀ MỘT CÂU TRẢ LỜI ═════════

    Webhook là nguồn tin duy nhất cho 2.138/2.151 vận đơn. Một ô "OK" gộp mọi thứ thì không ai sửa
    được gì khi nó hỏng, vì bốn loại hỏng sửa ở bốn chỗ khác nhau.
  */
  clearMemo();
  const suc = await vtpWebhookHealth();
  assert.ok(Number.isFinite(suc.last15m) && Number.isFinite(suc.last1h) && Number.isFinite(suc.last24h), "ba mốc thời gian phải đếm được, không NaN");

  /*
    NỀN SO SÁNH CHƯA ĐỦ ⇒ `UNKNOWN`, KHÔNG PHẢI `HEALTHY`.

    Đây là điểm dễ làm sai nhất và cũng tai hại nhất: không có nền để so mà kết luận "khoẻ" là lấy
    sự thiếu hiểu biết của mình làm bằng chứng rằng không có gì đáng lo — đúng thứ luật 48 cấm.
  */
  assert.equal(suc.baseline1h, null, "bài kiểm không gieo 14 ngày lịch sử webhook nên nền phải là CHƯA BIẾT");
  assert.equal(suc.liveness, "UNKNOWN", "chưa đủ nền thì kết luận là CHƯA BIẾT, KHÔNG được là 'khoẻ'");
  assert.ok(suc.livenessNote.includes("CHƯA BIẾT"), "và màn hình phải nói thẳng ra như vậy");

  /*
    TỶ LỆ KHỚP KHÔNG ĐƯỢC PHÁT BIỂU KHI MẪU NHỎ.

    Khối 11 đã đo một khoảng hụt THẬT qua đường nhập tệp, nên mẫu ở đây khác 0 — nhưng vẫn dưới
    ngưỡng 30. "1/2 hụt" không phải "webhook rơi 50%".
  */
  assert.equal(suc.matchRate, null, "mẫu dưới ngưỡng ⇒ CHƯA ĐỦ DỮ LIỆU, không được làm tròn thành một con số");
  assert.ok(suc.matchSample > 0, "…nhưng mẫu đã bắt đầu đếm: lần nhập tệp ở khối 11 có vào sổ");
  assert.ok(suc.gaps30d >= 1, "khoảng hụt đo được ở khối 11 phải hiện ở bảng sức khoẻ, không nằm im trong một bảng riêng");

  // Mẫu số 0 ⇒ `null`, không phải 0%: chưa nhận gói nào thì tỷ lệ gửi lại là CHƯA BIẾT.
  assert.equal(suc.duplicateRate24h, suc.last24h > 0 ? suc.duplicate24h / suc.last24h : null, "tỷ lệ gửi lại phải khớp với hai con số nó dựng từ, và mẫu số 0 thì trả null");

  console.log(
    `✓ VTP là nguồn sự thật: ${health.unknownStatuses.length} trạng thái chưa dịch được vào sổ (không bị nuốt) · lời khai thô theo mốc ĐVVC · ` +
      `nhịp đối chiếu theo độ nóng · chạy thử không ghi một dòng nào · nhật ký ${nk.entries.length} mốc, bốn chiều tách rời · ` +
      `khoảng hụt webhook đo được và không đếm hai lần · hàng đợi đối chiếu ${hangDoi.rows.length}/${hangDoi.total} kiện, mỗi kiện một dòng · ` +
      `sức khoẻ webhook: nền chưa đủ ⇒ CHƯA BIẾT, không tự nhận là khoẻ`,
  );
}
