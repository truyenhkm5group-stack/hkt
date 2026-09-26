import { eq, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import type { ApprovalDecision, ApprovalGroup } from "@/lib/constants/approval";
import type { CostBasis } from "@/lib/constants/inspection-truth";
import { checkUnidentifiedRestock, type RestockAuthority } from "@/lib/constants/return-unidentified";
import {
  checkDispositionRequest,
  DISPOSITION_LABEL,
  isReturnDisposition,
  parseSubjectKey,
  type ReturnDisposition,
} from "@/lib/constants/return-disposition";
import { emitDomainEvent } from "@/lib/events/emit";
import { foldOf, loadEntries, loadSubjectByKey, pickUnitCost, type DispositionSubject } from "@/lib/queries/return-dispositions";
import { LAST_RECEIPT_COST_BY_VARIANT } from "@/lib/queries/cost-basis";
import { createRestockReceipt } from "@/lib/returns/inspection";
import { returnProductContext } from "@/lib/returns/product-context";
import { writeUnidentifiedRestockReceipt } from "@/lib/returns/unidentified";
import { rowsOf } from "@/lib/sql-rows";

/**
 * ═══════════ GHI KẾT CỤC CHO HÀNG HOÀN KHÔNG TÁI NHẬP — LÕI DỊCH VỤ (Company OS · Agent E) ═══════════
 *
 * Tệp này KHÔNG "use server": server action `lib/actions/return-dispositions.ts` gọi nó sau
 * `requireUser` / `can`, và kiểm thử gọi thẳng với một cổng duyệt giả lập đúng luật cổng thật.
 * Luật: `lib/constants/return-disposition.ts`.
 *
 * MỘT GIAO DỊCH, CÓ KHOÁ: khoá dòng phiếu kiểm (mọi đối tượng của một kiện xếp hàng sau nhau) →
 * gập lại sổ BÊN TRONG khoá → phiếu tái nhập (chỉ `RESTOCK_AFTER_REWORK`, qua `createRestockReceipt`
 * của trạm kiểm — không có đường lập phiếu thứ hai) → một dòng sổ → `return.disposition_set`.
 * Hai người bấm cùng lúc: người sau chờ khoá, gập lại sổ đã có dòng của người trước, và bị từ chối
 * nếu phần còn mở không đủ. Gửi lại cùng `requestKey` ⇒ trả lại dòng đã ghi, không ghi lần hai.
 *
 * APPEND-ONLY: tệp này chỉ INSERT vào `return_dispositions`.
 *
 * ─── HÀNG HOÀN KHÔNG NHÃN (Company OS · Agent R, 0142) ───
 *
 * Cùng máy trạng thái, cùng sổ theo số lượng, cùng cổng huỷ. Ba chỗ khác, và cả ba là "đi đúng đường
 * của bàn không nhãn", không phải luật mới:
 *  · KHOÁ dòng `return_unidentified` (không có phiếu kiểm) và ĐỌC LẠI đối tượng bên trong khoá — bàn
 *    không nhãn khoá cùng dòng ấy trước khi đổi kết luận, nên hai bên xếp hàng.
 *  · Nhập lại sau sửa hỏi `checkUnidentifiedRestock` — CÙNG hàm với nút tái nhập của bàn không nhãn:
 *    chưa nối được đơn ⇒ cần `inventory:restock-unidentified` (`canRestockUnidentified`) VÀ lý do (ô ghi
 *    chú). Căn cứ ghi vào `restock_authority` của dòng sổ.
 *  · Phiếu lập bằng `writeUnidentifiedRestockReceipt` — đường lập phiếu DUY NHẤT của bàn không nhãn.
 * Sự kiện `return.disposition_set` giữ subject `return_inspection` (sổ sự kiện khai một loại chủ thể);
 * `subject_id` = khoá `unidentified:<id>` để không ai nhầm nó với id phiếu kiểm. `model_id` chỉ khi món
 * có mẫu mã KHO NHẬN DIỆN (`variant_id`); chưa nhận diện ⇒ `null` — không đoán (luật 35).
 */

type DbLike = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Cùng hình với `GuardInput` của lib/actions/approvals.ts — action truyền `guardSecondApproval`. */
export type DispositionGateInput = {
  group: ApprovalGroup;
  action: string;
  summary: string;
  entity?: string;
  entityId?: string;
  amount?: number | null;
  payload?: unknown;
};
export type DispositionGate = (input: DispositionGateInput) => Promise<ApprovalDecision>;

/** Nhóm duyệt của huỷ bỏ — nhóm CÓ SẴN, ngưỡng có sẵn (`APPROVAL_THRESHOLD`). Không thêm ngưỡng mới. */
export const WRITE_OFF_APPROVAL_GROUP: ApprovalGroup = "INVENTORY_WRITE_OFF";
export const DISPOSITION_EVENT_SOURCE = "ui:/inventory/returns";

export type SetDispositionInput = {
  subjectKey: string;
  disposition: ReturnDisposition;
  /** Số món ĐẾM ĐƯỢC cho kết cục cuối. Trạng thái (chưa quyết / đang sửa) luôn áp cho toàn bộ phần còn mở. */
  qty: number | null;
  note: string;
  /** Chỉ với đối tượng CẢ KIỆN: mẫu mã người kho chọn trong danh sách hàng kỳ vọng của kiện. */
  variantId?: string | null;
  /** Khoá chống bấm đúp — trình duyệt sinh một lần cho mỗi lượt mở hộp thoại. */
  requestKey?: string | null;
  /**
   * Người làm có quyền `inventory:restock-unidentified` (action đọc từ phiên). Chỉ dùng cho nhập lại sau
   * sửa của món KHÔNG NHÃN chưa nối được đơn. Mặc định `false` — thiếu thông tin thì rơi về phía HẸP.
   */
  canRestockUnidentified?: boolean;
  /** Người làm — `id` BẮT BUỘC (luật 34: không có "máy tự huỷ hàng"). Tên do máy chủ đọc. */
  actor: { id: string; label: string };
  gate: DispositionGate;
};

export type SetDispositionResult =
  | {
      ok: true;
      dispositionId: string;
      receiptId: string | null;
      eventId: string | null;
      replayed: boolean;
      valueEstimate: number | null;
      /** Chỉ với nhập lại sau sửa của món KHÔNG NHÃN: căn cứ ghi trên dòng sổ. */
      restockAuthority: RestockAuthority | null;
    }
  | { error: string; approval?: ApprovalDecision["mode"] };

/** Đơn giá vốn ƯỚC TÍNH của một mẫu mã trên một đơn — CÙNG bậc thang với hàng đợi (`pickUnitCost`). */
export async function unitCostEstimate(db: DbLike, variantId: string, orderId: string | null): Promise<{ unitCost: number | null; basis: CostBasis }> {
  const [r] = rowsOf<{ receipt_cost: number | null; order_cost: number | null; variant_cost: number | null }>(
    await db.execute(sql`
      with gia as ${LAST_RECEIPT_COST_BY_VARIANT}
      select (select gia.unit_cost from gia where gia.variant_id = pv.id) as receipt_cost,
             (select nullif(max(oi.unit_cost), 0) from order_items oi where oi.order_id = ${orderId} and oi.variant_id = pv.id) as order_cost,
             nullif(pv.last_imported_price, 0) as variant_cost
      from product_variants pv where pv.id = ${variantId}
    `),
  );
  return r ? pickUnitCost(r) : { unitCost: null, basis: "UNKNOWN" };
}

/**
 * Mẫu mã dòng sổ nói tới. Dòng từng món: mẫu THỰC NHẬN (không đổi được). Cả kiện: mẫu người chọn,
 * PHẢI nằm trong danh sách hàng kỳ vọng của kiện; kiện đúng một mẫu mã thì lấy luôn mẫu ấy.
 */
async function resolveVariant(subject: DispositionSubject, requested: string | null | undefined): Promise<{ variantId: string | null } | { error: string }> {
  if (subject.grain === "ITEM") {
    if (requested && requested !== subject.variantId) return { error: "Món kiểm từng món đã có mẫu mã thực nhận — không đổi mẫu mã ở bước này." };
    return { variantId: subject.variantId };
  }
  // Món không nhãn: mẫu mã là thứ KHO nhận diện ở bàn không nhãn — không chọn / đổi ở bước này.
  if (subject.grain === "UNIDENTIFIED") {
    if (requested && requested !== subject.variantId) return { error: "Món không nhãn lấy mẫu mã kho đã nhận diện ở bàn “Hàng hoàn không có mã vận đơn” — không chọn mẫu mã ở bước này." };
    return { variantId: subject.variantId };
  }
  if (!subject.shipmentId) return { variantId: null };
  const ctx = (await returnProductContext([subject.shipmentId])).get(subject.shipmentId);
  const expected = [...new Set((ctx && ctx.basis !== "UNRESOLVED" && ctx.basis !== "AMBIGUOUS" ? ctx.items : []).map((i) => i.variantId).filter((v): v is string => Boolean(v)))];
  if (requested) {
    if (!expected.includes(requested)) return { error: "Mẫu mã đã chọn không nằm trong hàng kỳ vọng của kiện này." };
    return { variantId: requested };
  }
  return { variantId: expected.length === 1 ? expected[0] : null };
}

async function modelIdOfVariant(db: DbLike, variantId: string | null): Promise<string | null> {
  if (!variantId) return null;
  const [r] = rowsOf<{ id: string }>(
    await db.execute(sql`select pm.id from product_models pm join product_variants pv on pv.product_id = pm.product_id where pv.id = ${variantId} limit 1`),
  );
  return r?.id ?? null;
}

async function replayOf(db: DbLike, requestKey: string | null | undefined) {
  if (!requestKey) return null;
  const [r] = await db.select().from(schema.returnDispositions).where(eq(schema.returnDispositions.requestKey, requestKey)).limit(1);
  return r ?? null;
}

class Refused extends Error {}

function authorityOf(v: string | null): RestockAuthority | null {
  return v === "IDENTIFIED" || v === "MANAGER_OVERRIDE" ? v : null;
}

export async function setReturnDispositionCore(db: Db, input: SetDispositionInput): Promise<SetDispositionResult> {
  if (!input.actor?.id) return { error: "Thiếu tài khoản người làm — kết cục hàng hoàn phải có người chịu trách nhiệm (luật 34)." };
  if (!isReturnDisposition(input.disposition)) return { error: `Kết cục không hợp lệ: ${String(input.disposition)}` };
  if (!parseSubjectKey(input.subjectKey)) return { error: "Mã món hàng không hợp lệ" };
  const requestKey = input.requestKey?.trim() || null;

  const daGhi = await replayOf(db, requestKey);
  if (daGhi) {
    if (daGhi.subjectKey !== input.subjectKey || daGhi.disposition !== input.disposition) return { error: "Khoá yêu cầu đã dùng cho một thao tác khác — tải lại trang." };
    return { ok: true, dispositionId: daGhi.id, receiptId: daGhi.stockReceiptId, eventId: null, replayed: true, valueEstimate: daGhi.valueEstimate, restockAuthority: authorityOf(daGhi.restockAuthority) };
  }

  // ── Kiểm trước khi hỏi cổng duyệt: không gửi yêu cầu duyệt cho một thao tác đằng nào cũng hỏng ──
  const subject = await loadSubjectByKey(db, input.subjectKey);
  if (!subject) return { error: "Món này không phải hàng hoàn đã kiểm mà chưa tái nhập (có thể kết luận là “Đủ” hoặc chưa kiểm)." };
  const lich = (await loadEntries(db, [subject.subjectKey])).get(subject.subjectKey) ?? [];
  const kiem = checkDispositionRequest(foldOf(subject, lich), { disposition: input.disposition, qty: input.qty, note: input.note });
  if ("error" in kiem) return kiem;

  const bien = await resolveVariant(subject, input.variantId ?? null);
  if ("error" in bien) return bien;
  const variantId = bien.variantId;
  if (input.disposition === "RESTOCK_AFTER_REWORK" && !variantId) {
    return {
      error:
        subject.grain === "PARCEL"
          ? "Kiện này kiểm cả kiện và có nhiều mẫu mã (hoặc chưa ghép được đơn) — chọn đúng mẫu mã của món đã sửa xong."
          : subject.grain === "UNIDENTIFIED"
            ? `${subject.code ?? "Món không nhãn"} chưa nhận diện được mẫu mã — không biết cộng vào đâu. Bấm “Xác định mẫu mã” (trên dòng này hoặc ở bàn “Hàng hoàn không có mã vận đơn”) trước.`
            : "Món này chưa ghép được mẫu mã ERP nên không biết cộng vào đâu — đồng bộ sản phẩm rồi làm lại.",
    };
  }
  // Món KHÔNG NHÃN nhập lại tồn: CÙNG luật quyền + lý do với nút tái nhập của bàn không nhãn (kiểm lại trong khoá).
  if (input.disposition === "RESTOCK_AFTER_REWORK" && subject.grain === "UNIDENTIFIED") {
    const luat = checkUnidentifiedRestock({ status: subject.unidentifiedStatus ?? "", reason: input.note, canOverride: input.canRestockUnidentified === true });
    if ("error" in luat) return { error: luat.error };
  }
  if (subject.grain !== "UNIDENTIFIED" && (!subject.inspectionId || !subject.shipmentId)) return { error: "Món này thiếu phiếu kiểm / vận đơn — tải lại trang." };
  const kienShipment = subject.shipmentId ?? "";

  // ── Giá trị ƯỚC TÍNH của huỷ bỏ (chụp lại lúc huỷ) ──
  let cost: { unitCost: number | null; basis: CostBasis } | null = null;
  if (input.disposition === "WRITE_OFF") {
    cost = variantId ? (subject.variantId === variantId ? { unitCost: subject.unitCost, basis: subject.costBasis } : await unitCostEstimate(db, variantId, subject.orderId)) : { unitCost: null, basis: "UNKNOWN" };
    const giaTri = cost.unitCost === null ? null : cost.unitCost * kiem.qty;
    const cong = await input.gate({
      group: WRITE_OFF_APPROVAL_GROUP,
      action: "return.disposition_write_off",
      entity: "RETURN_DISPOSITION",
      entityId: subject.subjectKey,
      summary: `Huỷ ${kiem.qty} món hàng hoàn ${subject.sku || subject.productName || subject.subjectKey}${subject.code ? ` · kiện ${subject.code}` : ""} — ${input.note.trim()}`,
      // CHƯA BIẾT giá vốn ⇒ `null` ⇒ cổng coi như VƯỢT ngưỡng (lib/constants/approval.ts::overThreshold).
      amount: giaTri,
      payload: { subjectKey: subject.subjectKey, qty: kiem.qty, variantId, note: input.note.trim(), valueEstimate: giaTri, costBasis: cost.basis },
    });
    if (cong.mode === "NEEDS_APPROVAL") return { error: `Huỷ hàng cần người thứ hai duyệt (${cong.reason}). Đã gửi yêu cầu — xem ở trang Cảnh báo.`, approval: cong.mode };
    if (cong.mode === "BLOCKED_NO_APPROVER") return { error: `Huỷ hàng cần người thứ hai duyệt (${cong.reason}), nhưng hệ thống chưa có ai khác đủ tư cách duyệt.`, approval: cong.mode };
  }
  // Món không nhãn: mẫu mã là mẫu KHO NHẬN DIỆN (không phải mẫu đoán) — không có thì `null`, không đoán mẫu.
  const modelId = await modelIdOfVariant(db, variantId);

  try {
    return await db.transaction(async (tx) => {
      // Khoá: phiếu kiểm (mọi quyết định trên cùng một kiện đi lần lượt), hoặc dòng món không nhãn.
      let authority: RestockAuthority | null = null;
      if (subject.grain === "UNIDENTIFIED") {
        await tx.select({ id: schema.returnUnidentified.id }).from(schema.returnUnidentified).where(eq(schema.returnUnidentified.id, subject.unidentifiedId ?? "")).for("update");
        // Đọc lại TRONG khoá: bàn không nhãn có thể vừa đổi kết luận sang "Đủ" / tái nhập nguyên món.
        const lai = await loadSubjectByKey(tx, subject.subjectKey);
        if (!lai || lai.variantId !== variantId) throw new Refused("Món vừa được đổi ở bàn hàng không nhãn (kết luận / mẫu mã / đã vào tồn) — tải lại trang.");
        if (input.disposition === "RESTOCK_AFTER_REWORK") {
          const luat = checkUnidentifiedRestock({ status: lai.unidentifiedStatus ?? "", reason: input.note, canOverride: input.canRestockUnidentified === true });
          if ("error" in luat) throw new Refused(luat.error);
          authority = luat.authority;
        }
      } else {
        await tx.select({ id: schema.returnInspections.id }).from(schema.returnInspections).where(eq(schema.returnInspections.id, subject.inspectionId ?? "")).for("update");
      }

      const lap = await replayOf(tx, requestKey);
      if (lap) return { ok: true as const, dispositionId: lap.id, receiptId: lap.stockReceiptId, eventId: null, replayed: true, valueEstimate: lap.valueEstimate, restockAuthority: authorityOf(lap.restockAuthority) };

      // Gập lại BÊN TRONG khoá — người bấm trước có thể vừa tiêu hết phần còn mở.
      const lichMoi = (await loadEntries(tx, [subject.subjectKey])).get(subject.subjectKey) ?? [];
      const kiemLai = checkDispositionRequest(foldOf(subject, lichMoi), { disposition: input.disposition, qty: input.qty, note: input.note });
      if ("error" in kiemLai) throw new Refused(kiemLai.error);
      const qty = kiemLai.qty;
      const note = input.note.trim();

      // NHẬP LẠI TỒN: đúng đường lập phiếu của NƠI món đi ra (trạm kiểm, hoặc bàn không nhãn), đúng số đếm
      // được, đúng một mẫu mã. Không có đường lập phiếu thứ hai.
      const receiptId =
        subject.grain === "UNIDENTIFIED"
          ? input.disposition === "RESTOCK_AFTER_REWORK" && variantId && authority
            ? await writeUnidentifiedRestockReceipt(tx, {
                row: { code: subject.code ?? subject.subjectKey, variantId, linkedShipmentId: subject.shipmentId },
                qty,
                authority,
                reason: note,
                label: input.actor.label,
                now: new Date(),
                afterRework: true,
              })
            : null
          : input.disposition === "RESTOCK_AFTER_REWORK" && variantId
            ? await createRestockReceipt(tx, variantId, kienShipment, qty, note, { id: input.actor.id, label: input.actor.label }, `Nhập lại sau sửa ${subject.code ?? kienShipment}`)
            : null;

      const valueEstimate = cost && cost.unitCost !== null ? cost.unitCost * qty : null;
      const [row] = await tx
        .insert(schema.returnDispositions)
        .values({
          inspectionId: subject.inspectionId,
          inspectionItemId: subject.itemId,
          unidentifiedId: subject.unidentifiedId,
          restockAuthority: receiptId ? authority : null,
          subjectKey: subject.subjectKey,
          disposition: input.disposition,
          qty,
          variantId,
          stockReceiptId: receiptId,
          unitCostEstimate: cost ? cost.unitCost : null,
          costBasis: cost ? cost.basis : null,
          valueEstimate,
          note,
          actorUserId: input.actor.id,
          actorName: input.actor.label,
          requestKey,
        })
        .returning({ id: schema.returnDispositions.id, createdAt: schema.returnDispositions.createdAt });

      const eventId = await emitDomainEvent(tx, {
        name: "return.disposition_set",
        subjectType: "return_inspection",
        subjectId: subject.inspectionId ?? subject.subjectKey,
        modelId,
        payload: {
          dispositionId: row.id,
          subjectKey: subject.subjectKey,
          grain: subject.grain,
          unidentifiedId: subject.unidentifiedId,
          restockAuthority: receiptId ? authority : null,
          disposition: input.disposition,
          label: DISPOSITION_LABEL[input.disposition],
          qty,
          variantId,
          shipmentId: subject.shipmentId,
          stockReceiptId: receiptId,
          valueEstimate,
          costBasis: cost ? cost.basis : null,
        },
        actorKind: "USER",
        actorId: input.actor.id,
        source: DISPOSITION_EVENT_SOURCE,
        dedupeKey: `return.disposition_set:${row.id}`,
        occurredAt: row.createdAt,
      });

      return { ok: true as const, dispositionId: row.id, receiptId, eventId, replayed: false, valueEstimate, restockAuthority: receiptId ? authority : null };
    });
  } catch (e) {
    if (e instanceof Refused) return { error: e.message };
    throw e;
  }
}
