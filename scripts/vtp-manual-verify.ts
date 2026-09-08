/**
 * CHỨNG TỪ ĐVVC CHÉP TAY MỘT LẦN CHO LỊCH SỬ — lô `HISTORICAL_VTP_MANUAL_VERIFY_2026_09_08`.
 *
 * Vì sao cần: webhook chỉ chảy từ 05/09/2026, còn tệp "Danh sách vận đơn" của Viettel Post KHÔNG
 * chứa vận đơn "Shop hủy lấy". Một mảng lịch sử tháng 8 vì thế không có đường nào vào ERP. Chủ shop
 * đã mở trang viettelpost.vn đọc từng vận đơn và chép lại — đó vẫn là chứng từ của ĐVVC, chỉ đi qua
 * mắt người.
 *
 * Bốn điều script này CỐ Ý KHÔNG làm:
 *  · không ghi đè vĩnh viễn — sự kiện có mốc thời gian, webhook thật xảy ra sau vẫn thắng;
 *  · không đoán đơn: mã vận đơn là danh tính, SĐT chỉ là dữ liệu đối chiếu, tuyệt đối không ghép
 *    vận đơn vào đơn bằng SĐT;
 *  · không suy tiền đã thu: "Đã nhận COD" chỉ nâng TRẠNG THÁI tiền lên COLLECTED, không ghi
 *    `cod_collected` và không bao giờ chạm tới RECONCILED / PAID_TO_BANK;
 *  · không tạo luật riêng cho khách hàng nào — ngoại lệ duy nhất là đúng danh sách mã vận đơn dưới.
 *
 * Dùng:
 *   npx tsx scripts/vtp-manual-verify.ts            # CHẠY THỬ, không ghi gì
 *   npx tsx scripts/vtp-manual-verify.ts --apply    # ghi
 */
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { CodStatus, ShipmentStage } from "@/db/schema";
import { audit } from "@/lib/audit";
import { MANUAL_VERIFICATION_SOURCE } from "@/lib/constants/truth";
import { legBaseCode } from "@/lib/integrations/viettelpost/statement";
import { materializeShipmentState } from "@/lib/integrations/viettelpost/state";

const BATCH = "HISTORICAL_VTP_MANUAL_VERIFY_2026_09_08";
/** Mốc cố định của lô ⇒ chạy lại bao nhiêu lần cũng ra đúng một dòng sự kiện (khoá duy nhất gồm mốc). */
const VERIFIED_AT = new Date("2026-09-08T00:00:00+07:00");

type CodText = "Đã nhận COD" | "Không có COD" | "Chưa đối soát COD";
type Record18 = { tracking: string; phone: string; status: string; cod: CodText; amount: number; note?: string };

/**
 * Chủ shop xác minh trên giao diện Viettel Post ngày 08/09/2026.
 * `phone` chỉ để đối chiếu khi con người xem lại — KHÔNG dùng để ghép đơn.
 */
const RECORDS: Record18[] = [
  { tracking: "PKE1511633400", phone: "0979936889", status: "Giao thành công", cod: "Đã nhận COD", amount: 524_000 },

  // Chủ shop chép "PKE14844634301P1" và "PKE14844634303". Hai chuỗi đó KHÔNG tồn tại trong tệp xuất
  // của chính Viettel Post, trong khi hai mã dưới đây có, và trùng khít từng thuộc tính đã xác minh
  // (vận đơn chiều về 0đ "Không có COD"; vận đơn gốc 30.000đ "Giao thành công"). Kết luận: lỗi đảo
  // chữ số lúc chép. Ghi theo mã CÓ THẬT, và lưu lại nguyên văn chuỗi đã chép để truy nguyên.
  { tracking: "PKE14844634031P1", phone: "0345222695", status: "Giao thành công", cod: "Không có COD", amount: 0, note: "chép tay: PKE14844634301P1 (đảo chữ số)" },
  { tracking: "PKE1484463403", phone: "0345222695", status: "Giao thành công", cod: "Đã nhận COD", amount: 30_000, note: "chép tay: PKE14844634303 (đảo chữ số)" },

  { tracking: "PKE14844633651P1", phone: "0345222695", status: "Giao thành công", cod: "Không có COD", amount: 0 },
  // Tệp xuất ghi 30.000đ cho vận đơn này, giao diện web ghi 474.000đ. Lấy số chủ shop xác minh trực
  // tiếp trên web; chênh lệch đã nêu trong báo cáo để đối chiếu lại.
  { tracking: "PKE1484463365", phone: "0345222695", status: "Giao thành công", cod: "Đã nhận COD", amount: 474_000, note: "tệp xuất ghi 30.000đ — lệch với web" },
  { tracking: "PKE1484450905", phone: "0345222695", status: "Shop hủy lấy", cod: "Chưa đối soát COD", amount: 399_000 },
  { tracking: "PKE1484434062", phone: "0345222695", status: "Shop hủy lấy", cod: "Chưa đối soát COD", amount: 474_000 },

  { tracking: "PKE14844633801P1", phone: "0896997119", status: "Giao thành công", cod: "Không có COD", amount: 0 },
  { tracking: "PKE1484463380", phone: "0896997119", status: "Giao thành công", cod: "Đã nhận COD", amount: 5_001 },
  { tracking: "PKE1484463371", phone: "0896997119", status: "Giao thành công", cod: "Đã nhận COD", amount: 474_000 },
  { tracking: "PKE1484450889", phone: "0896997119", status: "Shop hủy lấy", cod: "Chưa đối soát COD", amount: 474_000 },
  { tracking: "PKE1484434067", phone: "0896997119", status: "Shop hủy lấy", cod: "Chưa đối soát COD", amount: 474_000 },

  { tracking: "PKE1484460381", phone: "0909728879", status: "Giao thành công", cod: "Đã nhận COD", amount: 474_000 },
  { tracking: "PKE1484463375", phone: "0909728879", status: "Giao thành công", cod: "Đã nhận COD", amount: 474_000 },
  { tracking: "PKE1484434076", phone: "0909728879", status: "Shop hủy lấy", cod: "Chưa đối soát COD", amount: 474_000 },
  { tracking: "PKE1484434068", phone: "0909728879", status: "Shop hủy lấy", cod: "Chưa đối soát COD", amount: 474_000 },

  { tracking: "PKE1508908614", phone: "0985222958", status: "Đang chuyển hoàn", cod: "Chưa đối soát COD", amount: 849_000 },
  { tracking: "PKE1508295104", phone: "0985222958", status: "Shop hủy lấy", cod: "Chưa đối soát COD", amount: 849_000 },
];

/** Chữ của giao diện Viettel Post → trạng thái chuẩn của ERP. Chiều hoàn xử lý bằng `legType`. */
function mapStage(status: string): ShipmentStage {
  if (status === "Giao thành công") return "DELIVERED";
  if (status === "Đang chuyển hoàn") return "RETURNING";
  if (status === "Shop hủy lấy") return "CANCELLED";
  throw new Error(`Trạng thái chưa có trong bảng quy đổi: ${status}`);
}

/** Chiều tiền tách hẳn khỏi chiều giao hàng. Không nhánh nào ở đây suy ra "đã thu được tiền". */
function mapCod(cod: CodText, current: CodStatus | null): { codStatus: CodStatus | null; amount: number | null } {
  if (cod === "Không có COD") return { codStatus: "NOT_APPLICABLE", amount: 0 };
  // "Đã nhận COD" = ĐVVC đang giữ tiền. KHÔNG phải đã về tài khoản shop ⇒ không chạm RECONCILED /
  // PAID_TO_BANK, và không ghi `cod_collected` (chỉ bảng kê mới chứng minh được số thực thu).
  if (cod === "Đã nhận COD") return { codStatus: current === "RECONCILED" || current === "PAID_TO_BANK" ? null : "COLLECTED", amount: null };
  // "Chưa đối soát COD": chưa có gì để nói về tiền — giữ nguyên trạng thái đang có.
  return { codStatus: null, amount: null };
}

async function main() {
  const apply = process.argv.includes("--apply");
  const db = await getDb();
  const rows: Record<string, unknown>[] = [];
  let found = 0;
  let created = 0;
  let evidenceNew = 0;
  let evidenceExisting = 0;

  for (const r of RECORDS) {
    const legOf = legBaseCode(r.tracking);
    const stage = mapStage(r.status);
    let ship = await db.query.shipments.findFirst({ where: eq(schema.shipments.vtpOrderNumber, r.tracking) });
    const existed = Boolean(ship);
    if (existed) found += 1;

    if (!ship) {
      created += 1;
      if (apply) {
        // Danh tính là MÃ VẬN ĐƠN. Cố ý để `order_id` NULL: chưa có bằng chứng chắc chắn nào nối
        // vận đơn này với một đơn cụ thể, và SĐT thì không đủ tư cách làm danh tính.
        await db.insert(schema.shipments).values({
          carrier: "Viettel Post", vtpOrderNumber: r.tracking, trackingCode: r.tracking,
          orderReference: legOf || null, receiverPhone: r.phone,
          codAmount: r.amount, codStatus: "PENDING",
        }).onConflictDoNothing({ target: schema.shipments.vtpOrderNumber });
        ship = await db.query.shipments.findFirst({ where: eq(schema.shipments.vtpOrderNumber, r.tracking) });
      }
    }

    const before = ship ? { stage: ship.stage, codStatus: ship.codStatus, codAmount: ship.codAmount, orderId: ship.orderId } : null;
    const cod = mapCod(r.cod, ship?.codStatus ?? null);

    if (ship) {
      const [already] = await db.select({ id: schema.shipmentEvents.id }).from(schema.shipmentEvents).where(and(
        eq(schema.shipmentEvents.shipmentId, ship.id),
        eq(schema.shipmentEvents.source, MANUAL_VERIFICATION_SOURCE),
        eq(schema.shipmentEvents.status, r.status),
        eq(schema.shipmentEvents.occurredAt, VERIFIED_AT),
      ));
      if (already) evidenceExisting += 1;
      else evidenceNew += 1;

      if (apply && !already) {
        await db.insert(schema.shipmentEvents).values({
          shipmentId: ship.id, source: MANUAL_VERIFICATION_SOURCE,
          status: r.status, statusName: r.status, occurredAt: VERIFIED_AT,
          normalizedStage: stage, legType: legOf ? "RETURN" : "OUTBOUND",
          verificationStatus: "VERIFIED",
          sourceReference: `${BATCH}:${r.tracking}`,
          raw: { evidenceType: "CARRIER_SCREENSHOT", verifiedBy: "SHOP_OWNER", batch: BATCH,
            statusText: r.status, codText: r.cod, codAmount: r.amount, phone: r.phone, note: r.note ?? null },
        }).onConflictDoNothing();
      }
      if (apply) {
        const set: Record<string, unknown> = {};
        if (cod.codStatus) set.codStatus = cod.codStatus;
        if (cod.amount !== null) set.codAmount = cod.amount;
        else if (!ship.codAmount && r.amount) set.codAmount = r.amount;
        if (!ship.receiverPhone) set.receiverPhone = r.phone;
        if (Object.keys(set).length) await db.update(schema.shipments).set({ ...set, updatedAt: new Date() }).where(eq(schema.shipments.id, ship.id));
        // Trạng thái vận đơn LUÔN do lịch sử quyết định — không ghi tay vào `stage`.
        await materializeShipmentState(db, ship.id);
      }
    }

    const after = apply && ship ? await db.query.shipments.findFirst({ where: eq(schema.shipments.id, ship.id) }) : null;
    rows.push({
      ma_van_don: r.tracking, sdt_doi_chieu: r.phone, chieu: legOf ? "HOÀN" : "ĐI",
      van_don: existed ? "đã có" : apply ? "đã tạo" : "sẽ tạo",
      trang_thai_truoc: before?.stage ?? "—", trang_thai_de_xuat: stage, trang_thai_sau: after?.stage ?? "—",
      cod_truoc: before ? `${before.codStatus} ${before.codAmount}đ` : "—",
      cod_de_xuat: `${cod.codStatus ?? "giữ nguyên"} ${cod.amount ?? r.amount}đ`,
      cod_sau: after ? `${after.codStatus} ${after.codAmount}đ` : "—",
      don: before?.orderId ?? after?.orderId ?? "(chưa ghép được đơn)",
      ghi_chu: r.note ?? "",
    });
  }

  if (apply) {
    await audit({ userId: null, userEmail: "SHOP_OWNER", action: "VTP_MANUAL_VERIFICATION", entity: "SHIPMENT",
      reason: "Chủ shop xác minh trực tiếp trên giao diện Viettel Post cho lịch sử tháng 8 — webhook chưa chạy và tệp xuất không chứa vận đơn Shop hủy lấy",
      correlationId: BATCH,
      detail: { batch: BATCH, requested: RECORDS.length, found, created, evidenceNew, evidenceExisting, trackings: RECORDS.map((r) => r.tracking) } });
  }

  console.log(JSON.stringify({
    che_do: apply ? "ĐÃ GHI" : "CHẠY THỬ",
    lo: BATCH,
    yeu_cau: RECORDS.length, van_don_da_co: found, van_don_tao_moi: created,
    chung_cu_moi: evidenceNew, chung_cu_da_co: evidenceExisting,
    dong: rows,
  }, null, 2));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
