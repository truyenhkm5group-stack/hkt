"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth/session";
import type { MetadataErrorCode } from "@/lib/metadata/errors";
import type { FieldError } from "@/lib/metadata/types";
import { PRODUCT_IMPORT_MAX_BYTES, type ImportCheckResult, type ImportFileSummary, type ImportRunResult } from "@/lib/products/import-shared";
import { checkProductImport, describeProductImport, runProductImport, type ProductImportFile } from "@/lib/products/import";

/**
 * ═══════════ NHẬP SẢN PHẨM TỪ TỆP — CỬA SERVER ACTION ═══════════
 *
 * Mỏng: phiên → lược đồ đầu vào → lõi (`lib/products/import.ts` — cổng tổ chức + quyền, đọc tệp, kiểm, ghi, nhật ký) →
 * `revalidatePath`. Tệp đi dưới dạng base64 (như nhập sao kê / tệp ĐVVC): .xlsx là nhị phân, ép thành chuỗi UTF-8 là ra
 * rác. MỌI lượt gửi lại TOÀN BỘ tệp + ghép cột — máy chủ đọc và kiểm lại từ đầu, không tin kết quả client đang giữ.
 * Lỗi nghiệp vụ trả `{ error, errors, code }`, không ném.
 */

type Failure = { error: string; errors: FieldError[]; code: MetadataErrorCode };

/** base64 phình ~4/3 so với tệp gốc. */
const MAX_BASE64 = Math.ceil((PRODUCT_IMPORT_MAX_BYTES * 4) / 3) + 1024;

const fileSchema = z.object({
  fileName: z.string().trim().min(1, "Thiếu tên tệp").max(250, "Tên tệp quá dài"),
  base64: z.string().min(1, "Tệp trống").max(MAX_BASE64, "Tệp quá lớn (tối đa 2 MB)"),
});

function invalid(message: string): Failure {
  return { error: message, errors: [{ field: "_", message }], code: "INVALID" };
}

function failure(r: { code: MetadataErrorCode; errors: FieldError[] }): Failure {
  return { error: r.errors.map((e) => e.message).join(" · ") || "Không xử lý được tệp.", errors: r.errors, code: r.code };
}

function toFile(input: unknown): ProductImportFile | Failure {
  const parsed = fileSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error.issues[0]?.message ?? "Tệp không hợp lệ");
  return { fileName: parsed.data.fileName, data: new Uint8Array(Buffer.from(parsed.data.base64, "base64")) };
}

/** Bước 1: đọc tệp ⇒ tiêu đề, 20 dòng đầu, ghép cột gợi ý, field tuỳ biến của Sản phẩm. Không ghi gì. */
export async function describeProductImportAction(input: unknown): Promise<({ ok: true } & ImportFileSummary) | Failure> {
  const user = await requireUser();
  const file = toFile(input);
  if ("error" in file) return file;
  const r = await describeProductImport(user, file);
  return r.ok ? r : failure(r);
}

/** Bước 2: KIỂM (chạy thử) — không ghi một dòng nào. */
export async function checkProductImportAction(input: unknown, options: unknown): Promise<ImportCheckResult | Failure> {
  const user = await requireUser();
  const file = toFile(input);
  if ("error" in file) return file;
  const r = await checkProductImport(user, file, options);
  return r.ok ? r : failure(r);
}

/** Bước 3: NHẬP — chỉ khi người bấm; tệp phải đúng checksum của lần kiểm. */
export async function runProductImportAction(input: unknown, options: unknown, expectedChecksum: unknown): Promise<ImportRunResult | Failure> {
  const user = await requireUser();
  const file = toFile(input);
  if ("error" in file) return file;
  const r = await runProductImport(user, file, options, expectedChecksum);
  if (!r.ok) return failure(r);
  if (r.counts.created > 0) {
    for (const path of ["/products", "/inventory/receipts", "/inventory"]) revalidatePath(path);
  }
  return r;
}
