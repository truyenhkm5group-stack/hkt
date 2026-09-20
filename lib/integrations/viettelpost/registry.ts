import { sql } from "drizzle-orm";
import { moTaLoiCsdl } from "@/lib/db/error-message";
import { schema, type Db } from "@/db";
import { resolveVtpStatus, type VtpResolved } from "@/lib/integrations/viettelpost/status";

/**
 * ═══════════ MỖI CÂU VIETTEL POST TỪNG NÓI PHẢI CÓ MỘT DÒNG TRONG SỔ ═══════════
 *
 * ─── ĐIỀU NÀY SỬA CÁI GÌ ───
 *
 * Trạng thái ĐVVC mà ERP chưa dịch được KHÔNG bị mất khỏi `shipment_events` — chỗ đó đã đúng từ
 * trước. Nhưng nó biến mất khỏi mắt người vận hành, vì `deriveShipmentState()` lọc bỏ mọi sự kiện
 * `UNKNOWN` (đúng: không đủ căn cứ thì không kết luận), nên ảnh chụp trên màn hình giữ nguyên câu
 * CŨ và không có dấu hiệu nào cho biết ĐVVC vừa nói một câu mới.
 *
 * Sổ này là chỗ câu ấy hiện ra: mã, chữ, gặp bao nhiêu lần, lần đầu và lần cuối lúc nào, nguồn nào
 * mang tới, một mẫu gói tin thô để kiểm chứng.
 *
 * ─── NÓ KHÔNG PHẢI BẢNG MÃ THỨ HAI ───
 *
 * Việc DỊCH vẫn chỉ có một chỗ: `resolveVtpStatus` đọc `VTP_STATUS`. Sổ này chỉ QUAN SÁT. Cách sửa
 * một mã lạ là bổ sung vào `lib/constants/viettelpost.ts::VTP_STATUS` rồi lần gặp sau nó tự được
 * ghi lại là đã dịch được — KHÔNG phải sửa một dòng ở đây. Nếu ai đó biến bảng này thành nguồn
 * dịch, ERP sẽ có hai bộ luật và chúng sẽ lệch nhau, đúng lỗi mà `status.ts` sinh ra để chấm dứt.
 *
 * ─── KHÔNG BAO GIỜ LÀM HỎNG ĐƯỜNG NẠP ───
 *
 * Viettel Post đòi HTTP 200 trong dưới một giây và thử lại tối đa 5 lần. Mất một dòng quan sát là
 * mất một dòng ghi chú; mất một sự kiện hành trình là mất vĩnh viễn. Nên lỗi ở đây bị nuốt có chủ
 * đích, đúng như mọi nhánh phụ khác của đường webhook.
 */

/** Chuẩn hoá chữ để làm khoá: bỏ dấu, gộp khoảng trắng, chữ thường. */
function chuanHoa(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * KHOÁ TỰ NHIÊN CỦA MỘT TRẠNG THÁI ĐVVC.
 *
 * Mã số nếu có; ngược lại tên đã chuẩn hoá. Cố ý KHÔNG ghép `(mã, tên)`: Viettel Post sửa câu chữ
 * cho cùng một mã (đã gặp với 501 — "Phát thành công" và "Thành công - Phát thành công"), và ghép
 * cả hai vào khoá sẽ đẻ ra một dòng "mã mới" mỗi lần họ sửa chính tả.
 *
 * `null` = gói tin không mang trạng thái nào ⇒ không có gì để ghi.
 */
export function statusRegistryKey(code: number | null | undefined, name: string | null | undefined): string | null {
  if (code !== null && code !== undefined && Number.isFinite(code)) return String(code);
  const text = chuanHoa(String(name ?? ""));
  return text ? `text:${text}` : null;
}

export type StatusObservation = {
  code: number | null;
  name: string;
  source: string;
  shipmentId: string | null;
  raw?: unknown;
  /** Kết quả dịch, truyền vào để không dịch lại hai lần cho cùng một sự kiện. */
  resolved?: VtpResolved;
};

/**
 * Ghi (hoặc cập nhật) một loạt quan sát. Idempotent: gặp lại cùng một trạng thái chỉ tăng bộ đếm
 * và dời `last_seen_at`, không sinh dòng mới.
 *
 * Trả về danh sách khoá của những trạng thái ERP CHƯA DỊCH ĐƯỢC trong lô này — để lớp gọi ghi log
 * hoặc bật cảnh báo mà không phải đọc lại bảng.
 */
export async function ghiSoTrangThai(db: Db, quanSat: StatusObservation[]): Promise<string[]> {
  if (!quanSat.length) return [];
  // Gộp trong bộ nhớ trước: một gói tin webhook mang cả hành trình nên cùng một mã xuất hiện nhiều
  // lần. Gửi từng dòng xuống sẽ là N lệnh ghi cho cùng một hàng và N lần khoá hàng đó.
  const gop = new Map<string, StatusObservation & { lan: number }>();
  for (const q of quanSat) {
    const key = statusRegistryKey(q.code, q.name);
    if (!key) continue;
    const cu = gop.get(key);
    if (cu) {
      cu.lan += 1;
      // Giữ câu chữ và mẫu thô MỚI NHẤT trong lô.
      if (q.name) cu.name = q.name;
      if (q.raw !== undefined) cu.raw = q.raw;
      if (q.shipmentId) cu.shipmentId = q.shipmentId;
    } else {
      gop.set(key, { ...q, lan: 1 });
    }
  }
  if (!gop.size) return [];

  const chuaDich: string[] = [];
  const values = [...gop.entries()].map(([key, q]) => {
    const resolved = q.resolved ?? resolveVtpStatus({ code: q.code, text: q.name });
    const mapped = resolved.basis === "code" || resolved.basis === "text";
    if (!mapped) chuaDich.push(key);
    return {
      statusKey: key,
      statusCode: q.code ?? null,
      statusName: q.name ?? "",
      normalizedStage: resolved.stage,
      resolveBasis: resolved.basis,
      mapped,
      occurrences: q.lan,
      lastSource: q.source,
      lastShipmentId: q.shipmentId,
      sampleRaw: (q.raw ?? null) as Record<string, unknown> | null,
    };
  });

  try {
    await db
      .insert(schema.vtpStatusRegistry)
      .values(values)
      .onConflictDoUpdate({
        target: schema.vtpStatusRegistry.statusKey,
        set: {
          // Cộng dồn, không ghi đè: bộ đếm là số lần ĐÃ GẶP từ trước tới nay.
          occurrences: sql`${schema.vtpStatusRegistry.occurrences} + excluded.occurrences`,
          statusName: sql`excluded.status_name`,
          statusCode: sql`coalesce(excluded.status_code, ${schema.vtpStatusRegistry.statusCode})`,
          // Dịch lại MỖI LẦN GẶP: bổ sung mã vào `VTP_STATUS` là dòng cũ tự đúng ở lần gặp kế tiếp,
          // không cần một lượt chạy lại nào.
          normalizedStage: sql`excluded.normalized_stage`,
          resolveBasis: sql`excluded.resolve_basis`,
          mapped: sql`excluded.mapped`,
          lastSeenAt: sql`now()`,
          lastSource: sql`excluded.last_source`,
          lastShipmentId: sql`coalesce(excluded.last_shipment_id, ${schema.vtpStatusRegistry.lastShipmentId})`,
          sampleRaw: sql`coalesce(excluded.sample_raw, ${schema.vtpStatusRegistry.sampleRaw})`,
          updatedAt: sql`now()`,
        },
      });
  } catch (error) {
    // Sổ quan sát không được phép làm hỏng đường ghi chứng từ ĐVVC — xem đoạn đầu tệp.
    console.warn(`[vtp-registry] không ghi được sổ trạng thái: ${moTaLoiCsdl(error)}`);
    return chuaDich;
  }
  if (chuaDich.length) {
    // Một dòng log tra được bằng `docker logs`, ngoài bảng. Trạng thái lạ là việc phải làm, không
    // phải chuyện bình thường — nhưng nó KHÔNG được làm hỏng lượt nạp.
    console.warn(`[vtp-registry] Viettel Post gửi trạng thái ERP chưa dịch được: ${chuaDich.join(", ")}`);
  }
  return chuaDich;
}
