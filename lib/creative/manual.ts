import { and, count, eq, inArray, max } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { CREATIVE_RULE_VERSION, GENE_VOCAB_VERSION, MANUAL_SLOT_BASE, type CreativeLoopConfig, type Genes, type SlotMode } from "@/lib/constants/creative-loop";
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
 *     chỗ. Trần 10 mẫu/lô vẫn giữ nguyên — mẫu tự làm chiếm chỗ của ô máy lập, không cộng thêm.
 *  3. **Lô chưa có thì dựng sẵn** ở trạng thái "Chờ duyệt", đánh dấu `plan.manualSeed`. Tới giờ dựng
 *     lô, máy chỉ lập PHẦN CÒN THIẾU cho đủ lô (`generate.ts`), không đè lên mẫu của người.
 *
 * Người phải khai sáu gen và mã hàng: không có gen thì mẫu không dạy được máy điều gì, và không có mã
 * hàng thì đơn không nối được về sản phẩm.
 */

/**
 * Lô gần nhất CÒN HẠN DUYỆT: hôm nay nếu chưa qua hạn duyệt của lô hôm nay, không thì ngày mai.
 * Hàm thuần — không đọc đồng hồ ngoài `now`.
 */
export function manualTargetDay(now: Date, cfg: Pick<CreativeLoopConfig, "startHourVn" | "testDays" | "approvalLeadMinutes" | "genHourVn">): string {
  const today = vnDay(now);
  return now < batchWindow(today, cfg).approvalDeadline ? today : shiftDay(today, 1);
}

/**
 * Thứ tự ĐĂNG trong một lô: mẫu tự làm trước, rồi theo số ô. Hàm thuần.
 * Trần số mẫu cắt ở CUỐI danh sách này — nên nó cắt ô máy lập trước, không bao giờ cắt mẫu của người
 * khi còn chỗ.
 */
export function publishOrder<T extends { mode: string; slot: number }>(variants: readonly T[]): T[] {
  return [...variants].sort((a, b) => Number(b.mode === "MANUAL") - Number(a.mode === "MANUAL") || a.slot - b.slot);
}

/** Lô được dựng sẵn bởi mẫu tự làm và CHƯA được máy lập phần còn lại. */
export function isManualSeed(plan: unknown): boolean {
  const p = (plan ?? {}) as Record<string, unknown>;
  return p.manualSeed === true && !Array.isArray(p.slots);
}

export type ManualVariantInput = { productId: string; genes: Genes; primaryText: string; headline: string; note: string; imageBytes: Uint8Array };

export type ManualActor = { id: string; name: string };

export type AddManualResult = { ok: true; variantId: string; batchId: string; batchDay: string; slot: number; createdBatch: boolean } | { ok: false; error: string };

const OPEN_STATUSES: readonly string[] = ["PLANNED", "PENDING_APPROVAL"];

/**
 * ĐƯỜNG GHI DUY NHẤT của mẫu tự làm. Server action chỉ kiểm quyền + lược đồ rồi gọi hàm này.
 *
 * Trả `{ ok: false, error }` cho lỗi nghiệp vụ (lô đã duyệt, quá hạn, lô đã đủ mẫu tự làm) — không ném.
 */
export async function addManualVariant(db: Db, input: ManualVariantInput, cfg: CreativeLoopConfig, actor: ManualActor, now: Date): Promise<AddManualResult> {
  const day = manualTargetDay(now, cfg);
  const w = batchWindow(day, cfg);
  const b = schema.creativeBatches;
  const v = schema.creativeVariants;

  // Ảnh hỏng thì dừng TRƯỚC khi dựng lô — không để lại một lô rỗng nằm ở "Chờ duyệt".
  let stored: Awaited<ReturnType<typeof storeCreativeImage>>;
  try {
    stored = await storeCreativeImage(db, input.imageBytes);
  } catch (e) {
    return { ok: false, error: e instanceof Error && e.message ? e.message : "Không lưu được ảnh." };
  }

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

  const mode: SlotMode = "MANUAL";
  const [row] = await db
    .insert(v)
    .values({
      batchId: batch.id,
      slot,
      mode,
      productId: input.productId,
      genes: input.genes as Record<string, string>,
      genesVersion: GENE_VOCAB_VERSION,
      why: input.note ? `Mẫu tự làm — ${actor.name}: ${input.note}` : `Mẫu tự làm — ${actor.name}`,
      primaryText: input.primaryText,
      headline: input.headline,
      imageId: stored.id,
      genModel: "MANUAL",
      status: "GENERATED",
      createdByUserId: actor.id,
      createdByName: actor.name,
    })
    .returning({ id: v.id });
  return { ok: true, variantId: row.id, batchId: batch.id, batchDay: day, slot, createdBatch: Boolean(inserted) };
}
