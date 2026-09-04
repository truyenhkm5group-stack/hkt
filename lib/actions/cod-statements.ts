"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { parseStatementDetail, parseStatementSummaryText, parseVtpOrderList, type StatementSummary } from "@/lib/integrations/viettelpost/statement";
import { applyStatementDetail, applyVtpOrderList, matchStatementRows, matchVtpOrderList, upsertStatementBatches, type DetailMatch, type OrderListMatch } from "@/lib/integrations/viettelpost/statement-db";

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

/** Đọc file danh sách vận đơn (Quản lý vận đơn → xuất Excel) và ghép với ERP (chưa ghi) */
export async function previewVtpOrderList(input: { base64: string; filename: string }): Promise<Result<{ rows: OrderListMatch[] }>> {
  const { error } = await authorize();
  if (error) return { error };
  if (!input?.base64 || input.base64.length > 20_000_000) return { error: "File trống hoặc quá lớn (tối đa ~15MB)" };
  try {
    const buffer = Buffer.from(input.base64, "base64");
    const isText = /\.(csv|txt|tsv)$/i.test(input.filename ?? "");
    const rows = parseVtpOrderList(isText ? buffer.toString("utf8") : buffer);
    return { ok: true, rows: await matchVtpOrderList(rows) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Không đọc được file" };
  }
}

const listSchema = z.array(z.object({ trackingCode: z.string().trim().min(5).max(60), statusText: z.string().max(200), cod: z.number().int().min(0), fee: z.number().int().min(0), statusDate: z.string().max(10) })).min(1).max(20000);

/** Ghi trạng thái Viettel Post từ danh sách vận đơn: giai đoạn, COD (Đã trả → đã về ngân hàng), cước */
export async function importVtpOrderList(input: unknown): Promise<Result<{ total: number; matched: number; updated: number; paid: number; unknown: number }>> {
  const { user, error } = await authorize();
  if (error) return { error };
  const parsed = listSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const result = await applyVtpOrderList(parsed.data.map((r) => ({ ...r, trackingCode: r.trackingCode.toUpperCase(), raw: "" })));
  await audit({ userId: user.id, userEmail: user.email, action: "VTP_ORDER_LIST_IMPORT", entity: "SHIPMENT", detail: result });
  revalidate();
  return { ok: true, ...result };
}
