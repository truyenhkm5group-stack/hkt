"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { MAX_LIST_BASE64, MAX_LIST_FILES } from "@/lib/constants/cod";
import { mergeVtpOrderLists, parseStatementDetail, parseStatementSummaryText, parseVtpOrderList, type StatementSummary } from "@/lib/integrations/viettelpost/statement";
import { applyStatementDetail, applyVtpOrderList, linkStatementDetailToBatch, matchStatementFileToBatch, matchStatementRows, matchVtpOrderList, upsertStatementBatches, type DetailMatch, type OrderListMatch, type StatementFileMatch } from "@/lib/integrations/viettelpost/statement-db";

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
 * Nhập nhiều file chi tiết cùng lúc. Chỉ gắn file nào ghép được ĐÚNG MỘT đợt theo số tiền;
 * file chưa đủ căn cứ được bỏ qua và báo lại lý do, không đoán bừa.
 */
export async function importVtpStatementDetailFiles(input: unknown): Promise<Result<{ files: StatementFileMatch[]; linked: number; skipped: number }>> {
  const { user, error } = await authorize();
  if (error) return { error };
  try {
    const parsed = readDetailFiles(input);
    const files: StatementFileMatch[] = [];
    let linked = 0;
    let skipped = 0;
    for (const file of parsed) {
      const match = await matchStatementFileToBatch(file.filename, file.rows);
      if (!match.batchId) {
        skipped += 1;
        files.push(match);
        continue;
      }
      const result = await linkStatementDetailToBatch(match.batchId, file.rows);
      linked += result.linked;
      files.push({ ...match, matchedShipments: result.linked });
      await audit({
        userId: user.id,
        userEmail: user.email,
        action: "COD_STATEMENT_DETAIL",
        entity: "COD_BATCH",
        entityId: match.batchId,
        detail: { filename: file.filename, reference: match.batchReference, linked: result.linked, unmatchedCodes: match.unmatchedCodes },
      });
    }
    revalidate();
    return { ok: true, files, linked, skipped };
  } catch (e) {
    return { error: readableError(e, "Không nhập được file") };
  }
}
