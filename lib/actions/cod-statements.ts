"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { can, requireUser } from "@/lib/auth/session";
import { MAX_LIST_BASE64, MAX_LIST_FILES } from "@/lib/constants/cod";
import { LEDGER_CONFLICT_VERDICTS } from "@/lib/constants/vtp-import";
import { runVtpDataFileImport, type VtpImportFileResult } from "@/lib/integrations/viettelpost/import-run";
import { previewVtpOrderListFile, type ImportPreview } from "@/lib/integrations/viettelpost/import-preview";
import { ghiSoNhapTep } from "@/lib/integrations/viettelpost/import-preview";
export type { VtpImportFileResult, ImportPreview };

type Result<T = object> = ({ ok: true } & T) | { error: string };

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

/**
 * ═══════════ BƯỚC XEM TRƯỚC — CHỈ ĐỌC, KHÔNG GHI MỘT DÒNG NÀO ═══════════
 *
 * Nhập tệp là đường CỨU khi webhook rơi và tài khoản API không đọc được vận đơn do Pancake tạo.
 * Nó cũng là đường duy nhất mà một người, bằng một cú bấm, đổi trạng thái hàng trăm vận đơn bằng
 * nội dung một tệp chưa ai đọc. Trước bản này ERP chỉ có "nhập", không có "xem trước".
 *
 * Kết quả xem trước được GHI VÀO SỔ (`vtp_import_batches`, `mode = PREVIEW`) — cố ý: nó trả lời
 * câu "ai đã xem tệp này và thấy gì" khi con số sau đó gây tranh cãi.
 */
export async function previewVtpDataFiles(input: unknown): Promise<Result<{ previews: ImportPreview[] }>> {
  const { user, error } = await authorize();
  if (error) return { error };
  let files: { filename: string; base64: string }[];
  try {
    files = listFilesSchema.parse(input);
  } catch (e) {
    return { error: readableError(e, "Không đọc được danh sách tệp") };
  }
  try {
    const previews: ImportPreview[] = [];
    for (const file of files) {
      const p = await previewVtpOrderListFile(file);
      previews.push(p);
      await ghiSoNhapTep({
        filename: p.filename,
        checksum: p.checksum,
        bytes: p.bytes,
        kind: p.kind,
        mode: "PREVIEW",
        uploadedBy: user.email,
        uploadedById: user.id,
        rows: p.rows,
        matched: p.counts.NEWER + p.counts.SAME + p.counts.OLDER + p.counts.DUPLICATE_ROW,
        stale: p.counts.OLDER,
        duplicates: p.counts.DUPLICATE_ROW,
        // Cùng tập phán quyết mà đường GHI đếm vào cột này — hai lượt trên một tệp không được ghi
        // hai con số khác nhau vào cùng một cột.
        conflicts: LEDGER_CONFLICT_VERDICTS.reduce((n, v) => n + p.counts[v], 0),
        unmatched: p.counts.UNMATCHED,
        unknownStatus: p.counts.UNKNOWN_STATUS,
        invalid: p.counts.INVALID,
        error: p.error,
        summary: { counts: p.counts, sample: p.sample.slice(0, 50), previouslyAppliedAt: p.previouslyAppliedAt },
      }).catch(() => "");
    }
    // KHÔNG `revalidate()`: chạy thử không đổi dữ liệu nào, nên cũng không được xoá đệm của người khác.
    return { ok: true, previews };
  } catch (e) {
    return { error: readableError(e, "Không đọc thử được tệp") };
  }
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
    const result = await runVtpDataFileImport(files, user.email, { uploadedById: user.id });
    revalidate();
    return { ok: true, ...result };
  } catch (e) {
    return { error: readableError(e, "Không nhập được tệp") };
  }
}
