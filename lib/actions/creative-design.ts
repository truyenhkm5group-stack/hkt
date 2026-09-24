"use server";

import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { CREATIVE_CONFIG_KEY } from "@/lib/constants/creative-loop";
import { readCreativeConfig } from "@/lib/queries/creative-sources";
import { setSettingJson } from "@/lib/settings";
import { designProductionSchema, mockupToggleSchema, validateCreativeConfigInput } from "@/lib/validation/creative";

/**
 * ═══════════ VÒNG MẪU — MOCKUP HẰNG NGÀY · THIẾT KẾ ĐƯA VÀO SẢN XUẤT ═══════════
 *
 * Chủ shop 24/09/2026: lô mỗi ngày = 10 thiết kế mới + 1 mockup cho MỖI mẫu thắng chủ shop CHỌN. Công
 * tắc "Chạy mockup hằng ngày" nằm trên thẻ nguồn ở tab Nguồn ảnh; nó sửa đúng HAI danh sách của cấu hình
 * (`mockupSourceIds` · `mockupProductIds`) và đi qua ĐÚNG đường lưu cấu hình hiện có
 * (`validateCreativeConfigInput` → `setSettingJson` → nhật ký). Quyền `ideas:write` (người chọn ảnh
 * nguồn), không phải `settings:manage`: công tắc không đổi tiền một mẫu, trần số mẫu hay luật — nó chỉ
 * chọn MẪU NÀO trong số ô trần đã cho phép, và mọi lô vẫn phải qua một lượt duyệt.
 */

type Result<T = object> = ({ ok: true } & T) | { error: string };

const DUONG = "/marketing/creatives";

/** Bật / tắt "Chạy mockup hằng ngày" cho một quảng cáo cũ (`SOURCE`) hoặc một mã hàng (`PRODUCT`). */
export async function setDailyMockup(input: unknown): Promise<Result<{ on: boolean }>> {
  const user = await requireUser();
  if (!can(user, "ideas:write")) return { error: "Bạn không có quyền chọn mẫu chạy mockup hằng ngày" };
  const parsed = mockupToggleSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const { kind, id, on } = parsed.data;

  const db = await getDb();
  // Kiểm lại ở máy chủ: công tắc nguồn chỉ nhận quảng cáo cũ CỦA SHOP; công tắc mã chỉ nhận mã có ảnh thật.
  if (kind === "SOURCE") {
    const src = await db.query.creativeSources.findFirst({ where: eq(schema.creativeSources.id, id), columns: { id: true, kind: true } });
    if (!src || src.kind !== "OWN_AD") return { error: "Chỉ quảng cáo cũ của shop (nhập từ Facebook) mới chạy mockup theo nguồn được." };
  } else {
    const [photo] = await db
      .select({ id: schema.creativeSources.id })
      .from(schema.creativeSources)
      .where(and(eq(schema.creativeSources.productId, id), inArray(schema.creativeSources.kind, ["PRODUCT_PHOTO"])))
      .limit(1);
    if (!photo) return { error: "Mã này chưa có ảnh sản phẩm thật — máy không làm mockup cho sản phẩm nó không nhìn thấy." };
  }

  const truoc = await readCreativeConfig();
  const key = kind === "SOURCE" ? "mockupSourceIds" : "mockupProductIds";
  const cur = truoc.config[key];
  if (cur.includes(id) === on) return { ok: true, on };
  const next = on ? [...cur, id] : cur.filter((x) => x !== id);
  const v = validateCreativeConfigInput({ ...truoc.config, [key]: next });
  if (!v.ok) return { error: v.error };

  await setSettingJson(CREATIVE_CONFIG_KEY, v.config);
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "CREATIVE_MOCKUP_TOGGLE",
    entity: "SETTINGS",
    entityId: CREATIVE_CONFIG_KEY,
    before: { [key]: cur },
    after: { [key]: v.config[key] },
    reason: `${on ? "Bật" : "Tắt"} mockup hằng ngày cho ${kind === "SOURCE" ? "quảng cáo cũ" : "mã"} ${id}`,
  });
  revalidatePath(DUONG);
  return { ok: true, on };
}

/**
 * Đánh dấu / bỏ đánh dấu một thiết kế "đưa vào sản xuất". Máy không bao giờ đặt trạng thái này; bỏ đánh
 * dấu trả thiết kế về `TESTING` — lượt chấm kế tiếp đưa nó về đúng `WIN` / `LOSE` theo số đo của mẩu.
 */
export async function setDesignProduction(input: unknown): Promise<Result<{ status: string }>> {
  const user = await requireUser();
  if (!can(user, "ideas:write")) return { error: "Bạn không có quyền đổi trạng thái thiết kế" };
  const parsed = designProductionSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const { id, on } = parsed.data;

  const db = await getDb();
  const dc = schema.designConcepts;
  const cu = await db.query.designConcepts.findFirst({ where: eq(dc.id, id), columns: { id: true, status: true, code: true } });
  if (!cu) return { error: "Không tìm thấy thiết kế" };
  const now = new Date();
  if (on === (cu.status === "PRODUCTION")) return { ok: true, status: cu.status };
  const status = on ? "PRODUCTION" : "TESTING";
  await db
    .update(dc)
    .set(on ? { status, productionByUserId: user.id, productionAt: now, updatedAt: now } : { status, productionByUserId: null, productionAt: null, updatedAt: now })
    .where(eq(dc.id, id));
  await audit({ userId: user.id, userEmail: user.email, action: "CREATIVE_DESIGN_PRODUCTION", entity: "DESIGN_CONCEPT", entityId: id, before: { status: cu.status }, after: { status }, reason: `${cu.code}: ${on ? "đưa vào sản xuất" : "bỏ đánh dấu sản xuất"}` });
  revalidatePath(DUONG);
  return { ok: true, status };
}
