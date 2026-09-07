"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { can, requireUser } from "@/lib/auth/session";
import { MAX_LIST_BASE64, MAX_LIST_FILES } from "@/lib/constants/cod";
import { runVtpDataFileImport, type VtpImportFileResult } from "@/lib/integrations/viettelpost/import-run";
export type { VtpImportFileResult };

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

/** Nhập tệp Viettel Post từ giao diện. Lõi nằm ở `viettelpost/import-run.ts` để luồng tự động
 *  (Apps Script đọc thư bảng kê trong Gmail) dùng chung đúng một cách xử lý. */
export async function importVtpDataFiles(input: unknown): Promise<Result<{ files: VtpImportFileResult[]; orderRows: number; statementRows: number }>> {
  const { user, error } = await authorize();
  if (error) return { error };
  let files: { filename: string; base64: string }[];
  try {
    files = listFilesSchema.parse(input);
  } catch (e) {
    return { error: readableError(e, "Không đọc được danh sách tệp") };
  }
  try {
    const result = await runVtpDataFileImport(files, user.email);
    revalidate();
    return { ok: true, ...result };
  } catch (e) {
    return { error: readableError(e, "Không nhập được tệp") };
  }
}
