"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import type { CoreResult } from "@/lib/wholesale/campaigns";
import { bulkEmailPrepareCore, bulkEmailSubmitCore, zaloSessionPrepareCore, type BulkEmailPrep, type BulkEmailResult, type ZaloSessionItem } from "@/lib/wholesale/bulk-outreach";

/**
 * Vỏ Next của «liên hệ hàng loạt» trên danh sách lead (lib/wholesale/bulk-outreach.ts). Lõi tự kiểm quyền `wholesale:work`,
 * phạm vi dữ liệu và đi qua đúng đường E1 / ghi kết quả Zalo sẵn có; tệp này chỉ lấy người dùng và làm mới trang.
 */

function refresh() {
  revalidatePath("/wholesale/leads");
  revalidatePath("/wholesale/outbox");
  revalidatePath("/wholesale/outreach");
}

/** Dựng nháp email cá nhân hoá cho các lead đã tích (chưa đưa vào hộp thư đi). */
export async function bulkEmailPrepareAction(input: unknown): Promise<CoreResult<{ prep: BulkEmailPrep }>> {
  const user = await requireUser();
  return bulkEmailPrepareCore(user, input);
}

/** Đưa các thư người đã duyệt vào hộp thư đi (mỗi thư qua đường E1 + cổng chính sách). */
export async function bulkEmailSubmitAction(input: unknown): Promise<CoreResult<{ results: BulkEmailResult[]; eta: string; dryRun: boolean }>> {
  const user = await requireUser();
  const r = await bulkEmailSubmitCore(user, input);
  if ("ok" in r) refresh();
  return r;
}

/** Phiên nhắn Zalo tuần tự: danh sách khách + tin cá nhân hoá + link zalo.me. Không gửi gì. */
export async function zaloSessionPrepareAction(input: unknown): Promise<CoreResult<{ items: ZaloSessionItem[]; outOfScope: number }>> {
  const user = await requireUser();
  return zaloSessionPrepareCore(user, input);
}
