"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb, schema, type Db } from "@/db";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/auth/session";
import type { Actor } from "@/lib/constants/actor";
import { buildTopicEvidenceSnapshot, TOPIC_MESSAGE_KINDS, TOPIC_STATUSES } from "@/lib/constants/production-os";
import { describeFollow } from "@/lib/production/lifecycle";
import { canOpenTopic, loadTopicAccess } from "@/lib/production/topic-access";
import { notifyTopicMessage, notifyTopicTagged } from "@/lib/production/topic-notify";
import { addTopicMembersCore, addTopicMessageCore, createTopicCore, removeTopicMemberCore, setTopicStatusCore } from "@/lib/production/topics";
import { getModel, getModelEvidence } from "@/lib/queries/models";
import { buildTopicOpenContext } from "@/lib/constants/early-topic";
import { getModelSignal } from "@/lib/queries/model-signal";
import { PROVISIONAL_NAME_MIN, PROVISIONAL_START_STATES } from "@/lib/constants/provisional-model";
import { registerProvisionalModelCore } from "@/lib/models/service";

/**
 * ═══════════ SERVER ACTION: TOPIC HỎI GIÁ / BÀN PHƯƠNG ÁN ═══════════
 *
 * `requireUser` → quyền theo TOPIC (`lib/production/topic-access.ts`: mở topic = `canOpenTopic`; trao đổi,
 * trạng thái, tag = `loadTopicAccess`) → zod → lõi (`lib/production/topics.ts`, ghi + sự kiện cùng giao
 * dịch) → `audit()` → tin hộp thư → `revalidatePath`. Lỗi nghiệp vụ trả `{ error }`.
 *
 * Tên người thao tác do MÁY CHỦ đọc từ phiên đăng nhập (mục 34) — client không gửi tên.
 */
type Result<T = object> = ({ ok: true } & T) | { error: string };

const urlList = z.array(z.string().trim().url("Link đính kèm phải là URL http(s)").max(600).refine((u) => /^https?:\/\//i.test(u), "Chỉ nhận link http(s)")).max(20).default([]);
const money = z.number().int("Tiền là số nguyên VND").min(0).max(100_000_000);

const requirementsSchema = z.object({
  material: z.string().trim().max(500).default(""),
  colors: z.array(z.string().trim().min(1).max(40)).max(30).default([]),
  sizes: z.array(z.string().trim().min(1).max(20)).max(30).default([]),
  trims: z.string().trim().max(500).default(""),
  designNotes: z.string().trim().max(3000).default(""),
  salePrice: money.nullable().default(null),
  targetPrice: money.nullable().default(null),
  expectedQty: z.number().int().min(0).max(1_000_000).nullable().default(null),
  deadline: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Hạn dạng YYYY-MM-DD")
    .nullable()
    .default(null),
});

const createSchema = z
  .object({
    modelId: z.string().trim().default(""),
    /** Mẫu mới CHƯA CÓ MÃ (chủ shop 26/09/2026): máy cấp mã tạm, người đặt tên gọi + khai chặng hiện tại. */
    newModel: z
      .object({
        name: z.string().trim().min(PROVISIONAL_NAME_MIN, `Đặt tên gọi tạm cho mẫu (ít nhất ${PROVISIONAL_NAME_MIN} ký tự)`).max(200),
        state: z.enum(PROVISIONAL_START_STATES),
      })
      .nullable()
      .default(null),
    title: z.string().trim().min(3, "Tiêu đề tối thiểu 3 ký tự").max(200),
    requirements: requirementsSchema,
    supplierId: z.string().trim().min(1).nullable().default(null),
    firstMessage: z.string().trim().max(5000).nullable().default(null),
    /** Người được tag ngay lúc mở (chủ shop 27/09/2026). */
    memberIds: z.array(z.string().trim().min(1)).max(100).default([]),
  })
  .refine((d) => (d.modelId ? !d.newModel : !!d.newModel), { message: "Chọn mẫu trong sổ, hoặc chọn “Mẫu mới chưa có mã”" });

function actorOf(user: { id: string; name: string | null; email: string }): Actor {
  return { id: user.id, label: user.name || user.email };
}

/** Người đang được tag trong topic — đọc lại SAU khi ghi (tài khoản tắt / trùng đã bị lõi loại). */
async function memberIdsOf(db: Db, topicId: string): Promise<string[]> {
  const rows = await db.select({ userId: schema.productionTopicMembers.userId }).from(schema.productionTopicMembers).where(eq(schema.productionTopicMembers.topicId, topicId));
  return rows.map((x) => x.userId);
}

async function topicTitle(db: Db, topicId: string): Promise<string> {
  const [t] = await db.select({ title: schema.productionTopics.title }).from(schema.productionTopics).where(eq(schema.productionTopics.id, topicId)).limit(1);
  return t?.title ?? "topic sản xuất";
}

function revalidateProduction(topicId?: string) {
  revalidatePath("/production");
  revalidatePath("/marketing/topics");
  if (topicId) revalidatePath(`/production/topics/${topicId}`);
  revalidatePath("/work");
}

export async function createProductionTopic(input: unknown): Promise<Result<{ topicId: string; lifecycle: string | null; modelCode: string | null }>> {
  const user = await requireUser();
  if (!canOpenTopic(user)) return { error: "Không có quyền mở topic sản xuất" };
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const d = parsed.data;
  const db = await getDb();

  // Mẫu chưa có mã: đăng ký vào sổ TRƯỚC với MÃ TẠM, rồi mở topic y như mẫu có sẵn. Chủ shop 27/09/2026:
  // marketing (khoá `production:topic-open`) là người mở topic cho mẫu đang test, nên khoá đó đủ để cấp MÃ TẠM
  // — chỉ mã tạm TEST-…; đăng ký mã chính thức vẫn cần `models:write`. Hỏng ở bước sau thì mẫu vẫn nằm trong sổ với mã tạm — câu lỗi nói mã ấy
  // để người chọn lại nó thay vì đăng ký lần hai.
  let modelId = d.modelId;
  let provisionalCode: string | null = null;
  if (d.newModel) {
    const reg = await registerProvisionalModelCore(db, { name: d.newModel.name, state: d.newModel.state, actor: actorOf(user), source: "ui:/marketing/topics/new" });
    if ("error" in reg) return reg;
    await audit({ userId: user.id, userEmail: user.email, action: "MODEL_REGISTER_PROVISIONAL", entity: "PRODUCT_MODEL", entityId: reg.modelId, before: null, after: { code: reg.code, name: d.newModel.name, lifecycleState: d.newModel.state, registeredBy: "USER", provisional: true } });
    revalidatePath("/models");
    modelId = reg.modelId;
    provisionalCode = reg.code;
  }
  const loiSau = (e: string) => (provisionalCode ? `${e} — mẫu đã vào sổ với mã tạm ${provisionalCode}, chọn lại mẫu ấy trong danh sách để mở topic` : e);

  const model = await getModel(modelId);
  if (!model) return { error: loiSau("Không tìm thấy mẫu trong sổ") };
  // ẢNH CHỤP chứng cứ lúc mở topic — MÁY CHỦ đọc, không nhận số từ trình duyệt. Kèm bối cảnh (Agent T):
  // tín hiệu mẫu + trạng thái khai lúc mở, để trang topic nói được topic này mở SỚM (mẫu chưa thắng) hay
  // không. Tín hiệu đọc hỏng ⇒ `signalAtOpen = null` kèm câu lỗi — KHÔNG chặn việc mở topic.
  const [ev, sig] = await Promise.all([
    getModelEvidence(model),
    getModelSignal(model.id).then(
      (r) => ({ ok: true as const, r }),
      (e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }),
    ),
  ]);
  const evidence = {
    ...buildTopicEvidenceSnapshot(ev, model.product?.id ?? null, new Date()),
    ...buildTopicOpenContext(sig.ok ? sig.r : null, model.state, sig.ok ? null : `Không đọc được tín hiệu mẫu lúc mở topic: ${sig.error}`),
  };
  // Topic mở từ nay là topic RIÊNG: chỉ người mở + người được tag + ADMIN xem (chủ shop 27/09/2026).
  const r = await createTopicCore(db, { modelId, title: d.title, requirements: d.requirements, supplierId: d.supplierId, evidence, firstMessage: d.firstMessage, restricted: true, memberIds: d.memberIds, actor: actorOf(user) });
  if ("error" in r) return { error: loiSau(r.error) };
  const tagged = await memberIdsOf(db, r.topicId);
  await audit({ userId: user.id, userEmail: user.email, action: "PRODUCTION_TOPIC_CREATE", entity: "PRODUCTION_TOPIC", entityId: r.topicId, after: { modelId, title: d.title, provisionalCode, restricted: true, memberIds: tagged }, detail: { lifecycle: r.lifecycle } });
  await notifyTopicTagged(db, { topicId: r.topicId, title: d.title, userIds: tagged, byName: actorOf(user).label });
  revalidateProduction(r.topicId);
  revalidatePath(`/models/${modelId}`);
  return { ok: true, topicId: r.topicId, lifecycle: describeFollow(r.lifecycle), modelCode: provisionalCode };
}

const messageSchema = z.object({
  topicId: z.string().min(1),
  kind: z.enum(TOPIC_MESSAGE_KINDS),
  body: z.string().trim().min(1, "Nội dung trao đổi đang trống").max(5000),
  attachments: urlList,
  quotedUnitPrice: money.nullable().default(null),
});

export async function addProductionTopicMessage(input: unknown): Promise<Result<{ messageId: string }>> {
  const user = await requireUser();
  const parsed = messageSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const db = await getDb();
  // Người mở topic và người được tag trao đổi được dù không có `production:write` (chủ shop 27/09/2026).
  const acc = await loadTopicAccess(db, parsed.data.topicId, user);
  if (!acc) return { error: "Không tìm thấy topic" };
  if (!acc.post) return { error: "Bạn chưa được tag vào topic này" };
  const r = await addTopicMessageCore(db, { ...parsed.data, actor: actorOf(user) });
  if ("error" in r) return r;
  await audit({ userId: user.id, userEmail: user.email, action: "PRODUCTION_TOPIC_MESSAGE", entity: "PRODUCTION_TOPIC", entityId: parsed.data.topicId, after: { kind: parsed.data.kind, messageId: r.messageId } });
  await notifyTopicMessage(db, { topicId: parsed.data.topicId, title: await topicTitle(db, parsed.data.topicId), messageId: r.messageId, authorId: user.id, authorName: actorOf(user).label });
  revalidateProduction(parsed.data.topicId);
  return { ok: true, messageId: r.messageId };
}

const statusSchema = z.object({
  topicId: z.string().min(1),
  to: z.enum(TOPIC_STATUSES),
  note: z.string().trim().max(3000).nullable().default(null),
  selectedOption: z.string().trim().max(1000).nullable().default(null),
});

export async function setProductionTopicStatus(input: unknown): Promise<Result<{ noop: boolean }>> {
  const user = await requireUser();
  const parsed = statusSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const db = await getDb();
  const acc = await loadTopicAccess(db, parsed.data.topicId, user);
  if (!acc) return { error: "Không tìm thấy topic" };
  if (!acc.setStatus) return { error: "Không có quyền đổi trạng thái topic" };
  const r = await setTopicStatusCore(db, { ...parsed.data, actor: actorOf(user) });
  if ("error" in r) return r;
  if (!r.noop) {
    await audit({ userId: user.id, userEmail: user.email, action: "PRODUCTION_TOPIC_STATUS", entity: "PRODUCTION_TOPIC", entityId: parsed.data.topicId, before: { status: r.from }, after: { status: r.to, selectedOption: parsed.data.selectedOption }, reason: parsed.data.note ?? undefined });
  }
  // Cả nhánh `noop` cũng làm mới — lượt gọi mang luôn giao diện mới, client không cần router.refresh().
  revalidateProduction(parsed.data.topicId);
  return { ok: true, noop: r.noop };
}

const tagSchema = z.object({
  topicId: z.string().min(1),
  userIds: z.array(z.string().trim().min(1)).min(1, "Chọn ít nhất một người").max(100),
});

/** Tag một hoặc NHIỀU người vào topic — mỗi người mới nhận một tin ở hộp thư cá nhân. */
export async function tagTopicMembers(input: unknown): Promise<Result<{ added: number }>> {
  const user = await requireUser();
  const parsed = tagSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const db = await getDb();
  const acc = await loadTopicAccess(db, parsed.data.topicId, user);
  if (!acc) return { error: "Không tìm thấy topic" };
  if (!acc.tag) return { error: "Bạn chưa được tag vào topic này nên không tag thêm người được" };
  const r = await addTopicMembersCore(db, { topicId: parsed.data.topicId, userIds: parsed.data.userIds, actor: actorOf(user) });
  if ("error" in r) return r;
  if (r.added.length) {
    await audit({ userId: user.id, userEmail: user.email, action: "PRODUCTION_TOPIC_TAG", entity: "PRODUCTION_TOPIC", entityId: parsed.data.topicId, after: { userIds: r.added } });
    await notifyTopicTagged(db, { topicId: parsed.data.topicId, title: await topicTitle(db, parsed.data.topicId), userIds: r.added, byName: actorOf(user).label });
  }
  revalidateProduction(parsed.data.topicId);
  return { ok: true, added: r.added.length };
}

const untagSchema = z.object({ topicId: z.string().min(1), userId: z.string().min(1) });

/** Bỏ tag — chỉ người mở topic và ADMIN. Topic riêng: người bị bỏ tag thôi xem được topic. */
export async function untagTopicMember(input: unknown): Promise<Result> {
  const user = await requireUser();
  const parsed = untagSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const db = await getDb();
  const acc = await loadTopicAccess(db, parsed.data.topicId, user);
  if (!acc) return { error: "Không tìm thấy topic" };
  if (!acc.untag) return { error: "Chỉ người mở topic (hoặc ADMIN) bỏ tag được" };
  const r = await removeTopicMemberCore(db, { ...parsed.data, actor: actorOf(user) });
  if ("error" in r) return r;
  if (r.removed) await audit({ userId: user.id, userEmail: user.email, action: "PRODUCTION_TOPIC_UNTAG", entity: "PRODUCTION_TOPIC", entityId: parsed.data.topicId, before: { userId: parsed.data.userId } });
  revalidateProduction(parsed.data.topicId);
  return { ok: true };
}
