"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { MAX_LIST_BASE64, MAX_LIST_FILES } from "@/lib/constants/cod";
import { mergeVtpOrderLists, parseStatementDetail, parseStatementSummaryText, parseVtpOrderList, type StatementSummary } from "@/lib/integrations/viettelpost/statement";
import { detectVtpFile, mergeDetectedOrderLists, type DetectedVtpFile } from "@/lib/integrations/viettelpost/import-files";
import { applyStatementDetail, applyVtpOrderList, applyStatementDetailRows, matchStatementFileToBatch, matchStatementRows, matchVtpOrderList, upsertStatementBatches, type DetailMatch, type OrderListMatch, type StatementFileMatch } from "@/lib/integrations/viettelpost/statement-db";

type Result<T = object> = ({ ok: true } & T) | { error: string };

const summarySchema = z.object({
  reference: z.string().trim().min(3).max(120).transform((v) => v.toUpperCase()),
  receivedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  codGross: z.number().int().min(0).max(50_000_000_000),
  feeTotal: z.number().int().min(0).max(50_000_000_000),
  netAmount: z.number().int().min(0).max(50_000_000_000),
});

function revalidate() {
  for (const p of ["/cod", "/reports", "/", "/shipments"]) revalidatePath(p);
}

async function authorize() {
  const user = await requireUser();
  return { user, error: can(user, "cod:write") ? null : "Bạn không có quyền đối soát COD" };
}

/** Phân tích bảng dán từ viettelpost.vn (chưa ghi) */
export async function parseVtpStatementText(text: string): Promise<Result<{ rows: StatementSummary[] }>> {
  const { error } = await authorize();
  if (error) return { error };
  if (typeof text !== "string" || text.length > 200_000) return { error: "Nội dung quá dài" };
  const rows = parseStatementSummaryText(text);
  if (!rows.length) return { error: "Không nhận ra dòng bảng kê nào (cần mã bảng kê, ngày đối soát và các số tiền)" };
  return { ok: true, rows };
}

/** Lưu các bảng kê tổng hợp (mã, ngày, COD, cước, thu về) thành đợt nhận tiền */
export async function saveVtpStatements(input: unknown): Promise<Result<{ created: number; updated: number }>> {
  const { user, error } = await authorize();
  if (error) return { error };
  const parsed = z.array(summarySchema).min(1).max(500).safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const result = await upsertStatementBatches(parsed.data, user.email);
  await audit({ userId: user.id, userEmail: user.email, action: "COD_STATEMENTS_IMPORT", entity: "COD_BATCH", detail: { count: parsed.data.length, references: parsed.data.map((r) => r.reference), ...result } });
  revalidate();
  return { ok: true, ...result };
}

/** Đọc file chi tiết bảng kê (base64) và ghép với vận đơn ERP (chưa ghi) */
export async function previewVtpStatementDetail(input: { base64: string; filename: string }): Promise<Result<{ rows: DetailMatch[] }>> {
  const { error } = await authorize();
  if (error) return { error };
  if (!input?.base64 || input.base64.length > 15_000_000) return { error: "File trống hoặc quá lớn (tối đa ~10MB)" };
  try {
    const buffer = Buffer.from(input.base64, "base64");
    const isText = /\.(csv|txt|tsv)$/i.test(input.filename ?? "");
    const rows = parseStatementDetail(isText ? buffer.toString("utf8") : buffer, input.filename);
    return { ok: true, rows: await matchStatementRows(rows) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Không đọc được file" };
  }
}

const detailSchema = z.object({
  summary: summarySchema,
  rows: z
    .array(z.object({ trackingCode: z.string().trim().min(6).max(60), cod: z.number().int().min(0), fee: z.number().int().min(0), net: z.number().int() }))
    .min(1)
    .max(5000),
});

/** Ghi chi tiết bảng kê: tạo/cập nhật đợt, gắn vận đơn, đánh dấu đã về ngân hàng */
export async function importVtpStatementDetail(input: unknown): Promise<Result<{ matched: number; unmatched: number; batchId: string }>> {
  const { user, error } = await authorize();
  if (error) return { error };
  const parsed = detailSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const rows = parsed.data.rows.map((r) => ({ ...r, trackingCode: r.trackingCode.toUpperCase(), raw: "" }));
  const result = await applyStatementDetail(parsed.data.summary, rows, user.email);
  await audit({ userId: user.id, userEmail: user.email, action: "COD_STATEMENT_DETAIL", entity: "COD_BATCH", entityId: result.batchId, detail: { reference: parsed.data.summary.reference, ...result } });
  revalidate();
  return { ok: true, matched: result.matched, unmatched: result.unmatched, batchId: result.batchId };
}

/**
 * Giới hạn một lượt nhập. Bảng kê Viettel Post xuất theo từng đợt đối soát nên một lần nhập
 * vài chục tệp là bình thường; giới hạn 10 tệp trước đây chặn nhầm việc dùng thật.
 * Trần dung lượng phải nằm dưới serverActions.bodySizeLimit trong next.config.ts.
 */

const listFilesSchema = z
  .array(z.object({ filename: z.string().min(1).max(250), base64: z.string().min(1) }))
  .min(1, "Chưa chọn tệp nào")
  .max(MAX_LIST_FILES, `Tối đa ${MAX_LIST_FILES} tệp mỗi lượt — hãy chia thành nhiều lượt`)
  .refine(
    (files) => files.reduce((sum, file) => sum + file.base64.length, 0) <= MAX_LIST_BASE64,
    `Tổng dung lượng vượt ${Math.round(MAX_LIST_BASE64 / 1_000_000)} MB — hãy chia thành nhiều lượt`,
  );

/**
 * Lỗi hiển thị cho người dùng. Trước đây lỗi Zod lọt thẳng ra giao diện dưới dạng JSON thô
 * ("too_big: expected array to have <=10 items"), chủ shop không hiểu và không biết phải làm gì.
 */
function readableError(error: unknown, fallback: string) {
  if (error instanceof z.ZodError) return error.issues[0]?.message ?? fallback;
  return error instanceof Error && error.message ? error.message : fallback;
}

function readOrderListFiles(input: unknown) {
  const files = listFilesSchema.parse(input);
  return mergeVtpOrderLists(files.flatMap((file) => {
    const buffer = Buffer.from(file.base64, "base64");
    return parseVtpOrderList(/\.(csv|txt|tsv)$/i.test(file.filename) ? buffer.toString("utf8") : buffer);
  }));
}

/** Preview và nhập đều đọc lại file gốc trên server, tránh mất mã tham chiếu/cột nguồn khi gửi từ UI. */
export async function previewVtpOrderListFiles(input: unknown): Promise<Result<{ rows: OrderListMatch[] }>> {
  const { error } = await authorize();
  if (error) return { error };
  try { return { ok: true, rows: await matchVtpOrderList(readOrderListFiles(input)) }; }
  catch (e) { return { error: readableError(e, "Không đọc được file") }; }
}

export async function importVtpOrderListFiles(input: unknown): Promise<Result<Awaited<ReturnType<typeof applyVtpOrderList>>>> {
  const { user, error } = await authorize();
  if (error) return { error };
  try {
    const result = await applyVtpOrderList(readOrderListFiles(input), user.email);
    revalidate();
    return { ok: true, ...result };
  } catch (e) { return { error: readableError(e, "Không nhập được file; hãy xem nhật ký các dòng đã xử lý trước khi thử lại") }; }
}

/** Đọc nhiều file chi tiết bảng kê; mỗi file được ghép với đợt tiền về bằng SỐ TIỀN. */
function readDetailFiles(input: unknown) {
  const files = listFilesSchema.parse(input);
  return files.map((file) => {
    const buffer = Buffer.from(file.base64, "base64");
    const isText = /\.(csv|txt|tsv)$/i.test(file.filename);
    return { filename: file.filename, rows: parseStatementDetail(isText ? buffer.toString("utf8") : buffer, file.filename) };
  });
}

export async function previewVtpStatementDetailFiles(input: unknown): Promise<Result<{ files: StatementFileMatch[] }>> {
  const { error } = await authorize();
  if (error) return { error };
  try {
    const parsed = readDetailFiles(input);
    const files: StatementFileMatch[] = [];
    for (const file of parsed) files.push(await matchStatementFileToBatch(file.filename, file.rows));
    return { ok: true, files };
  } catch (e) {
    return { error: readableError(e, "Không đọc được file") };
  }
}

/**
 * Nhập nhiều file chi tiết cùng lúc. File chi tiết là CHỨNG TỪ GỐC nên LUÔN được ghi,
 * kể cả khi chưa có "đợt tiền về" nào khớp số tiền — đợt chỉ là bản tổng hợp nhập tay.
 * Nếu có đợt khớp thì gắn thêm để biết tiền đã về tài khoản theo đợt nào.
 */
export async function importVtpStatementDetailFiles(input: unknown): Promise<Result<{ files: StatementFileMatch[]; linked: number; withCash: number }>> {
  const { user, error } = await authorize();
  if (error) return { error };
  try {
    const parsed = readDetailFiles(input);
    const files: StatementFileMatch[] = [];
    let linked = 0;
    let withCash = 0;
    for (const file of parsed) {
      const match = await matchStatementFileToBatch(file.filename, file.rows);
      const result = await applyStatementDetailRows(file.rows, file.filename, match.batchId);
      linked += result.linked;
      withCash += result.withCash;
      files.push({ ...match, matchedShipments: result.linked });
      await audit({
        userId: user.id,
        userEmail: user.email,
        action: "COD_STATEMENT_DETAIL",
        entity: "COD_BATCH",
        entityId: match.batchId ?? file.filename,
        detail: { filename: file.filename, reference: match.batchReference, linked: result.linked, withCash: result.withCash, period: [match.periodFrom, match.periodTo], unmatchedCodes: match.unmatchedCodes },
      });
    }
    revalidate();
    return { ok: true, files, linked, withCash };
  } catch (e) {
    return { error: readableError(e, "Không nhập được file") };
  }
}

export type VtpImportFileResult = {
  filename: string;
  kind: "ORDER_LIST" | "STATEMENT_DETAIL" | "ERROR";
  rows: number;
  periodFrom: string | null;
  periodTo: string | null;
  /** Danh sách vận đơn: số vận đơn được cập nhật. Bảng kê: số vận đơn ghi được chứng từ. */
  applied: number;
  withCash: number;
  matchedBatch: string | null;
  note: string;
};

/**
 * MỘT CHỖ NHẬP DUY NHẤT cho cả hai loại tệp Viettel Post.
 *
 * Viettel Post chia nhỏ tệp theo khoảng ngày nên chủ shop luôn có nhiều tệp mỗi lần tải.
 * ERP tự nhận loại từng tệp (danh sách vận đơn hay chi tiết bảng kê) rồi đưa vào đúng luồng,
 * để không phải chọn tab và không nhập nhầm loại — một bên là trạng thái giao, một bên là tiền.
 *
 * Thứ tự xử lý cố ý: DANH SÁCH VẬN ĐƠN trước, CHI TIẾT BẢNG KÊ sau. Danh sách tạo/cập nhật
 * vận đơn, bảng kê mới có cái để ghi tiền thực thu lên.
 */
export async function importVtpDataFiles(input: unknown): Promise<Result<{ files: VtpImportFileResult[]; orderRows: number; statementRows: number }>> {
  const { user, error } = await authorize();
  if (error) return { error };
  let files: { filename: string; base64: string }[];
  try {
    files = listFilesSchema.parse(input);
  } catch (e) {
    return { error: readableError(e, "Không đọc được danh sách tệp") };
  }

  const detected: DetectedVtpFile[] = [];
  const results: VtpImportFileResult[] = [];
  for (const file of files) {
    const buffer = Buffer.from(file.base64, "base64");
    const isText = /\.(csv|txt|tsv)$/i.test(file.filename);
    try {
      detected.push(detectVtpFile(isText ? buffer.toString("utf8") : buffer, file.filename));
    } catch (e) {
      results.push({ filename: file.filename, kind: "ERROR", rows: 0, periodFrom: null, periodTo: null, applied: 0, withCash: 0, matchedBatch: null, note: readableError(e, "Không đọc được tệp") });
    }
  }

  // 1) Danh sách vận đơn — gộp mọi tệp rồi ghi một lần để xử lý trùng/xung đột giữa các tệp.
  const orderFiles = detected.filter((d) => d.kind === "ORDER_LIST");
  let orderRows = 0;
  if (orderFiles.length) {
    const merged = mergeDetectedOrderLists(detected);
    orderRows = merged.length;
    const applied = await applyVtpOrderList(merged, user.email);
    const dates = merged.map((r) => r.statusDate).filter(Boolean).sort();
    for (const f of orderFiles) {
      results.push({
        filename: f.filename,
        kind: "ORDER_LIST",
        rows: f.rows.length,
        periodFrom: dates[0] ?? null,
        periodTo: dates[dates.length - 1] ?? null,
        applied: applied.updated,
        withCash: 0,
        matchedBatch: null,
        note: `Toàn bộ tệp danh sách gộp lại: cập nhật ${applied.updated} vận đơn`
          + (applied.linked ? ` (${applied.linked} vận đơn được gắn mã theo SĐT người nhận)` : "")
          + `, ${applied.legs} chiều hoàn, bỏ qua ${applied.stale} dòng cũ, ${applied.conflicts} xung đột cần đối chiếu`
          + (applied.unmatched ? `, ${applied.unmatched} vận đơn của VTP chưa có trong ERP` : ""),
      });
    }
    await audit({ userId: user.id, userEmail: user.email, action: "VTP_ORDER_LIST_IMPORT", entity: "SHIPMENT", detail: { files: orderFiles.map((f) => f.filename), ...applied } });
  }

  // 2) Chi tiết bảng kê — ghi tiền thực thu, luôn ghi kể cả chưa có đợt tiền về khớp.
  let statementRows = 0;
  for (const f of detected) {
    if (f.kind !== "STATEMENT_DETAIL") continue;
    statementRows += f.rows.length;
    const match = await matchStatementFileToBatch(f.filename, f.rows);
    const applied = await applyStatementDetailRows(f.rows, f.filename, match.batchId);
    results.push({
      filename: f.filename,
      kind: "STATEMENT_DETAIL",
      rows: f.rows.length,
      periodFrom: match.periodFrom,
      periodTo: match.periodTo,
      applied: applied.linked,
      withCash: applied.withCash,
      matchedBatch: match.batchReference,
      note: applied.linked === 0 ? (match.issue ?? "Không vận đơn nào trong tệp có trong ERP") : `Ghi chứng từ cho ${applied.linked} vận đơn, ${applied.withCash} vận đơn có tiền thực thu`,
    });
    await audit({ userId: user.id, userEmail: user.email, action: "COD_STATEMENT_DETAIL", entity: "COD_BATCH", entityId: match.batchId ?? f.filename, detail: { filename: f.filename, ...applied, period: [match.periodFrom, match.periodTo] } });
  }

  revalidate();
  return { ok: true, files: results, orderRows, statementRows };
}
