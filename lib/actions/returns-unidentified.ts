"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { Actor } from "@/lib/constants/actor";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { ITEM_CONDITIONS } from "@/lib/constants/return-lifecycle";
import { RESTOCK_UNIDENTIFIED_PERMISSION, UNIDENTIFIED_SOURCES } from "@/lib/constants/return-unidentified";
import { searchReturnCandidates, type CandidateSearch } from "@/lib/returns/candidate-match";
import { scanReceiveReturn, type ScanReceiveResult } from "@/lib/returns/receive-scan";
import {
  createUnidentifiedReturn,
  findUnidentifiedById,
  identifyUnidentifiedReturn,
  markUnidentifiable,
  restockUnidentifiedReturn,
  searchVariants,
  setUnidentifiedCondition,
  type UnidentifiedRow,
  type VariantOption,
} from "@/lib/returns/unidentified";

/**
 * ═══════════ HÀNG HOÀN MẤT NHÃN — ĐƯỜNG GHI TỪ MÀN HÌNH KHO ═══════════
 *
 * Mọi hành động ở đây theo đúng khuôn của kho mã: `requireUser` → `can` → zod → dịch vụ →
 * `audit()` → `revalidatePath`. Lỗi nghiệp vụ trả `{ error }`, không throw.
 *
 * HAI MỨC QUYỀN, và ranh giới giữa chúng là toàn bộ lý do tệp này tồn tại:
 *
 *  · `inventory:write` — nhận kiện, đếm, tra đơn, nối đơn, và tái nhập món ĐÃ nối được đơn.
 *  · `inventory:restock-unidentified` — tái nhập món KHÔNG lần ra được đơn nào.
 *
 * Mức hai cao hơn vì nó là lượt cộng tồn duy nhất trong cả ERP không đứng trên một chứng từ đối
 * chiếu được. Nó bắt buộc có lý do, và nó để lại dấu trên chính dòng dữ liệu
 * (`restock_authority = 'MANAGER_OVERRIDE'`) chứ không chỉ trong nhật ký.
 *
 * TÊN NGƯỜI THAO TÁC DO MÁY CHỦ ĐỌC, KHÔNG NHẬN TỪ TRÌNH DUYỆT (luật 34).
 */

function khoActor(user: { id: string; email: string; name: string }): Actor {
  return { id: user.id, label: user.name || user.email };
}

function revalidate() {
  for (const path of ["/inventory", "/inventory/returns", "/products", "/inventory/planning", "/data-quality"]) revalidatePath(path);
}

// ───────────────────────── BẮN MÃ NHẬN KIỆN ─────────────────────────

const scanSchema = z.object({
  code: z.string().trim().min(1, "Chưa có mã nào").max(120),
  /** Lượt bấm THỨ HAI cho kiện mà ĐVVC không báo là đang hoàn. Mặc định tắt. */
  confirmUnexpected: z.boolean().default(false),
});

export type ScanReceiveActionResult = ScanReceiveResult | { error: string };

/**
 * BẮN MÃ → GHI NHẬN KIỆN ĐÃ VỀ KHO. KHÔNG cộng tồn.
 *
 * Idempotent ở tầng CSDL (`return_inspections.shipment_id` UNIQUE): bắn hai lần, hai tab, hay một
 * lượt thử lại của mạng đều ra đúng một phiếu — và lượt sau trả `ALREADY` kèm "ai nhận, lúc nào".
 *
 * Nhật ký CHỈ ghi cho lượt thật sự đổi dữ liệu. Ghi cả lượt tra cứu thì mỗi ca kho để lại vài
 * nghìn dòng nhật ký không nói lên điều gì, và `audit()` xoá đệm báo cáo sau mỗi lượt ghi — bắn
 * 300 mã là 300 lần tính nguội toàn bộ báo cáo.
 */
export async function scanReceiveReturnAction(input: unknown): Promise<ScanReceiveActionResult> {
  const user = await requireUser();
  if (!can(user, "inventory:write")) return { error: "Bạn không có quyền cập nhật kho" };
  const parsed = scanSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };

  const r = await scanReceiveReturn({ code: parsed.data.code, actor: khoActor(user), confirmUnexpected: parsed.data.confirmUnexpected });
  if (r.outcome !== "RECEIVED") return r;

  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "return.received.scan",
    entity: "shipments",
    entityId: r.parcel.shipmentId,
    reason: "Bắn mã vận đơn tại bàn nhận hàng hoàn",
    detail: { code: r.parcel.code ?? "", stage: r.parcel.stage, confirmUnexpected: parsed.data.confirmUnexpected },
  });
  revalidate();
  return r;
}

// ───────────────────────── TRA ỨNG VIÊN ─────────────────────────

const candidateSchema = z.object({
  tracking: z.string().trim().max(120).default(""),
  orderCode: z.string().trim().max(60).default(""),
  phone: z.string().trim().max(40).default(""),
  customerName: z.string().trim().max(120).default(""),
  sku: z.string().trim().max(120).default(""),
  color: z.string().trim().max(80).default(""),
  size: z.string().trim().max(40).default(""),
});

/** CHỈ ĐỌC. Trả về ứng viên đã xếp hạng kèm bằng chứng — không nối gì, không ghi gì. */
export async function searchReturnCandidatesAction(input: unknown): Promise<CandidateSearch> {
  const user = await requireUser();
  if (!can(user, "inventory:write")) return { error: "Bạn không có quyền cập nhật kho" };
  const parsed = candidateSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  return searchReturnCandidates(parsed.data);
}

// ───────────────────────── TẠO KIỆN CHƯA XÁC ĐỊNH ─────────────────────────

const createSchema = z.object({
  source: z.enum(UNIDENTIFIED_SOURCES),
  variantId: z.string().trim().max(100).nullable().default(null),
  quantity: z.coerce.number().int().min(1, "Số lượng phải lớn hơn 0").max(10_000),
  condition: z.enum(ITEM_CONDITIONS),
  note: z.string().trim().max(1000).default(""),
  warehouseNote: z.string().trim().max(500).default(""),
  /** Nối luôn với vận đơn vừa tra ra được (nếu người kho đã chọn). */
  linkShipmentId: z.string().trim().max(100).nullable().default(null),
});

export type UnidentifiedActionResult = { ok: true; row: UnidentifiedRow; message: string } | { error: string };

/**
 * GHI NHẬN MỘT KIỆN HOÀN KHÔNG CÓ MÃ VẬN ĐƠN — MỘT DÒNG DUY NHẤT cho một món hàng vật lý.
 *
 * `linkShipmentId` cho phép tạo-và-nối trong một lượt bấm (ca thường: tra ra đơn ngay tại bàn).
 * Vẫn là MỘT dòng: nối là gắn thêm quy kết vào chính món vừa ghi, KHÔNG sinh một món thứ hai.
 * Sinh hai dòng cho một chiếc áo là cách chắc chắn nhất để một ngày nào đó nó vào tồn hai lần.
 *
 * Nối hỏng (vận đơn đã đếm, đã có kiện khác nối vào) thì KIỆN VẪN ĐƯỢC GIỮ, chỉ phần quy kết là
 * chưa có — hàng đã nằm trên bàn rồi, vứt bản ghi đi vì không tra ra đơn là quay lại đúng chỗ cũ.
 */
export async function createUnidentifiedReturnAction(input: unknown): Promise<UnidentifiedActionResult> {
  const user = await requireUser();
  if (!can(user, "inventory:write")) return { error: "Bạn không có quyền cập nhật kho" };
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const { linkShipmentId, ...rest } = parsed.data;

  const created = await createUnidentifiedReturn({ ...rest, actor: khoActor(user) });
  if ("error" in created) return { error: created.error };

  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "return.unidentified.created",
    entity: "return_unidentified",
    entityId: created.row.id,
    reason: "Kiện hàng hoàn về kho không có mã vận đơn",
    after: { code: created.row.code, sku: created.row.sku, quantity: created.row.quantity, condition: created.row.condition, source: created.row.source },
  });

  if (!linkShipmentId) {
    revalidate();
    return { ok: true, row: created.row, message: `Đã tạo ${created.row.code}. Hàng đang GIỮ TẠM — chưa vào tồn bán được.` };
  }

  const linked = await identifyUnidentifiedReturn({ id: created.row.id, shipmentId: linkShipmentId, actor: khoActor(user) });
  revalidate();
  if ("error" in linked) {
    return { ok: true, row: created.row, message: `Đã tạo ${created.row.code}, nhưng CHƯA nối được đơn: ${linked.error}` };
  }
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "return.unidentified.identified",
    entity: "return_unidentified",
    entityId: created.row.id,
    reason: "Người kho đối chiếu và chọn khi tạo",
    after: { shipmentId: linkShipmentId, tracking: linked.row.linkedTrackingNumber, orderId: linked.row.linkedOrderId },
  });
  return { ok: true, row: linked.row, message: `Đã tạo ${created.row.code} và nối với vận đơn ${linked.code}. Hàng vẫn GIỮ TẠM — bấm “Tái nhập” để vào tồn.` };
}

// ───────────────────────── NỐI ĐƠN / KẾT LUẬN KHÔNG XÁC ĐỊNH ĐƯỢC ─────────────────────────

const identifySchema = z.object({ id: z.string().trim().min(1).max(100), shipmentId: z.string().trim().min(1).max(100) });

/** NỐI một kiện đã có sẵn với vận đơn người kho chọn. KHÔNG tạo món mới, KHÔNG cộng tồn. */
export async function identifyUnidentifiedReturnAction(input: unknown): Promise<UnidentifiedActionResult> {
  const user = await requireUser();
  if (!can(user, "inventory:write")) return { error: "Bạn không có quyền cập nhật kho" };
  const parsed = identifySchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };

  const r = await identifyUnidentifiedReturn({ ...parsed.data, actor: khoActor(user) });
  if ("error" in r) return { error: r.error };

  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "return.unidentified.identified",
    entity: "return_unidentified",
    entityId: parsed.data.id,
    reason: "Người kho đối chiếu và chọn",
    after: { shipmentId: parsed.data.shipmentId, tracking: r.row.linkedTrackingNumber, orderId: r.row.linkedOrderId },
  });
  revalidate();
  return { ok: true, row: r.row, message: `${r.row.code} đã nối với vận đơn ${r.code}. Hàng vẫn GIỮ TẠM — bấm “Tái nhập” để vào tồn.` };
}

const unidentifiableSchema = z.object({ id: z.string().trim().min(1).max(100), reason: z.string().trim().min(1, "Phải ghi rõ đã tra những gì").max(1000) });

export async function markUnidentifiableAction(input: unknown): Promise<UnidentifiedActionResult> {
  const user = await requireUser();
  if (!can(user, "inventory:write")) return { error: "Bạn không có quyền cập nhật kho" };
  const parsed = unidentifiableSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };

  const r = await markUnidentifiable({ ...parsed.data, actor: khoActor(user) });
  if ("error" in r) return { error: r.error };

  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "return.unidentified.unidentifiable",
    entity: "return_unidentified",
    entityId: parsed.data.id,
    reason: parsed.data.reason,
  });
  revalidate();
  return { ok: true, row: r.row, message: `${r.row.code}: đã ghi là không lần ra được đơn. Muốn đưa vào tồn thì cần quản lý kho quyết.` };
}

// ───────────────────────── ĐỔI KẾT LUẬN KIỂM HÀNG ─────────────────────────

const conditionSchema = z.object({
  id: z.string().trim().min(1).max(100),
  condition: z.enum(ITEM_CONDITIONS),
  note: z.string().trim().max(1000).default(""),
  variantId: z.string().trim().max(100).nullable().default(null),
});

/** Đổi kết luận / gắn mẫu mã cho một kiện CHƯA vào tồn (ví dụ giặt xong thì từ “Bẩn” sang “Đủ”). */
export async function setUnidentifiedConditionAction(input: unknown): Promise<UnidentifiedActionResult> {
  const user = await requireUser();
  if (!can(user, "inventory:write")) return { error: "Bạn không có quyền cập nhật kho" };
  const parsed = conditionSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };

  const r = await setUnidentifiedCondition({ ...parsed.data, actor: khoActor(user) });
  if ("error" in r) return { error: r.error };

  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "return.unidentified.condition",
    entity: "return_unidentified",
    entityId: parsed.data.id,
    after: { condition: parsed.data.condition, variantId: parsed.data.variantId ?? "", note: parsed.data.note },
  });
  revalidate();
  return { ok: true, row: r.row, message: `${r.row.code}: đã cập nhật kết luận kiểm hàng.` };
}

// ───────────────────────── TÁI NHẬP ─────────────────────────

const restockSchema = z.object({ id: z.string().trim().min(1).max(100), reason: z.string().trim().max(1000).default("") });

export type RestockActionResult = { ok: true; row: UnidentifiedRow; restocked: number; already: boolean; message: string } | { error: string };

/**
 * ĐƯA MỘT MÓN GIỮ TẠM VÀO TỒN BÁN ĐƯỢC — chỗ DUY NHẤT làm việc đó cho hàng mất nhãn.
 *
 * QUYỀN ĐƯỢC KIỂM TRƯỚC KHI CHẠM DỮ LIỆU, và mức quyền phụ thuộc vào TRẠNG THÁI của chính dòng đó:
 *
 *  · đã nối được vận đơn ⇒ đây là hàng hoàn bình thường, `inventory:write` đủ;
 *  · chưa nối được ⇒ lượt cộng tồn không có chứng từ nào, cần `inventory:restock-unidentified`
 *    VÀ một lý do viết ra được.
 *
 * Đọc trạng thái trước ở đây thay vì để dịch vụ tự quyết, vì chỉ tầng này mới có `user`. Dịch vụ
 * vẫn tự tính lại căn cứ và ràng buộc CSDL khoá lần nữa — ba lớp, vì đây đúng là chỗ một lượt cộng
 * tồn không chứng từ có thể đội lốt một lượt có chứng từ.
 *
 * Gọi lại lần hai KHÔNG cộng thêm và KHÔNG báo lỗi: nó trả `already` và nói phiếu cũ.
 */
export async function restockUnidentifiedReturnAction(input: unknown): Promise<RestockActionResult> {
  const user = await requireUser();
  if (!can(user, "inventory:write")) return { error: "Bạn không có quyền cập nhật kho" };
  const parsed = restockSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };

  const row = await findUnidentifiedById(parsed.data.id);
  if (!row) return { error: "Không thấy kiện hàng hoàn chưa xác định này" };

  const canOverride = can(user, RESTOCK_UNIDENTIFIED_PERMISSION);
  if (row.status !== "IDENTIFIED" && !canOverride) {
    return {
      error:
        "Kiện này chưa lần ra được đơn nào, nên đưa nó vào tồn là một quyết định không có chứng từ đối chiếu — cần quyền “Tái nhập hàng hoàn không xác định nguồn” (quản lý kho / quản trị). Nhờ người có quyền bấm, hoặc tra thêm để nối được đơn trước.",
    };
  }
  if (row.status !== "IDENTIFIED" && !parsed.data.reason.trim()) {
    return { error: "Tái nhập hàng không lần ra được đơn thì bắt buộc ghi lý do (ví dụ: mất nhãn vận đơn, hàng còn nguyên tem)." };
  }

  const r = await restockUnidentifiedReturn({ ...parsed.data, actor: khoActor(user) });
  if ("error" in r) return { error: r.error };

  if (r.already) {
    return { ok: true, row: r.row, restocked: 0, already: true, message: `${r.row.code} đã vào tồn từ trước (phiếu ${r.receiptId}) — không cộng thêm.` };
  }

  await audit({
    userId: user.id,
    userEmail: user.email,
    action: r.row.restockAuthority === "MANAGER_OVERRIDE" ? "return.unidentified.restock.override" : "return.unidentified.restock",
    entity: "return_unidentified",
    entityId: r.row.id,
    reason: parsed.data.reason || "Tái nhập sau khi xác định được đơn",
    after: { receiptId: r.receiptId, variantId: r.row.variantId ?? "", sku: r.row.sku, quantity: r.restocked, authority: r.row.restockAuthority },
  });
  revalidate();

  const canhBao = r.row.restockAuthority === "MANAGER_OVERRIDE" ? " · KHÔNG có chứng từ đơn, đã ghi nhật ký" : "";
  return { ok: true, row: r.row, restocked: r.restocked, already: false, message: `${r.row.code}: +${r.restocked} ${r.row.sku || "món"} vào tồn bán được${canhBao}.` };
}

// ───────────────────────── TRA MẪU MÃ ─────────────────────────

/**
 * CHỈ ĐỌC. Tra mẫu mã theo từ khoá để người kho chọn đúng cái áo đang cầm.
 *
 * Tra theo từ khoá thay vì tải cả danh mục: bàn nhận hàng hoàn mở suốt ca, và kéo vài nghìn mẫu mã
 * vào HTML mỗi lượt tải trang là trả tiền cho một danh sách mà người kho chỉ gõ hai chữ là xong.
 */
export async function searchVariantsAction(term: unknown): Promise<VariantOption[]> {
  const user = await requireUser();
  if (!can(user, "inventory:write")) return [];
  const q = z.string().trim().max(120).safeParse(term);
  if (!q.success) return [];
  return searchVariants(q.data);
}
