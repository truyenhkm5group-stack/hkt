import { and, count, eq, inArray, max } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { CREATIVE_RULE_VERSION, GENE_VOCAB_VERSION, MANUAL_SLOT_BASE, SLOT_MODE_PUBLISH_RANK, type CreativeLoopConfig, type Genes, type SlotMode } from "@/lib/constants/creative-loop";
import { shiftDay, vnDay } from "@/lib/constants/marketing-decision-ledger";
import { storeCreativeImage } from "@/lib/creative/images";
import { batchWindow } from "@/lib/creative/schedule";

/**
 * ═══════════ MẪU TỰ LÀM — NGƯỜI TẢI VÀO LÔ ═══════════
 *
 * Chủ shop vẽ mẫu trên web ChatGPT / Grok (gói tháng, không có API cho máy) và muốn mẫu ấy đi qua
 * đúng vòng: duyệt · đăng · chấm · học. Nên mẫu tự làm là một Ô của lô như mọi ô khác, chỉ khác ba
 * điều:
 *
 *  1. **Không qua máy viết, không qua máy sinh ảnh** — vào thẳng trạng thái `GENERATED`.
 *  2. **Được đăng TRƯỚC** ô máy lập (`publishOrder`): người đã cố ý chọn nó, còn ô máy lập là để lấp
 *     chỗ. Trần số mẫu/lô (`CREATIVE_HARD_LIMITS.maxBatchSize`) vẫn giữ nguyên — mẫu tự làm chiếm chỗ của ô máy lập, không cộng thêm.
 *  3. **Lô chưa có thì dựng sẵn** ở trạng thái "Chờ duyệt", đánh dấu `plan.manualSeed`. Tới giờ dựng
 *     lô, máy chỉ lập PHẦN CÒN THIẾU cho đủ lô (`generate.ts`), không đè lên mẫu của người.
 *
 * Người phải khai sáu gen và mã hàng: không có gen thì mẫu không dạy được máy điều gì, và không có mã
 * hàng thì đơn không nối được về sản phẩm.
 */

const OPEN_STATUSES: readonly string[] = ["PLANNED", "PENDING_APPROVAL"];

/**
 * Lô gần nhất CÒN NHẬN MẪU: hôm nay nếu chưa qua hạn duyệt của lô hôm nay VÀ lô hôm nay còn mở (chưa có,
 * đang dựng hoặc đang chờ duyệt), không thì ngày mai. Hàm thuần — không đọc đồng hồ ngoài `now`.
 *
 * `todayStatus` là trạng thái lô HÔM NAY (`null` = chưa có lô). Thiếu vế này thì 02:19 sáng, lô hôm nay đã
 * DUYỆT, nút "Đưa vào lô" vẫn trỏ vào lô hôm nay rồi báo "chỉ thêm được mẫu vào lô đang dựng hoặc đang chờ
 * duyệt" — người bấm không có đường nào đi tiếp (chủ shop gặp 25/09/2026). Lô đã duyệt thì bài mới sang
 * lô ngày mai, không mở lại lô đã duyệt: mở lại là huỷ phiếu duyệt của những bài người đã xem xong.
 */
export function manualTargetDay(now: Date, cfg: Pick<CreativeLoopConfig, "startHourVn" | "testDays" | "approvalLeadMinutes" | "genHourVn">, todayStatus: string | null = null): string {
  const today = vnDay(now);
  const todayOpen = todayStatus === null || OPEN_STATUSES.includes(todayStatus);
  return todayOpen && now < batchWindow(today, cfg).approvalDeadline ? today : shiftDay(today, 1);
}

/** `manualTargetDay` với trạng thái lô hôm nay đọc từ CSDL — đường dùng chung của đường ghi và màn hình. */
export async function resolveManualTargetDay(db: Db, now: Date, cfg: Pick<CreativeLoopConfig, "startHourVn" | "testDays" | "approvalLeadMinutes" | "genHourVn">): Promise<string> {
  const [row] = await db.select({ status: schema.creativeBatches.status }).from(schema.creativeBatches).where(eq(schema.creativeBatches.batchDay, vnDay(now))).limit(1);
  return manualTargetDay(now, cfg, row?.status ?? null);
}

/**
 * Thứ tự ĐĂNG trong một lô (chủ shop 24/09/2026): mẫu tự làm → thiết kế mới → mockup mẫu thắng → thăm
 * dò (`SLOT_MODE_PUBLISH_RANK`), cùng loại thì theo số ô. Hàm thuần.
 * Trần số mẫu cắt ở CUỐI danh sách này — nên nó cắt ô máy lập trước, không bao giờ cắt mẫu của người
 * khi còn chỗ; và cắt mockup trước thiết kế mới (phần chính của lô).
 */
export function publishOrder<T extends { mode: string; slot: number }>(variants: readonly T[]): T[] {
  const rank = (m: string) => SLOT_MODE_PUBLISH_RANK[m as SlotMode] ?? 9;
  return [...variants].sort((a, b) => rank(a.mode) - rank(b.mode) || a.slot - b.slot);
}

/** Lô được dựng sẵn bởi mẫu tự làm và CHƯA được máy lập phần còn lại. */
export function isManualSeed(plan: unknown): boolean {
  const p = (plan ?? {}) as Record<string, unknown>;
  return p.manualSeed === true && !Array.isArray(p.slots);
}

export type ManualVariantInput = { productId: string; genes: Genes; primaryText: string; headline: string; note: string; imageBytes: Uint8Array };

export type ManualActor = { id: string; name: string };

export type AddManualResult = { ok: true; variantId: string; batchId: string; batchDay: string; slot: number; createdBatch: boolean } | { ok: false; error: string };

type BatchRow = typeof schema.creativeBatches.$inferSelect;
type VariantInsert = typeof schema.creativeVariants.$inferInsert;

/**
 * Một mẫu NGƯỜI đưa vào lô — ảnh ĐÃ lưu (`imageId`). Dùng chung cho mẫu tự làm (tải tay) và ảnh gen tay
 * đã duyệt (§5i): cùng lô đích, cùng dải ô 1001+, cùng trần "mẫu tự làm ≤ số mẫu/lô", cùng `mode = MANUAL`.
 * `extra` là các cột riêng của nguồn (câu lệnh · mô hình · chi phí · ảnh sản phẩm gốc · tên đã soạn).
 * `names(batch)` (tuỳ chọn) chạy SAU khi biết lô đích — để số thứ tự trong ngày đăng lấy theo đúng lô ấy.
 */
export type ManualVariantRow = {
  productId: string;
  genes: Genes;
  primaryText: string;
  headline: string;
  why: string;
  imageId: string;
  genModel: string;
  extra?: Partial<Pick<VariantInsert, "imagePrompt" | "genCostUsd" | "productPhotoSourceId" | "inspirationSourceId">>;
  names?: (batch: BatchRow) => Promise<Pick<VariantInsert, "nameSeq" | "campaignName" | "adsetName" | "adName">>;
};

/**
 * ĐƯỜNG GHI CHUNG: lô gần nhất còn hạn duyệt (chưa có thì dựng sẵn "Chờ duyệt") → kiểm lô còn mở + trần
 * mẫu tự làm → cấp ô 1001+ → chèn mẫu `GENERATED`. Trả `{ ok: false, error }` cho lỗi nghiệp vụ — không ném.
 */
export async function insertManualVariant(db: Db, row: ManualVariantRow, cfg: CreativeLoopConfig, actor: ManualActor, now: Date): Promise<AddManualResult> {
  const day = await resolveManualTargetDay(db, now, cfg);
  const w = batchWindow(day, cfg);
  const b = schema.creativeBatches;
  const v = schema.creativeVariants;

  // Lô chưa có thì dựng sẵn. Trùng khoá (máy vừa dựng lô cùng lúc) ⇒ đọc lô đã có, không dựng lại.
  const [inserted] = await db
    .insert(b)
    .values({
      batchDay: day,
      status: "PENDING_APPROVAL",
      slotCount: 0,
      startAt: w.startAt,
      endAt: w.endAt,
      approvalDeadline: w.approvalDeadline,
      plan: { manualSeed: true },
      configSnapshot: cfg as unknown as Record<string, unknown>,
      ruleVersion: CREATIVE_RULE_VERSION,
    })
    .onConflictDoNothing({ target: b.batchDay })
    .returning();
  const batch = inserted ?? (await db.select().from(b).where(eq(b.batchDay, day)).limit(1))[0];
  if (!batch) return { ok: false, error: `Không dựng được lô ${day}.` };
  if (!OPEN_STATUSES.includes(batch.status)) return { ok: false, error: `Lô ${day} đã ở trạng thái "${batch.status}" — chỉ thêm được mẫu vào lô đang dựng hoặc đang chờ duyệt.` };
  if (now >= batch.approvalDeadline) return { ok: false, error: `Lô ${day} đã quá hạn duyệt.` };

  const [c] = await db
    .select({ n: count() })
    .from(v)
    .where(and(eq(v.batchId, batch.id), eq(v.mode, "MANUAL"), inArray(v.status, ["GENERATED", "LIVE", "PAUSED", "ENDED"])));
  if (Number(c?.n ?? 0) >= cfg.batchSize) return { ok: false, error: `Lô ${day} đã có ${c?.n} mẫu tự làm — bằng trần ${cfg.batchSize} mẫu/lô. Gạt bớt một mẫu rồi thêm.` };
  const [top] = await db
    .select({ slot: max(v.slot) })
    .from(v)
    .where(and(eq(v.batchId, batch.id), eq(v.mode, "MANUAL")));
  const slot = Math.max(MANUAL_SLOT_BASE, Number(top?.slot ?? MANUAL_SLOT_BASE)) + 1;
  const names = row.names ? await row.names(batch) : {};

  const mode: SlotMode = "MANUAL";
  const [created] = await db
    .insert(v)
    .values({
      batchId: batch.id,
      slot,
      mode,
      productId: row.productId,
      genes: row.genes as Record<string, string>,
      genesVersion: GENE_VOCAB_VERSION,
      why: row.why,
      primaryText: row.primaryText,
      headline: row.headline,
      imageId: row.imageId,
      genModel: row.genModel,
      ...(row.extra ?? {}),
      ...names,
      status: "GENERATED",
      createdByUserId: actor.id,
      createdByName: actor.name,
    })
    .returning({ id: v.id });
  return { ok: true, variantId: created.id, batchId: batch.id, batchDay: day, slot, createdBatch: Boolean(inserted) };
}

/**
 * ĐƯỜNG GHI DUY NHẤT của mẫu tự làm (tải tay). Server action chỉ kiểm quyền + lược đồ rồi gọi hàm này.
 *
 * Trả `{ ok: false, error }` cho lỗi nghiệp vụ (lô đã duyệt, quá hạn, lô đã đủ mẫu tự làm) — không ném.
 */
export async function addManualVariant(db: Db, input: ManualVariantInput, cfg: CreativeLoopConfig, actor: ManualActor, now: Date): Promise<AddManualResult> {
  // Ảnh hỏng thì dừng TRƯỚC khi dựng lô — không để lại một lô rỗng nằm ở "Chờ duyệt".
  let stored: Awaited<ReturnType<typeof storeCreativeImage>>;
  try {
    stored = await storeCreativeImage(db, input.imageBytes);
  } catch (e) {
    return { ok: false, error: e instanceof Error && e.message ? e.message : "Không lưu được ảnh." };
  }
  return insertManualVariant(
    db,
    {
      productId: input.productId,
      genes: input.genes,
      primaryText: input.primaryText,
      headline: input.headline,
      why: input.note ? `Mẫu tự làm — ${actor.name}: ${input.note}` : `Mẫu tự làm — ${actor.name}`,
      imageId: stored.id,
      genModel: "MANUAL",
    },
    cfg,
    actor,
    now,
  );
}
