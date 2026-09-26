"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import type { Actor } from "@/lib/constants/actor";
import { buildTopicEvidenceSnapshot, TOPIC_MESSAGE_KINDS, TOPIC_STATUSES } from "@/lib/constants/production-os";
import { describeFollow } from "@/lib/production/lifecycle";
import { addTopicMessageCore, createTopicCore, setTopicStatusCore } from "@/lib/production/topics";
import { getModel, getModelEvidence } from "@/lib/queries/models";
import { buildTopicOpenContext } from "@/lib/constants/early-topic";
import { getModelSignal } from "@/lib/queries/model-signal";
import { PROVISIONAL_NAME_MIN, PROVISIONAL_START_STATES } from "@/lib/constants/provisional-model";
import { registerProvisionalModelCore } from "@/lib/models/service";

/**
 * ═══════════ SERVER ACTION: TOPIC HỎI GIÁ / BÀN PHƯƠNG ÁN ═══════════
 *
 * `requireUser` → `can("production:write")` → zod → lõi (`lib/production/topics.ts`, ghi + sự kiện cùng
 * giao dịch) → `audit()` → `revalidatePath`. Lỗi nghiệp vụ trả `{ error }`.
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
  })
  .refine((d) => (d.modelId ? !d.newModel : !!d.newModel), { message: "Chọn mẫu trong sổ, hoặc chọn “Mẫu mới chưa có mã”" });

function actorOf(user: { id: string; name: string | null; email: string }): Actor {
  return { id: user.id, label: user.name || user.email };
}

function revalidateProduction(topicId?: string) {
  revalidatePath("/production");
  if (topicId) revalidatePath(`/production/topics/${topicId}`);
  revalidatePath("/work");
}

export async function createProductionTopic(input: unknown): Promise<Result<{ topicId: string; lifecycle: string | null; modelCode: string | null }>> {
  const user = await requireUser();
  if (!can(user, "production:write")) return { error: "Không có quyền mở topic sản xuất" };
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const d = parsed.data;
  const db = await getDb();

  // Mẫu chưa có mã: đăng ký vào sổ TRƯỚC (đường của sổ mẫu, `models:write` như mọi lượt đăng ký mẫu mới),
  // rồi mở topic y như mẫu có sẵn. Hỏng ở bước sau thì mẫu vẫn nằm trong sổ với mã tạm — câu lỗi nói mã ấy
  // để người chọn lại nó thay vì đăng ký lần hai.
  let modelId = d.modelId;
  let provisionalCode: string | null = null;
  if (d.newModel) {
    if (!can(user, "models:write")) return { error: "Đăng ký mẫu mới chưa có mã cần thêm quyền “Vòng đời mẫu: khai & đồng bộ” — hoặc nhờ người có quyền đăng ký mẫu ở trang Vòng đời mẫu" };
    const reg = await registerProvisionalModelCore(db, { name: d.newModel.name, state: d.newModel.state, actor: actorOf(user), source: "ui:/production/topics/new" });
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
  const r = await createTopicCore(db, { modelId, title: d.title, requirements: d.requirements, supplierId: d.supplierId, evidence, firstMessage: d.firstMessage, actor: actorOf(user) });
  if ("error" in r) return { error: loiSau(r.error) };
  await audit({ userId: user.id, userEmail: user.email, action: "PRODUCTION_TOPIC_CREATE", entity: "PRODUCTION_TOPIC", entityId: r.topicId, after: { modelId, title: d.title, provisionalCode }, detail: { lifecycle: r.lifecycle } });
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
  if (!can(user, "production:write")) return { error: "Không có quyền ghi vào topic sản xuất" };
  const parsed = messageSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const db = await getDb();
  const r = await addTopicMessageCore(db, { ...parsed.data, actor: actorOf(user) });
  if ("error" in r) return r;
  await audit({ userId: user.id, userEmail: user.email, action: "PRODUCTION_TOPIC_MESSAGE", entity: "PRODUCTION_TOPIC", entityId: parsed.data.topicId, after: { kind: parsed.data.kind, messageId: r.messageId } });
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
  if (!can(user, "production:write")) return { error: "Không có quyền đổi trạng thái topic" };
  const parsed = statusSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const db = await getDb();
  const r = await setTopicStatusCore(db, { ...parsed.data, actor: actorOf(user) });
  if ("error" in r) return r;
  if (!r.noop) {
    await audit({ userId: user.id, userEmail: user.email, action: "PRODUCTION_TOPIC_STATUS", entity: "PRODUCTION_TOPIC", entityId: parsed.data.topicId, before: { status: r.from }, after: { status: r.to, selectedOption: parsed.data.selectedOption }, reason: parsed.data.note ?? undefined });
  }
  // Cả nhánh `noop` cũng làm mới — lượt gọi mang luôn giao diện mới, client không cần router.refresh().
  revalidateProduction(parsed.data.topicId);
  return { ok: true, noop: r.noop };
}
