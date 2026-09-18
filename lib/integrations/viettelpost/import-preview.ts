import { createHash } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { vnStartOfDay } from "@/lib/format";
import { SHIPMENT_STAGE_LABEL } from "@/lib/constants/viettelpost";
import { detectVtpFile, mergeDetectedOrderLists, VtpFileError, type DetectedVtpFile } from "@/lib/integrations/viettelpost/import-files";
import { matchVtpOrderList, type OrderListMatch } from "@/lib/integrations/viettelpost/statement-db";
import type { ShipmentStage } from "@/db/schema";
import { PREVIEW_VERDICTS, type PreviewVerdict } from "@/lib/constants/vtp-import";

export type { PreviewVerdict };

/**
 * ═══════════ XEM TRƯỚC MỘT LẦN NHẬP TỆP VIETTEL POST ═══════════
 *
 * ─── VÌ SAO PHẢI CÓ BƯỚC NÀY ───
 *
 * Nhập tệp là đường CỨU khi webhook rơi và tài khoản API mù (audit RC-1). Nhưng nó cũng là đường
 * duy nhất mà một con người có thể, chỉ bằng một cú bấm, ghi đè trạng thái của hàng trăm vận đơn
 * bằng nội dung một tệp mà chưa ai đọc. Trước bản này ERP chỉ có "nhập" — không có "xem trước".
 *
 * Hàm này CHỈ ĐỌC. Nó dùng lại đúng trình đọc tệp (`detectVtpFile`) và đúng bộ ghép
 * (`matchVtpOrderList`) mà đường ghi dùng, nên con số xem trước và con số sau khi ghi không thể
 * lệch nhau vì hai luật khác nhau. Nếu muốn đổi cách ghép thì sửa ở đó, không sửa ở đây.
 *
 * ─── NÓ KHÔNG TRẢ LỜI CÂU "SẼ GHI BAO NHIÊU DÒNG" ───
 *
 * Nó trả lời "tệp này NÓI GÌ so với thứ ERP đang giữ". Con số cuối cùng có thể lệch một ít vì giữa
 * lúc xem và lúc ghi, một webhook có thể tới và đổi trạng thái — và khi đó việc ĐÚNG là dòng tệp
 * trở thành cũ hơn. Nói ra điều đó rõ ràng còn hơn hứa một con số không giữ được.
 */

export type PreviewRow = {
  trackingCode: string;
  orderLabel: string;
  verdict: PreviewVerdict;
  /** Chữ NGUYÊN VĂN của Viettel Post trong tệp — không thay bằng tên trong bảng mã của ERP. */
  fileStatusText: string;
  fileStage: ShipmentStage | null;
  fileStatusAt: string | null;
  erpStage: ShipmentStage | null;
  erpStatusAt: string | null;
  note: string;
};

export type ImportPreview = {
  filename: string;
  checksum: string;
  bytes: number;
  kind: "ORDER_LIST" | "STATEMENT_DETAIL" | "ERROR";
  rows: number;
  counts: Record<PreviewVerdict, number>;
  /** Mẫu dòng để người đọc kiểm chứng — không phải toàn bộ tệp. */
  sample: PreviewRow[];
  /** Lần nhập trước đã ÁP DỤNG đúng tệp này (theo checksum). Có nghĩa lần này sẽ không đổi gì mới. */
  previouslyAppliedAt: Date | null;
  error: string | null;
};

const RONG = Object.fromEntries(PREVIEW_VERDICTS.map((v) => [v, 0])) as Record<PreviewVerdict, number>;

/** SHA-256 của NỘI DUNG tệp — danh tính thật, không phụ thuộc tên tệp Viettel Post đặt. */
export function fileChecksum(base64: string): string {
  return createHash("sha256").update(Buffer.from(base64, "base64")).digest("hex");
}

/** Mốc ĐVVC của một dòng tệp, theo đúng luật mà đường ghi dùng. `null` = dòng không dùng được. */
function rowOccurredAt(m: OrderListMatch): Date | null {
  const at = m.statusAt ? new Date(m.statusAt) : m.statusDate ? vnStartOfDay(m.statusDate) : null;
  return at && Number.isFinite(at.getTime()) ? at : null;
}

/** Khoá của MỘT sự việc trong lịch sử: cùng khoá mà `applyVtpOrderList` dùng để chống trùng. */
function eventKey(shipmentId: string, statusText: string, at: Date): string {
  return `${shipmentId}|${statusText}|${at.getTime()}`;
}

/**
 * Phán quyết cho MỘT dòng tệp.
 *
 * ─── PHẢI NÓI ĐÚNG THỨ `applyVtpOrderList` SẼ LÀM, KHÔNG PHẢI THỨ NGHE HỢP LÝ ───
 *
 * Đo trên production 16/09/2026: chạy thử lại đúng tệp VỪA ĐƯỢC GHI bốn phút trước vẫn báo
 * "18 dòng sẽ cập nhật", trong khi đường ghi thật sẽ bỏ qua cả 18 vì sự kiện đã nằm sẵn trong lịch
 * sử. Một màn hình xem trước hứa nhiều hơn thứ sẽ xảy ra là màn hình phá đúng công dụng của nó —
 * người dùng bấm "Ghi vào ERP" rồi thấy con số khác, và lần sau họ thôi đọc nó.
 *
 * Hai nguồn sai đã bịt:
 *  · `daCo` — sự kiện `VTP_IMPORT` ĐÃ CÓ trong lịch sử cho đúng (vận đơn, trạng thái, mốc). Trước
 *    đây bộ `seen` chỉ chống trùng TRONG CÙNG MỘT TỆP, nên nó mù với mọi lần nhập trước đó.
 *  · CÙNG MỐC nhưng KHÁC CHẶNG — `applyVtpOrderList` gọi đó là `sameTimeConflict` và KHÔNG ghi;
 *    ở đây trước đây nó bị đọc thành "mới hơn ERP".
 */
function verdictOf(
  m: OrderListMatch,
  seen: Set<string>,
  daCo: Set<string>,
  /** Vận đơn mà ĐƯỜNG GHI sẽ thật sự chạm tới — khác `m.shipmentId` với dòng chiều hoàn. */
  dich: { id: string; stage: string | null; statusDate: Date | null } | null,
): { verdict: PreviewVerdict; note: string } {
  const at = rowOccurredAt(m);
  if (!at) return { verdict: "INVALID", note: "Không đọc được ngày trạng thái — dòng này sẽ bị bỏ qua" };
  if (m.matchIssue) return { verdict: "AMBIGUOUS", note: m.matchIssue };
  if (!m.shipmentId) return { verdict: "UNMATCHED", note: "ERP chưa có vận đơn mang mã này" };
  if (m.mapped.stage === "UNKNOWN") {
    return { verdict: "UNKNOWN_STATUS", note: `Chữ của ĐVVC được ghi vào sổ trạng thái để bổ sung bảng mã; trạng thái vận đơn giữ nguyên` };
  }
  /*
    VẬN ĐƠN CHIỀU HOÀN LÀ MỘT DÒNG KHÁC — và đây là chỗ bản đầu của màn hình xem trước sai nặng nhất.

    `matchVtpOrderList` trả `shipmentId` của vận đơn GỐC cho một dòng `…1P1` (nó ghép theo mã gốc để
    biết chiều hoàn này thuộc về ai). Nhưng `applyVtpOrderList` lại ghi lên dòng CHIỀU HOÀN, tra
    bằng chính mã `…1P1`. Bản đầu so dòng tệp của chiều hoàn với trạng thái của vận đơn GỐC — hai
    thực thể khác nhau.

    Đo trên production 16/09/2026: cả 18 dòng "sẽ cập nhật" còn sót đều là chiều hoàn, hiện ra dưới
    dạng vô lý `VTP:"Đang vận chuyển"` vs `ERP:DELIVERED` — vì "DELIVERED" là của gói hàng ĐI, còn
    "đang vận chuyển" là của gói hàng đang QUAY VỀ. Shop có 267 vận đơn chiều hoàn, nên bản đầu
    đọc sai TOÀN BỘ nhóm đó.
  */
  if (!dich) {
    // Chiều hoàn chưa có trong ERP: đường ghi sẽ TẠO nó thành một dòng riêng.
    return { verdict: "NEWER", note: "Vận đơn chiều hoàn chưa có trong ERP — sẽ được tạo thành dòng RIÊNG, không đè lên vận đơn gốc" };
  }
  const key = eventKey(dich.id, m.statusText, at);
  if (seen.has(key)) return { verdict: "DUPLICATE_ROW", note: "Cùng vận đơn, cùng trạng thái, cùng mốc với một dòng khác trong tệp" };
  seen.add(key);
  // ĐÃ NHẬP RỒI: đường ghi nhận ra là trùng và bỏ qua. Nói đúng điều đó thay vì hứa một cập nhật.
  if (daCo.has(key)) return { verdict: "SAME", note: "Lịch sử đã có đúng chứng từ này (một lần nhập trước) — ghi lại không đổi gì" };
  const erpAt = dich.statusDate;
  const nhanChang = SHIPMENT_STAGE_LABEL[(dich.stage ?? "UNKNOWN") as ShipmentStage];
  if (erpAt && erpAt.getTime() > at.getTime()) {
    return { verdict: "OLDER", note: `ERP đang giữ chứng từ muộn hơn (${nhanChang}) — không hạ trạng thái` };
  }
  if (dich.stage === m.mapped.stage && erpAt && erpAt.getTime() === at.getTime()) {
    return { verdict: "SAME", note: "Đã có đúng chứng từ này trong lịch sử" };
  }
  if (dich.stage === m.mapped.stage) return { verdict: "SAME", note: "Trạng thái đã trùng; chỉ làm mới tiền / cước nếu tệp có số khác" };
  // CÙNG MỐC, KHÁC CHẶNG: hai lời khai về CÙNG MỘT khoảnh khắc mà không khớp nhau. Đường ghi dừng
  // lại cho người đối chiếu (`sameTimeConflict`), nên ở đây cũng phải là "cần người quyết".
  if (erpAt && erpAt.getTime() === at.getTime()) {
    return {
      verdict: "AMBIGUOUS",
      note: `Cùng mốc ${at.toISOString()} nhưng ERP đang giữ ${nhanChang} — hai lời khai về cùng một khoảnh khắc, đường ghi sẽ dừng cho người đối chiếu`,
    };
  }
  return { verdict: "NEWER", note: `${nhanChang} → ${SHIPMENT_STAGE_LABEL[m.mapped.stage]}` };
}

/**
 * Chạy thử MỘT tệp. Không ghi gì vào `shipments` / `shipment_events`.
 *
 * Tệp CHI TIẾT BẢNG KÊ (tiền thực thu) cố ý KHÔNG được xem trước ở đây: nó đi vào chiều TIỀN, có
 * sổ chứng từ riêng (`cod_statement_lines`) và luật đối soát riêng. Trộn hai màn hình xem trước là
 * mời người dùng đọc số tiền bằng con mắt đang đọc trạng thái giao.
 */
export async function previewVtpOrderListFile(file: { filename: string; base64: string }): Promise<ImportPreview> {
  const buffer = Buffer.from(file.base64, "base64");
  const checksum = fileChecksum(file.base64);
  const base = { filename: file.filename, checksum, bytes: buffer.byteLength, rows: 0, counts: { ...RONG }, sample: [] as PreviewRow[], previouslyAppliedAt: null as Date | null };

  let detected: DetectedVtpFile;
  try {
    const isText = /\.(csv|txt|tsv)$/i.test(file.filename);
    detected = detectVtpFile(isText ? buffer.toString("utf8") : buffer, file.filename);
  } catch (e) {
    return { ...base, kind: "ERROR", error: e instanceof VtpFileError || e instanceof Error ? e.message : String(e) };
  }
  if (detected.kind !== "ORDER_LIST") {
    return {
      ...base,
      kind: "STATEMENT_DETAIL",
      rows: detected.rows.length,
      error:
        "Đây là tệp CHI TIẾT BẢNG KÊ (tiền thực thu), không phải danh sách vận đơn. Tiền đi qua màn hình đối soát COD — " +
        "nhập nó ở đây sẽ làm người đọc lẫn chiều tiền với chiều giao hàng.",
    };
  }

  const db = await getDb();
  const merged = mergeDetectedOrderLists([detected]);
  const matches = await matchVtpOrderList(merged);

  /*
    LỊCH SỬ ĐÃ CÓ GÌ RỒI — MỘT CÂU HỎI, KHÔNG PHẢI MỘT CÂU CHO MỖI DÒNG.

    Nạp trước các sự kiện `VTP_IMPORT` của đúng những vận đơn tệp này chạm tới, rồi so trong bộ
    nhớ. Với tệp 1.198 dòng đó là MỘT truy vấn thay vì 1.198 truy vấn.
  */
  /*
    DÒNG CHIỀU HOÀN ĐI VỀ MỘT VẬN ĐƠN KHÁC — phải tra riêng bằng chính mã `…1P1`.
    Xem đoạn dài trong `verdictOf`: `matchVtpOrderList` trả vận đơn GỐC cho dòng chiều hoàn, còn
    đường ghi lại chạm vào dòng CHIỀU HOÀN.
  */
  const maChieuHoan = [...new Set(matches.filter((m) => m.matchKind === "leg").map((m) => m.trackingCode.trim().toUpperCase()))];
  const legRows = maChieuHoan.length
    ? await db
        .select({ id: schema.shipments.id, code: schema.shipments.vtpOrderNumber, stage: schema.shipments.stage, statusDate: schema.shipments.vtpStatusDate })
        .from(schema.shipments)
        .where(inArray(sql`upper(${schema.shipments.vtpOrderNumber})`, maChieuHoan))
    : [];
  const legByCode = new Map(legRows.map((r) => [String(r.code ?? "").trim().toUpperCase(), { id: r.id, stage: r.stage as string | null, statusDate: r.statusDate }]));

  /** Vận đơn mà ĐƯỜNG GHI sẽ chạm tới cho dòng này. `null` = chưa tồn tại (chiều hoàn sẽ được tạo). */
  const dichCua = (m: OrderListMatch) => {
    if (m.matchKind === "leg") return legByCode.get(m.trackingCode.trim().toUpperCase()) ?? null;
    return m.shipmentId ? { id: m.shipmentId, stage: m.currentStage, statusDate: m.currentStatusDate } : null;
  };

  const shipmentIds = [...new Set(matches.map((m) => dichCua(m)?.id).filter((v): v is string => Boolean(v)))];
  const daCo = new Set<string>();
  if (shipmentIds.length) {
    const rows = await db
      .select({ shipmentId: schema.shipmentEvents.shipmentId, status: schema.shipmentEvents.status, occurredAt: schema.shipmentEvents.occurredAt })
      .from(schema.shipmentEvents)
      .where(and(eq(schema.shipmentEvents.source, "VTP_IMPORT"), inArray(schema.shipmentEvents.shipmentId, shipmentIds)));
    for (const r of rows) if (r.occurredAt) daCo.add(eventKey(r.shipmentId, r.status, r.occurredAt));
  }

  const counts = { ...RONG };
  const seen = new Set<string>();
  const sample: PreviewRow[] = [];
  // Xếp theo mốc để mẫu hiện ra đúng thứ tự mà đường ghi sẽ đi qua.
  for (const m of matches) {
    const dich = dichCua(m);
    const { verdict, note } = verdictOf(m, seen, daCo, dich);
    counts[verdict] += 1;
    // Mẫu ưu tiên những dòng THAY ĐỔI ĐƯỢC GÌ ĐÓ hoặc cần người quyết; dòng "giống ERP" chỉ để
    // lấp chỗ trống. Một bảng xem trước toàn dòng "không đổi gì" là bảng không ai đọc tới cuối.
    if (sample.length < 200 && verdict !== "SAME") {
      sample.push({
        trackingCode: m.trackingCode,
        orderLabel: m.orderLabel,
        verdict,
        fileStatusText: m.statusText,
        fileStage: m.mapped.stage === "UNKNOWN" ? null : m.mapped.stage,
        fileStatusAt: m.statusAt ?? m.statusDate ?? null,
        // Chặng của ĐÚNG vận đơn đường ghi sẽ chạm tới — với dòng chiều hoàn đó KHÔNG phải vận đơn gốc.
        erpStage: (dich?.stage ?? null) as ShipmentStage | null,
        erpStatusAt: dich?.statusDate ? dich.statusDate.toISOString() : null,
        note,
      });
    }
  }

  const [truoc] = await db
    .select({ at: schema.vtpImportBatches.createdAt })
    .from(schema.vtpImportBatches)
    .where(and(eq(schema.vtpImportBatches.checksum, checksum), eq(schema.vtpImportBatches.mode, "APPLY")))
    .orderBy(desc(schema.vtpImportBatches.createdAt))
    .limit(1);

  return {
    ...base,
    kind: "ORDER_LIST",
    rows: merged.length,
    counts,
    sample,
    previouslyAppliedAt: truoc?.at ?? null,
    error: null,
  };
}

/**
 * Ghi một dòng vào sổ lần nhập. Dùng cho CẢ chạy thử lẫn lần ghi thật — chạy thử được ghi cố ý:
 * nó trả lời câu "ai đã xem trước tệp này và thấy gì" khi con số sau đó gây tranh cãi.
 */
export async function ghiSoNhapTep(input: {
  filename: string;
  checksum: string;
  bytes: number;
  kind: "ORDER_LIST" | "STATEMENT_DETAIL" | "ERROR";
  mode: "PREVIEW" | "APPLY";
  uploadedBy: string;
  uploadedById: string | null;
  rows: number;
  matched?: number;
  applied?: number;
  stale?: number;
  duplicates?: number;
  conflicts?: number;
  unmatched?: number;
  unknownStatus?: number;
  invalid?: number;
  error?: string | null;
  summary?: unknown;
}): Promise<string> {
  const db = await getDb();
  const [row] = await db
    .insert(schema.vtpImportBatches)
    .values({
      filename: input.filename,
      checksum: input.checksum,
      bytes: input.bytes,
      kind: input.kind,
      mode: input.mode,
      uploadedBy: input.uploadedBy,
      uploadedById: input.uploadedById,
      rows: input.rows,
      matched: input.matched ?? 0,
      applied: input.applied ?? 0,
      stale: input.stale ?? 0,
      duplicates: input.duplicates ?? 0,
      conflicts: input.conflicts ?? 0,
      unmatched: input.unmatched ?? 0,
      unknownStatus: input.unknownStatus ?? 0,
      invalid: input.invalid ?? 0,
      error: input.error ?? null,
      summary: (input.summary ?? null) as Record<string, unknown> | null,
    })
    .returning({ id: schema.vtpImportBatches.id });
  return row.id;
}

/**
 * Bổ sung kết quả vào một dòng sổ ĐÃ LẬP.
 *
 * Dòng sổ của lần ghi thật phải tồn tại TRƯỚC khi ghi vận đơn, vì mỗi khoảng hụt webhook phát hiện
 * được đều trỏ về `batch_id` của lần nhập tìm ra nó. Lập sổ sau thì các dòng ấy mồ côi, và câu
 * "lần nhập nào phát hiện ra" — thứ duy nhất làm phép đo tra lại được — không trả lời được nữa.
 * Nên: lập dòng rỗng trước, điền số vào sau bằng hàm này.
 */
export async function capNhatSoNhapTep(
  id: string,
  patch: {
    matched?: number;
    applied?: number;
    stale?: number;
    duplicates?: number;
    conflicts?: number;
    unmatched?: number;
    unknownStatus?: number;
    invalid?: number;
    checked?: number;
    webhookOk?: number;
    webhookGaps?: number;
    error?: string | null;
    summary?: unknown;
  },
): Promise<void> {
  const db = await getDb();
  await db
    .update(schema.vtpImportBatches)
    .set({
      ...(patch.matched === undefined ? {} : { matched: patch.matched }),
      ...(patch.applied === undefined ? {} : { applied: patch.applied }),
      ...(patch.stale === undefined ? {} : { stale: patch.stale }),
      ...(patch.duplicates === undefined ? {} : { duplicates: patch.duplicates }),
      ...(patch.conflicts === undefined ? {} : { conflicts: patch.conflicts }),
      ...(patch.unmatched === undefined ? {} : { unmatched: patch.unmatched }),
      ...(patch.unknownStatus === undefined ? {} : { unknownStatus: patch.unknownStatus }),
      ...(patch.invalid === undefined ? {} : { invalid: patch.invalid }),
      ...(patch.checked === undefined ? {} : { checked: patch.checked }),
      ...(patch.webhookOk === undefined ? {} : { webhookOk: patch.webhookOk }),
      ...(patch.webhookGaps === undefined ? {} : { webhookGaps: patch.webhookGaps }),
      ...(patch.error === undefined ? {} : { error: patch.error }),
      ...(patch.summary === undefined ? {} : { summary: patch.summary as Record<string, unknown> | null }),
    })
    .where(eq(schema.vtpImportBatches.id, id));
}
