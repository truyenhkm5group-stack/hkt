import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";

/**
 * ═══════════ MỐC "ĐÃ ĐỌC ĐƯỢC THẬT" — KHÔNG SUY RA TỪ TRẠNG THÁI LƯỢT CHẠY ═══════════
 *
 * LỖI CỦA CHÍNH BẢN VÁ TRƯỚC (phát hiện lúc review, 20/09/2026). Độ tươi của sổ deploy ban đầu
 * đọc từ `sync_runs`: lượt gần nhất có trạng thái `SUCCESS` hoặc `PARTIAL` thì coi là đã đọc. Sai,
 * và sai đúng ở ca cần đúng nhất:
 *
 * `runGithubDeploymentSync` đặt `ctx.summary.warning` cho MỌI nhánh bỏ qua — hết hạn mức, lỗi
 * mạng, token sai, chưa cấu hình — và `runSyncJob` biến một lượt có `warning` thành `PARTIAL`.
 * Nên một lượt **đọc được 0 dòng** vẫn ghi `PARTIAL`, sổ vẫn trông MỚI, và `/tech/deployments`
 * lại in "LỆCH — container có thể chưa khởi động lại": đúng cái báo động giả mà bản vá sinh ra để
 * chặn. Hết hạn mức là lúc sổ CHẮC CHẮN đứng im, mà cũng là lúc nó trông tươi nhất.
 *
 * Nên mốc này do **chính lượt đọc** ghi, ngay sau khi GitHub thật sự trả về dữ liệu. Không phân
 * tích chuỗi `detail` (một nguồn thứ hai sẽ lặng lẽ trôi khỏi nguồn thứ nhất), không suy từ
 * `status`. Không có mốc ⇒ CHƯA ĐỌC LẦN NÀO, và đó là một câu trả lời thật.
 */

export type GithubReadKind = "deployments" | "pulls";

const KEY: Record<GithubReadKind, string> = {
  deployments: "github:last-read:deployments",
  pulls: "github:last-read:pulls",
};

/** Ghi mốc. CHỈ gọi sau khi GitHub đã trả về dữ liệu — không gọi ở nhánh bỏ qua. */
export async function markGithubRead(kind: GithubReadKind, at: Date = new Date()) {
  const db = await getDb();
  const value = { at: at.toISOString() };
  await db
    .insert(schema.syncState)
    .values({ key: KEY[kind], value })
    .onConflictDoUpdate({ target: schema.syncState.key, set: { value, updatedAt: new Date() } });
}

/** `null` = chưa lượt đọc nào thành công. KHÔNG phải "vừa đọc xong". */
export async function lastGithubRead(kind: GithubReadKind): Promise<Date | null> {
  const db = await getDb();
  const row = await db.query.syncState.findFirst({ where: eq(schema.syncState.key, KEY[kind]) });
  const raw = (row?.value as { at?: unknown } | undefined)?.at;
  if (typeof raw !== "string") return null;
  const d = new Date(raw);
  return Number.isFinite(d.getTime()) ? d : null;
}
