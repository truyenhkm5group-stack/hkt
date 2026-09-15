import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { DEFAULT_ROLE_PERMISSIONS, resolvePermissions } from "@/lib/auth/permissions";
import { RESTOCK_UNIDENTIFIED_PERMISSION, isUnidentifiedCode, unidentifiedCode } from "@/lib/constants/return-unidentified";
import { CONFIDENCE_SCORE, IDENTITY_SIGNALS, RESCAN_DEBOUNCE_MS, SIGNAL_WEIGHT, scoreCandidate, shouldSkipRescan, type CandidateQuery } from "@/lib/constants/return-match";
import { searchReturnCandidates } from "@/lib/returns/candidate-match";
import { recordInspection } from "@/lib/returns/inspection";
import { findShipmentByScan, scanReceiveReturn } from "@/lib/returns/receive-scan";
import {
  createUnidentifiedReturn,
  identifyUnidentifiedReturn,
  listUnidentifiedReturns,
  markUnidentifiable,
  restockUnidentifiedReturn,
  setUnidentifiedCondition,
  unidentifiedSummary,
  unidentifiedTimeline,
} from "@/lib/returns/unidentified";

/**
 * ═══════════ HÀNG HOÀN MẤT NHÃN VÀ BÀN BẮN MÃ ═══════════
 *
 * Bài kiểm này khoá đúng MỘT bất biến, lặp lại ở mọi đường ghi:
 *
 *     MỘT MÓN HÀNG VẬT LÝ CHỈ ĐƯỢC CỘNG VÀO TỒN ĐÚNG MỘT LẦN — dù nó đi bằng đường nào.
 *
 * Bốn đường có thể vi phạm nó, và cả bốn đều được thử ở đây:
 *  · bắn mã hai lần / hai người cùng bắn;
 *  · tái nhập một kiện mất nhãn hai lần;
 *  · nối một kiện mất nhãn vào vận đơn ĐÃ được đếm (cộng lần hai cho cùng món hàng);
 *  · hai kiện mất nhãn cùng nối vào một vận đơn.
 *
 * Bất biến thứ hai, mềm hơn nhưng dễ mất hơn: **mô tả hàng không bao giờ thắng định danh.** "Q004
 * đỏ đô XL" khớp hàng trăm đơn; một máy chấm điểm không giữ luật này sẽ luôn chọn ra được một đơn
 * trông thuyết phục, và gán một lượt hoàn cho khách đã nhận hàng xong.
 */
export async function testReturnUnidentified(db: Db) {
  // ═══════════════ PHẦN THUẦN: chấm điểm ứng viên ═══════════════

  const q: CandidateQuery = { tracking: "", orderCode: "", phone: "0987654321", customerName: "", sku: "Q004", color: "Đỏ đô", size: "XL" };
  const items = [{ sku: "Q004", name: "Áo Q004", color: "Đỏ đô", size: "XL" }];

  const coSDT = scoreCandidate(
    { ...q, sku: "", color: "", size: "" },
    { code: "PKE1", orderId: "o1", orderCode: "111", receiverName: "A", receiverPhone: "0987654321", stage: "RETURNED", returnedAt: new Date(), orderedAt: null, items },
  );
  const chiMoTa = scoreCandidate(
    { ...q, phone: "" },
    { code: "PKE2", orderId: "o2", orderCode: "222", receiverName: "B", receiverPhone: "0900000000", stage: "RETURNED", returnedAt: new Date(), orderedAt: null, items },
  );

  assert.ok(coSDT.score > chiMoTa.score, "một đơn có ĐÚNG SỐ ĐIỆN THOẠI phải thắng một đơn chỉ khớp mã hàng + màu + size");
  assert.equal(chiMoTa.confidence !== "HIGH", true, "khớp đủ mọi thuộc tính MÔ TẢ vẫn không được lên mức “Rất có thể” — đó là ca hàng bán chạy, trăm đơn cùng khớp");
  assert.equal(coSDT.confidence, "HIGH", "có bằng chứng định danh thì mới được lên mức “Rất có thể”");

  /*
    BẤT BIẾN Ở MỨC TRỌNG SỐ, không chỉ ở một ca ví dụ: bằng chứng định danh YẾU NHẤT vẫn phải lớn
    hơn TỔNG mọi bằng chứng mô tả cộng lại. Thiếu nó thì một ngày nào đó ai đó nâng trọng số mã
    hàng lên "cho nhạy hơn", và luật trên vỡ mà không bài nào đỏ.
  */
  const dinhDanhYeuNhat = Math.min(...IDENTITY_SIGNALS.map((k) => SIGNAL_WEIGHT[k]));
  const tongMoTa = (Object.keys(SIGNAL_WEIGHT) as (keyof typeof SIGNAL_WEIGHT)[])
    .filter((k) => !IDENTITY_SIGNALS.includes(k))
    .reduce((t, k) => t + SIGNAL_WEIGHT[k], 0);
  assert.ok(dinhDanhYeuNhat > tongMoTa, `bằng chứng định danh yếu nhất (${dinhDanhYeuNhat}) phải lớn hơn TỔNG mọi bằng chứng mô tả (${tongMoTa})`);
  assert.ok(CONFIDENCE_SCORE.HIGH > CONFIDENCE_SCORE.MEDIUM, "ngưỡng “rất có thể” phải cao hơn ngưỡng “có thể”");

  // Mã vận đơn có gạch nối trên nhãn nhưng máy quét gửi liền — hai dạng phải khớp nhau.
  const gachNoi = scoreCandidate(
    { ...q, tracking: "PKE-148-446", phone: "", sku: "", color: "", size: "" },
    { code: "PKE148446", orderId: "o1", orderCode: "1", receiverName: "", receiverPhone: "", stage: "RETURNED", returnedAt: null, orderedAt: null, items: [] },
  );
  assert.ok(gachNoi.signals.includes("TRACKING_EXACT"), "mã có gạch nối phải khớp với mã liền — máy quét không luôn gửi ký tự phân cách");

  // Màu và size chỉ được tính TRÊN DÒNG đã khớp mã hàng: so chéo làm một đơn hai dòng trông như
  // khớp hoàn hảo trong khi không dòng nào của nó là "Q004 XL".
  const soCheo = scoreCandidate(
    { ...q, phone: "" },
    {
      code: "PKE3",
      orderId: "o3",
      orderCode: "333",
      receiverName: "",
      receiverPhone: "",
      stage: "RETURNED",
      returnedAt: null,
      orderedAt: null,
      items: [
        { sku: "Q004", name: "Áo Q004", color: "Đen", size: "M" },
        { sku: "Q009", name: "Áo Q009", color: "Đỏ đô", size: "XL" },
      ],
    },
  );
  assert.ok(!soCheo.signals.includes("COLOR_MATCH") && !soCheo.signals.includes("SIZE_MATCH"), "màu/size của DÒNG KHÁC không được tính cho dòng đã khớp mã hàng");

  // ═══════════════ NHỊP MÁY QUÉT: bỏ mã NẢY, KHÔNG bỏ kiện THẬT ═══════════════

  /*
    Đây là luật dễ làm hỏng nhất theo hướng tệ nhất. Chống trùng quá tay thì hai kiện KHÁC NHAU bắn
    liền nhau (nhịp bình thường của máy quét) bị nuốt mất một — hàng có thật biến khỏi sổ, không
    một dòng lỗi nào. Chống trùng quá lỏng thì một cú bấm cò hơi lâu thành hai lượt ghi.
  */
  assert.equal(shouldSkipRescan(null, "PKE1", 1000), false, "lượt bắn đầu tiên không bao giờ bị bỏ");
  assert.equal(shouldSkipRescan({ code: "PKE1", at: 1000 }, "PKE1", 1000 + RESCAN_DEBOUNCE_MS - 1), true, "CÙNG mã, trong khoảng nảy phím ⇒ là cò nảy hai lần, bỏ qua");
  assert.equal(shouldSkipRescan({ code: "PKE1", at: 1000 }, "PKE1", 1000 + RESCAN_DEBOUNCE_MS + 1), false, "cùng mã nhưng đã qua khoảng nảy ⇒ người kho cố ý bắn lại, phải cho đi");
  assert.equal(shouldSkipRescan({ code: "PKE1", at: 1000 }, "PKE2", 1001), false, "HAI KIỆN KHÁC MÃ bắn cách nhau 1ms là nhịp THẬT của máy quét — bỏ một trong hai là làm mất hàng");
  assert.equal(shouldSkipRescan({ code: "PKE1", at: 1000 }, "PKE1", 1001, true), false, "lượt bấm CÓ CHỦ Ý của người (xác nhận kiện ngoài chặng hoàn) luôn đi qua");

  // ═══════════════ PHẦN CSDL: dàn cảnh ═══════════════

  await db.insert(schema.products).values({ id: "ur-prod", name: "Áo hàng hoàn mất nhãn" }).onConflictDoNothing();
  await db
    .insert(schema.productVariants)
    .values([
      { id: "ur-var", productId: "ur-prod", sku: "UR-001", color: "Đỏ đô", size: "XL", retailPrice: 250000 },
      { id: "ur-var-2", productId: "ur-prod", sku: "UR-002", color: "Đen", size: "M", retailPrice: 250000 },
    ])
    .onConflictDoNothing();
  await db.insert(schema.orders).values({ id: "ur-order-1", systemId: 778899, stage: "RETURNED", status: 6, insertedAt: new Date("2026-09-01T00:00:00Z") }).onConflictDoNothing();
  await db
    .insert(schema.orderItems)
    .values({ id: "ur-item-1", orderId: "ur-order-1", variantId: "ur-var", productId: "ur-prod", productName: "Áo hàng hoàn mất nhãn", sku: "UR-001", quantity: 1, unitPrice: 250000, lineTotal: 250000 })
    .onConflictDoNothing();
  await db
    .insert(schema.shipments)
    .values([
      { id: "ur-ship-1", orderId: "ur-order-1", vtpOrderNumber: "URPKE0001", stage: "RETURNED", returnedAt: new Date("2026-09-10T00:00:00Z"), receiverName: "Chị Lan", receiverPhone: "0912345678" },
      // Kiện đã giao thành công: dùng để kiểm nhánh "ngoài chặng hoàn" của bàn bắn mã.
      { id: "ur-ship-giao", orderId: "ur-order-1", vtpOrderNumber: "URPKE0002", stage: "DELIVERED", vtpStatusName: "Giao thành công", receiverName: "Chị Lan", receiverPhone: "0912345678" },
    ])
    .onConflictDoNothing();

  /** Tổng số món ĐÃ VÀO TỒN qua phiếu tái nhập mang mã kiện mất nhãn — thước đo duy nhất đáng tin. */
  const tonCuaUR = async (code: string) => {
    const rows = await db
      .select({ q: schema.stockReceiptItems.quantity })
      .from(schema.stockReceiptItems)
      .innerJoin(schema.stockReceipts, eq(schema.stockReceipts.id, schema.stockReceiptItems.receiptId))
      .where(sql`${schema.stockReceipts.reference} like ${`%${code}%`}`);
    return rows.reduce((t, r) => t + Number(r.q ?? 0), 0);
  };

  // ═══════════════ 1. BẮN MÃ NHẬN KIỆN ═══════════════

  const tim = await findShipmentByScan("urpke0001");
  assert.equal(tim?.shipmentId, "ur-ship-1", "bắn mã không phân biệt hoa/thường — máy quét trả về cả hai dạng");
  // Nhãn in có gạch nối, máy quét thì không luôn gửi kèm — hai dạng phải ra CÙNG một kiện.
  assert.equal((await findShipmentByScan("UR-PKE-0001"))?.shipmentId, "ur-ship-1", "mã có gạch nối phải ra đúng kiện của mã liền");
  // Nhưng KHÔNG có đường "khớp gần đúng": một mã khác là một kiện khác, hoặc không kiện nào.
  assert.equal(await findShipmentByScan("URPKE000"), null, "bắn thiếu ký tự cuối KHÔNG được trả bừa một kiện gần giống — ở đây trả nhầm kiện là ghi nhận sai kiện");
  assert.equal(await findShipmentByScan("   "), null, "bắn hụt (chuỗi rỗng) không trả về kiện nào");

  const lanDau = await scanReceiveReturn({ code: "URPKE0001", actor: { id: null, label: "nv-kho" } });
  assert.equal(lanDau.outcome, "RECEIVED", "bắn mã một kiện đang hoàn thì ghi nhận được ngay");

  /*
    ĐIỀU QUAN TRỌNG NHẤT CỦA BƯỚC NÀY: nhận kiện KHÔNG cộng tồn.
    Gộp hai việc là quay lại đúng cách làm cũ — ERP tự khẳng định kiện về đủ cho hàng trăm kiện
    chưa ai mở ra, và phần chênh nằm im trong số tồn tới kỳ kiểm kê.
  */
  const [phieu] = await db.select({ n: sql<number>`count(*)` }).from(schema.stockReceiptItems).where(eq(schema.stockReceiptItems.shipmentId, "ur-ship-1"));
  assert.equal(Number(phieu?.n ?? 0), 0, "BẮN MÃ NHẬN KIỆN KHÔNG ĐƯỢC SINH PHIẾU TÁI NHẬP NÀO — tồn chỉ đổi ở trạm đếm");

  const lanHai = await scanReceiveReturn({ code: "URPKE0001", actor: { id: null, label: "nv-kho-khac" } });
  assert.equal(lanHai.outcome, "ALREADY", "bắn lại lần hai phải là “đã nhận từ trước”, KHÔNG phải một lượt ghi mới");
  assert.equal(lanHai.parcel?.receivedBy, "nv-kho", "giữ nguyên người nhận lần đầu — lượt sau không đè quy kết");

  const [soPhieuKiem] = await db.select({ n: sql<number>`count(*)` }).from(schema.returnInspections).where(eq(schema.returnInspections.shipmentId, "ur-ship-1"));
  assert.equal(Number(soPhieuKiem?.n ?? 0), 1, "một kiện vật lý ⇒ đúng MỘT phiếu kiểm, dù bắn bao nhiêu lần");

  // Bắn ĐỒNG THỜI (hai tab / hai người): đúng một lượt được tính là mới.
  await db.insert(schema.shipments).values({ id: "ur-ship-dua", orderId: "ur-order-1", vtpOrderNumber: "URPKE0003", stage: "RETURNED", returnedAt: new Date("2026-09-11T00:00:00Z") }).onConflictDoNothing();
  const dua = await Promise.all([
    scanReceiveReturn({ code: "URPKE0003", actor: { id: null, label: "kho-a" } }),
    scanReceiveReturn({ code: "URPKE0003", actor: { id: null, label: "kho-b" } }),
  ]);
  assert.equal(dua.filter((r) => r.outcome === "RECEIVED").length, 1, "hai lượt bắn cùng lúc thì đúng MỘT lượt là ghi mới");
  assert.equal(dua.filter((r) => r.outcome === "ALREADY").length, 1, "lượt còn lại phải nói “đã nhận”, không im lặng và không ghi thêm");

  // Kiện ĐVVC báo đã giao: phải chờ người xác nhận, không ghi lặng lẽ.
  const ngoaiChang = await scanReceiveReturn({ code: "URPKE0002", actor: { id: null, label: "nv-kho" } });
  assert.equal(ngoaiChang.outcome, "NEEDS_CONFIRM", "kiện ĐVVC báo “đã giao” không được ghi nhận lặng lẽ — mâu thuẫn ấy phải hiện ra cho người kho");
  const [chuaGhi] = await db.select({ n: sql<number>`count(*)` }).from(schema.returnInspections).where(eq(schema.returnInspections.shipmentId, "ur-ship-giao"));
  assert.equal(Number(chuaGhi?.n ?? 0), 0, "lượt “cần xác nhận” KHÔNG được ghi gì cả");

  const xacNhan = await scanReceiveReturn({ code: "URPKE0002", actor: { id: null, label: "nv-kho" }, confirmUnexpected: true });
  assert.equal(xacNhan.outcome, "RECEIVED", "bấm xác nhận lần hai thì ghi được");

  const maLa = await scanReceiveReturn({ code: "KHONG-CO-MA-NAY", actor: { id: null, label: "nv-kho" } });
  assert.equal(maLa.outcome, "NOT_FOUND", "mã không có thật phải nói rõ CHƯA THẤY, không ghi bừa vào một kiện gần giống");

  // ═══════════════ 2. TẠO KIỆN MẤT NHÃN — KHÔNG CỘNG TỒN ═══════════════

  assert.equal(unidentifiedCode(new Date("2026-09-15T08:00:00+07:00"), 37).slice(0, 3), "UR-", "mã nội bộ phải nhận ra được bằng mắt");
  assert.ok(isUnidentifiedCode(unidentifiedCode(new Date(), 1)), "mã sinh ra phải khớp chính bộ nhận dạng của nó");
  assert.ok(!isUnidentifiedCode("URPKE0001"), "mã vận đơn KHÔNG được nhận nhầm thành mã nội bộ");

  const tao = await createUnidentifiedReturn({
    source: "NO_TRACKING_LABEL",
    variantId: "ur-var",
    quantity: 1,
    condition: "OK",
    note: "",
    warehouseNote: "Kiện về cùng lô 15/09",
    actor: { id: null, label: "nv-kho" },
  });
  assert.ok("ok" in tao, "kiện mất nhãn phải ghi nhận được mà KHÔNG cần biết nó của đơn nào");
  const ur = "ok" in tao ? tao.row : null;
  assert.ok(ur && isUnidentifiedCode(ur.code), "ERP cấp một mã nội bộ đọc được để viết lên kiện thay cho nhãn đã mất");
  assert.equal(ur?.stockReceiptId, null, "TẠO KIỆN KHÔNG CỘNG TỒN — kể cả khi kết luận là còn bán được");
  assert.equal(ur?.status, "PENDING_IDENTIFICATION");
  assert.equal(ur?.sku, "UR-001", "ảnh chụp mẫu mã lấy từ danh mục lúc nhận, không đọc sống về sau");
  assert.equal(await tonCuaUR(ur?.code ?? "x"), 0, "chưa có một món nào vào tồn");

  const khongSoLuong = await createUnidentifiedReturn({ source: "NO_TRACKING_LABEL", variantId: "ur-var", quantity: 0, condition: "OK", note: "", warehouseNote: "", actor: { id: null, label: "nv-kho" } });
  assert.ok("error" in khongSoLuong, "số lượng 0 là một dòng rác vĩnh viễn — phải bị chặn");

  // ═══════════════ 3. CHƯA NỐI ĐƠN THÌ VẪN GIỮ TẠM, NHƯNG TÁI NHẬP ĐƯỢC (có căn cứ ghi lại) ═══════════════

  const thieuLyDo = await restockUnidentifiedReturn({ id: ur?.id ?? "", reason: "  ", actor: { id: null, label: "quan-ly-kho" } });
  assert.ok("error" in thieuLyDo, "tái nhập hàng không lần ra được đơn mà KHÔNG ghi lý do thì phải bị chặn");
  assert.equal(await tonCuaUR(ur?.code ?? "x"), 0, "lượt bị chặn không được để lại phiếu kho nào");

  // ═══════════════ 4. NỐI ĐƠN — KHÔNG TẠO MÓN MỚI, KHÔNG CỘNG TỒN ═══════════════

  const noi = await identifyUnidentifiedReturn({ id: ur?.id ?? "", shipmentId: "ur-ship-1", actor: { id: null, label: "nv-kho" } });
  assert.ok("ok" in noi, "nối được với vận đơn mà người kho chọn");
  assert.equal("ok" in noi && noi.row.status, "IDENTIFIED");
  assert.equal("ok" in noi && noi.row.identificationMethod, "MANUAL_MATCH", "căn cứ quy kết phải tự khai ra là NGƯỜI chọn — máy không bao giờ tự nối");
  assert.equal("ok" in noi && noi.row.linkedShipmentId, "ur-ship-1");
  assert.equal("ok" in noi && noi.row.stockReceiptId, null, "NỐI ĐƠN KHÔNG CỘNG TỒN — nó chỉ trả lời “của ai”, không trả lời “có bán lại được không”");

  const sauKhiNoi = await listUnidentifiedReturns({ limit: 200 });
  assert.equal(sauKhiNoi.filter((r) => r.code === ur?.code).length, 1, "NỐI ĐƠN KHÔNG ĐƯỢC SINH MÓN THỨ HAI — một chiếc áo là một dòng, mãi mãi");

  // ═══════════════ 5. TÁI NHẬP SAU KHI NỐI — ĐÚNG MỘT LẦN ═══════════════

  const vaoTon = await restockUnidentifiedReturn({ id: ur?.id ?? "", reason: "", actor: { id: null, label: "nv-kho" } });
  assert.ok("ok" in vaoTon && !vaoTon.already, "đã nối được đơn thì tái nhập được, không cần quyền cao hơn");
  assert.equal("ok" in vaoTon ? vaoTon.restocked : 0, 1, "cộng đúng số món đã ghi nhận");
  assert.equal("ok" in vaoTon && vaoTon.row.restockAuthority, "IDENTIFIED", "căn cứ phải ghi là ĐÃ NỐI ĐƠN, để lượt không chứng từ không đội lốt lượt có chứng từ");
  assert.equal(await tonCuaUR(ur?.code ?? "x"), 1, "đúng 1 món vào tồn");

  const vaoTonLai = await restockUnidentifiedReturn({ id: ur?.id ?? "", reason: "", actor: { id: null, label: "nguoi-khac" } });
  assert.ok("ok" in vaoTonLai && vaoTonLai.already, "gọi lại lần hai phải nói “đã vào tồn từ trước”, không phải một lỗi đỏ — máy quét và mạng đều thử lại là chuyện thường");
  assert.equal(await tonCuaUR(ur?.code ?? "x"), 1, "TÁI NHẬP LẦN HAI KHÔNG ĐƯỢC CỘNG THÊM — một chiếc áo, một lần");

  // Hai lượt CÙNG LÚC (hai tab): chốt nằm ở CSDL, không ở trình duyệt.
  const taoDua = await createUnidentifiedReturn({ source: "NO_TRACKING_LABEL", variantId: "ur-var-2", quantity: 3, condition: "OK", note: "", warehouseNote: "", actor: { id: null, label: "nv-kho" } });
  const urDua = "ok" in taoDua ? taoDua.row : null;
  const haiTab = await Promise.all([
    restockUnidentifiedReturn({ id: urDua?.id ?? "", reason: "Mất nhãn vận đơn, hàng còn nguyên tem", actor: { id: null, label: "quan-ly-a" } }),
    restockUnidentifiedReturn({ id: urDua?.id ?? "", reason: "Mất nhãn vận đơn, hàng còn nguyên tem", actor: { id: null, label: "quan-ly-b" } }),
  ]);
  assert.equal(haiTab.filter((r) => "ok" in r && !r.already).length, 1, "hai tab cùng bấm thì đúng MỘT lượt cộng tồn");
  assert.equal(await tonCuaUR(urDua?.code ?? "x"), 3, "tồn tăng đúng 3 — không phải 6");
  assert.equal("ok" in haiTab[0] ? haiTab[0].row.restockAuthority ?? (("ok" in haiTab[1] && haiTab[1].row.restockAuthority) || null) : null, "MANAGER_OVERRIDE", "chưa nối đơn ⇒ căn cứ là QUYẾT ĐỊNH CỦA QUẢN LÝ KHO, phải nhìn thấy được trong dữ liệu");

  // Đã vào tồn rồi thì không đổi quy kết ngược lại được.
  const doiNguoc = await identifyUnidentifiedReturn({ id: ur?.id ?? "", shipmentId: "ur-ship-dua", actor: { id: null, label: "nv-kho" } });
  assert.ok("error" in doiNguoc, "đổi đích của một phiếu ĐÃ cộng tồn là sửa lịch sử — phải qua phiếu điều chỉnh có người ký");

  // ═══════════════ 6. HAI ĐƯỜNG KHÔNG ĐƯỢC CỘNG CHO CÙNG MỘT MÓN HÀNG ═══════════════

  /*
    Vận đơn `ur-ship-dua` được ĐẾM qua đường thường (`return_inspections`) — tức là món hàng ấy đã
    vào tồn một lần. Nối một kiện mất nhãn vào chính nó là khẳng định "kiện đang cầm CHÍNH LÀ kiện
    đó", và tái nhập tiếp sẽ cộng lần thứ hai cho cùng một chiếc áo.
  */
  await recordInspection({ shipmentId: "ur-ship-dua", condition: "RESTOCKABLE", restockQty: 1, unsellableQty: 0, note: "", actor: { id: null, label: "nguoi-dem" } });
  const taoSauDem = await createUnidentifiedReturn({ source: "DAMAGED_LABEL", variantId: "ur-var", quantity: 1, condition: "OK", note: "", warehouseNote: "", actor: { id: null, label: "nv-kho" } });
  const urSauDem = "ok" in taoSauDem ? taoSauDem.row : null;
  const noiVaoDaDem = await identifyUnidentifiedReturn({ id: urSauDem?.id ?? "", shipmentId: "ur-ship-dua", actor: { id: null, label: "nv-kho" } });
  assert.ok("error" in noiVaoDaDem, "nối vào một vận đơn ĐÃ ĐẾM là cộng tồn lần hai cho cùng một món hàng — phải bị chặn");

  // Hai kiện mất nhãn không thể cùng là một vận đơn.
  await db.insert(schema.shipments).values({ id: "ur-ship-2", orderId: "ur-order-1", vtpOrderNumber: "URPKE0004", stage: "RETURNED", returnedAt: new Date("2026-09-12T00:00:00Z") }).onConflictDoNothing();
  const noiA = await identifyUnidentifiedReturn({ id: urSauDem?.id ?? "", shipmentId: "ur-ship-2", actor: { id: null, label: "nv-kho" } });
  assert.ok("ok" in noiA, "kiện đầu nối được");
  const taoB = await createUnidentifiedReturn({ source: "NO_TRACKING_LABEL", variantId: "ur-var", quantity: 1, condition: "OK", note: "", warehouseNote: "", actor: { id: null, label: "nv-kho" } });
  const urB = "ok" in taoB ? taoB.row : null;
  const noiB = await identifyUnidentifiedReturn({ id: urB?.id ?? "", shipmentId: "ur-ship-2", actor: { id: null, label: "nv-kho" } });
  assert.ok("error" in noiB, "hai kiện vật lý khác nhau không thể cùng là một vận đơn — ít nhất một cái sai, và cái sai ấy sẽ cộng tồn cho hàng của người khác");

  // ═══════════════ 7. KẾT LUẬN KHÔNG VÀO TỒN THÌ KHÔNG VÀO TỒN ═══════════════

  const taoBan = await createUnidentifiedReturn({ source: "NO_TRACKING_LABEL", variantId: "ur-var", quantity: 2, condition: "DIRTY", note: "Áo bẩn, cần giặt lại", warehouseNote: "", actor: { id: null, label: "nv-kho" } });
  const urBan = "ok" in taoBan ? taoBan.row : null;
  const banVaoTon = await restockUnidentifiedReturn({ id: urBan?.id ?? "", reason: "Mất nhãn", actor: { id: null, label: "quan-ly-kho" } });
  assert.ok("error" in banVaoTon, "hàng cần làm lại (bẩn) KHÔNG được vào tồn bán được — hàng chỉ vào tồn khi thật sự sẵn sàng bán");
  assert.equal(await tonCuaUR(urBan?.code ?? "x"), 0);

  const giatXong = await setUnidentifiedCondition({ id: urBan?.id ?? "", condition: "OK", note: "", actor: { id: null, label: "nv-kho" } });
  assert.ok("ok" in giatXong, "giặt xong thì đổi được kết luận sang bán lại được");
  const sauGiat = await restockUnidentifiedReturn({ id: urBan?.id ?? "", reason: "Mất nhãn vận đơn, đã giặt lại", actor: { id: null, label: "quan-ly-kho" } });
  assert.ok("ok" in sauGiat && !sauGiat.already, "đổi kết luận xong thì tái nhập được");
  assert.equal(await tonCuaUR(urBan?.code ?? "x"), 2);

  // Chưa chọn mẫu mã thì không biết cộng vào đâu.
  const khongMauMa = await createUnidentifiedReturn({ source: "UNKNOWN_PARCEL", variantId: null, quantity: 1, condition: "OK", note: "", warehouseNote: "Chưa nhận ra mẫu mã", actor: { id: null, label: "nv-kho" } });
  const urTrong = "ok" in khongMauMa ? khongMauMa.row : null;
  const vaoTonTrong = await restockUnidentifiedReturn({ id: urTrong?.id ?? "", reason: "Mất nhãn", actor: { id: null, label: "quan-ly-kho" } });
  assert.ok("error" in vaoTonTrong, "chưa nhận diện được mẫu mã thì không cộng vào đâu được — không được cộng bừa cho một mẫu mã gần giống");

  const boTay = await markUnidentifiable({ id: urTrong?.id ?? "", reason: "Đã tra SĐT và toàn bộ đơn hoàn 30 ngày, không khớp mã nào", actor: { id: null, label: "nv-kho" } });
  assert.ok("ok" in boTay, "kết luận không lần ra được đơn phải ghi lại được");
  const boTayKhongLyDo = await markUnidentifiable({ id: urB?.id ?? "", reason: "   ", actor: { id: null, label: "nv-kho" } });
  assert.ok("error" in boTayKhongLyDo, "kết luận “bó tay” mà không nói đã tra gì chỉ là bỏ việc lại cho người sau — phải bị chặn");

  // ═══════════════ 7b. THỬ LẠI: MỌI ĐƯỜNG GHI GỌI HAI LẦN ĐỀU KHÔNG ĐỔI TỒN ═══════════════

  /*
    Ở kho, gọi lại KHÔNG phải ngoại lệ — nó là nhịp bình thường: máy quét gửi hai Enter, mạng hết
    hạn chờ SAU KHI máy chủ đã ghi rồi trình duyệt thử lại, người bấm đúp vì màn hình chưa kịp đổi.
    Nên mỗi đường ghi phải chịu được lượt thứ hai mà KHÔNG đổi một con số tồn nào.
  */
  const tonTruoc = await tonCuaUR(ur?.code ?? "x");

  // (a) NỐI ĐƠN LẦN HAI vào ĐÚNG vận đơn cũ — không được tạo món mới, không được đổi tồn.
  const soDongTruoc = (await listUnidentifiedReturns({ limit: 500 })).length;
  const noiLai = await identifyUnidentifiedReturn({ id: urSauDem?.id ?? "", shipmentId: "ur-ship-2", actor: { id: null, label: "nv-kho" } });
  const soDongSau = (await listUnidentifiedReturns({ limit: 500 })).length;
  assert.equal(soDongSau, soDongTruoc, "nối lại lần hai KHÔNG được sinh thêm một dòng hàng nào — một chiếc áo là một dòng, mãi mãi");
  assert.ok("ok" in noiLai && noiLai.row.linkedShipmentId === "ur-ship-2", "nối lại cùng vận đơn cũ vẫn ra đúng vận đơn ấy");
  assert.equal("ok" in noiLai && noiLai.row.stockReceiptId, null, "nối đơn — dù lần thứ mấy — KHÔNG bao giờ cộng tồn");

  // (b) TÁI NHẬP LẦN BA trên một món đã vào tồn: vẫn `already`, tồn không nhúc nhích.
  const lanBa = await restockUnidentifiedReturn({ id: ur?.id ?? "", reason: "thử lại", actor: { id: null, label: "nguoi-thu-ba" } });
  assert.ok("ok" in lanBa && lanBa.already, "gọi lại lần thứ ba vẫn trả “đã vào tồn từ trước”, không phải lỗi");
  assert.equal(await tonCuaUR(ur?.code ?? "x"), tonTruoc, "tồn KHÔNG đổi sau lượt gọi lại");

  // (c) ĐỔI KẾT LUẬN trên món ĐÃ vào tồn phải bị chặn — sửa số sau khi cộng tồn phải qua phiếu điều chỉnh.
  const doiSauKhiVaoTon = await setUnidentifiedCondition({ id: ur?.id ?? "", condition: "DAMAGED", note: "đổi thử", actor: { id: null, label: "nv-kho" } });
  assert.ok("error" in doiSauKhiVaoTon, "món đã vào tồn thì không đổi kết luận ngược được — nếu không, tồn và kết luận nói hai điều khác nhau");

  // (d) KẾT LUẬN “không lần ra được đơn” trên món đã vào tồn cũng phải bị chặn.
  const boTaySauKhiVaoTon = await markUnidentifiable({ id: ur?.id ?? "", reason: "thử", actor: { id: null, label: "nv-kho" } });
  assert.ok("error" in boTaySauKhiVaoTon, "không đổi được kết luận nguồn gốc của một món đã cộng tồn");

  // (e) BẮN MÃ lần thứ ba trên kiện đã nhận: vẫn ALREADY, vẫn đúng MỘT phiếu kiểm.
  const banLanBa = await scanReceiveReturn({ code: "URPKE0001", actor: { id: null, label: "nguoi-thu-ba" } });
  assert.equal(banLanBa.outcome, "ALREADY", "bắn lại lần thứ ba vẫn là “đã nhận từ trước”");
  const [demPhieu] = await db.select({ n: sql<number>`count(*)` }).from(schema.returnInspections).where(eq(schema.returnInspections.shipmentId, "ur-ship-1"));
  assert.equal(Number(demPhieu?.n ?? 0), 1, "bao nhiêu lượt bắn cũng chỉ MỘT phiếu kiểm cho một kiện vật lý");

  // ═══════════════ 8. BÁO CÁO VÀ LỊCH SỬ ═══════════════

  const tong = await unidentifiedSummary();
  assert.ok(tong.restockedOverride >= 2, "lượt vào tồn KHÔNG có chứng từ đơn phải đếm riêng — gộp vào tổng là làm biến mất đúng con số chủ shop cần nhìn");
  assert.ok(tong.restockedIdentified >= 1, "lượt vào tồn sau khi nối đơn đếm riêng");
  assert.ok(tong.holding >= 1, "kiện chưa vào tồn vẫn được đếm là hàng có thật trong kho");
  assert.ok(tong.holdingUnits >= tong.holding, "số MÓN giữ tạm không thể nhỏ hơn số KIỆN");

  const timeline = unidentifiedTimeline((await listUnidentifiedReturns({ limit: 200 })).find((r) => r.code === ur?.code)!);
  assert.ok(timeline.length >= 3, "một kiện đã nhận → nối đơn → vào tồn phải đọc được thành ba mốc, không phải một dòng trạng thái");
  assert.ok(timeline.every((t) => t.by), "mỗi mốc phải nói AI làm — một dòng lịch sử không có người là một dòng không quy kết được");
  assert.deepEqual([...timeline].sort((a, b) => a.at.getTime() - b.at.getTime()).map((t) => t.title), timeline.map((t) => t.title), "lịch sử phải theo đúng thứ tự thời gian");

  // ═══════════════ 9. TRA ỨNG VIÊN QUA CSDL ═══════════════

  const thieuDauHieu = await searchReturnCandidates({ color: "Đỏ đô", size: "XL" });
  assert.ok("error" in thieuDauHieu, "tra bằng riêng màu + size là quét gần cả bảng để trả về một danh sách vô nghĩa — phải từ chối, vì danh sách vô nghĩa vẫn mời người ta chọn đại");

  const theoSDT = await searchReturnCandidates({ phone: "0912345678" });
  assert.ok("ok" in theoSDT && theoSDT.rows.length > 0, "tra theo số điện thoại phải ra ứng viên");
  assert.ok("ok" in theoSDT && theoSDT.rows.every((r) => r.signals.includes("PHONE_EXACT")), "mọi ứng viên trả về phải nêu ĐÚNG bằng chứng đã khớp, không chỉ một điểm số");
  // Vận đơn ĐÃ ĐẾM vẫn phải hiện ra kèm nhãn: nó thường chính là câu trả lời cho "kiện này là gì",
  // và giấu nó đi thì người kho kết luận "không có đơn nào" rồi tạo thêm một kiện chưa xác định.
  const daDem = await searchReturnCandidates({ tracking: "URPKE0003" });
  assert.ok("ok" in daDem && daDem.rows.some((r) => r.shipmentId === "ur-ship-dua" && r.alreadyInspected), "vận đơn đã đếm vẫn HIỆN RA, kèm nhãn để người kho biết vì sao không nối được");

  const theoMa = await searchReturnCandidates({ tracking: "URPKE0001" });
  assert.ok("ok" in theoMa && theoMa.rows[0]?.shipmentId === "ur-ship-1", "bắn đúng mã thì kiện đó phải đứng đầu");
  assert.equal("ok" in theoMa ? theoMa.rows[0]?.confidence : null, "HIGH", "khớp nguyên mã vận đơn là bằng chứng mạnh nhất");

  // ═══════════════ 10. QUYỀN: TÁI NHẬP KHÔNG CHỨNG TỪ KHÔNG PHẢI THAO TÁC KHO THƯỜNG ═══════════════

  /*
    Nhân viên kho nhận kiện, đếm, tra đơn — nhưng lượt cộng tồn cho món KHÔNG có chứng từ nào là
    một quyết định kinh doanh. Nối quyền đó vào `inventory:write` là biến nó thành thao tác hằng
    ngày của mọi tài khoản kho.
  */
  assert.ok(DEFAULT_ROLE_PERMISSIONS.WAREHOUSE.includes("inventory:write"), "nhân viên kho vẫn nhận kiện và đếm được");
  assert.ok(!DEFAULT_ROLE_PERMISSIONS.WAREHOUSE.includes(RESTOCK_UNIDENTIFIED_PERMISSION), "vai KHO mặc định KHÔNG có quyền tái nhập hàng không xác định nguồn");
  assert.ok(DEFAULT_ROLE_PERMISSIONS.ADMIN.includes(RESTOCK_UNIDENTIFIED_PERMISSION), "quản trị có");
  assert.ok(DEFAULT_ROLE_PERMISSIONS.MANAGER.includes(RESTOCK_UNIDENTIFIED_PERMISSION), "quản lý có");
  assert.ok(DEFAULT_ROLE_PERMISSIONS.LEADER.includes(RESTOCK_UNIDENTIFIED_PERMISSION), "trưởng nhóm (quản lý kho) có");

  /*
    MỌI NHÁNH MẶC ĐỊNH CỦA MỘT QUYỀN LEO THANG PHẢI RƠI VỀ PHÍA HẸP HƠN (luật 31).
    Tài khoản kho có danh sách quyền lưu từ trước KHÔNG được tự nhận quyền mới này — nếu nó nằm
    trong `PERMISSIONS_ADDED_AFTER_SNAPSHOT` thì nó sẽ tự rơi về mẫu vai trò, và một vai có mẫu
    rộng hơn sẽ lặng lẽ được cấp.
  */
  const khoLuuCu = resolvePermissions("WAREHOUSE", ["inventory:write", "products:view"], null, null);
  assert.ok(!khoLuuCu.includes(RESTOCK_UNIDENTIFIED_PERMISSION), "danh sách quyền lưu từ trước KHÔNG được tự nhận thêm quyền leo thang này");

  // ═══════════════ 11. MỌI ĐƯỜNG GHI PHẢI CÓ CHỐT QUYỀN Ở MÁY CHỦ ═══════════════

  /*
    ẨN CÁI NÚT KHÔNG PHẢI LÀ BẢO VỆ TỒN KHO.

    Server Action là một điểm cuối HTTP có thật: ai biết tên hàm đều gọi thẳng được, không cần đi
    qua màn hình. Một action thiếu `requireUser()` là mở cho người chưa đăng nhập; thiếu `can(...)`
    là mở cho mọi tài khoản đã đăng nhập — kể cả tài khoản chỉ để xem báo cáo.

    Bài kiểm đọc MÃ NGUỒN của ĐÚNG HAI tệp thuộc luồng hàng hoàn. Thêm một action mới vào đó mà
    quên chốt quyền thì đỏ ngay trên máy người viết, chứ không đợi tới lúc có người thử.

    Cố ý KHÔNG quét cả kho mã: các tệp hành động khác thuộc phiên làm việc khác, và một bài kiểm
    quét rộng sẽ làm đỏ việc của người không liên quan.
  */
  const goc = path.resolve(__dirname, "..");
  for (const tep of ["lib/actions/returns-unidentified.ts", "lib/actions/returns-warehouse.ts"]) {
    const src = readFileSync(path.join(goc, tep), "utf8");
    const khoi = src.split("\nexport async function ").slice(1);
    assert.ok(khoi.length > 0, `${tep}: phải có ít nhất một Server Action`);
    for (const k of khoi) {
      const ten = k.split("(")[0];
      const than = k.split("\nexport ")[0];
      assert.ok(than.includes("requireUser()"), `${tep}::${ten} thiếu requireUser() — người CHƯA ĐĂNG NHẬP gọi thẳng được`);
      assert.ok(/can\(user, "/.test(than), `${tep}::${ten} thiếu can(user, …) — mọi tài khoản đã đăng nhập đều ghi được vào kho`);
    }
  }

  /*
    VÀ CHỐT QUYỀN CAO PHẢI NẰM Ở TẦNG HÀNH ĐỘNG, không chỉ ở giao diện.

    `canOverride` truyền xuống màn hình chỉ để ẩn cái nút. Nếu đó là nơi DUY NHẤT kiểm tra thì bất
    kỳ ai gọi thẳng action đều tái nhập được hàng không chứng từ.
  */
  const srcAction = readFileSync(path.join(goc, "lib/actions/returns-unidentified.ts"), "utf8");
  assert.ok(srcAction.includes("RESTOCK_UNIDENTIFIED_PERMISSION"), "tầng hành động phải tự kiểm quyền tái nhập không xác định nguồn, không dựa vào giao diện");

  console.log("✓ Hàng hoàn mất nhãn: bắn mã không cộng tồn · nối đơn không tạo món mới · tái nhập đúng một lần · mô tả không thắng định danh · quyền tách bạch");
}
