"use server";

import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb, schema } from "@/db";
import type { IdeaStatus } from "@/db/schema";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { IDEA_IMAGE_MAX_BASE64, IDEA_MAX_IMAGES } from "@/lib/constants/ideas";

type Result<T = object> = ({ ok: true } & T) | { error: string };

const anhSchema = z.object({
  contentType: z.string().trim().regex(/^image\/(jpeg|png|webp)$/i, "Chỉ nhận ảnh JPEG, PNG hoặc WebP"),
  base64: z.string().min(1).max(IDEA_IMAGE_MAX_BASE64, "Ảnh quá lớn — thu nhỏ trước khi tải lên"),
});

const ideaSchema = z.object({
  marketerId: z.string().trim().max(120).optional(),
  marketerName: z.string().trim().min(1, "Chọn marketer phụ trách").max(120),
  ideaDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Ngày không hợp lệ"),
  content: z.string().trim().min(1, "Nhập nội dung ý tưởng").max(5000),
  images: z.array(anhSchema).max(IDEA_MAX_IMAGES, `Tối đa ${IDEA_MAX_IMAGES} ảnh mỗi ý tưởng`).default([]),
});

const commentSchema = z.object({
  ideaId: z.string().min(1),
  body: z.string().trim().min(1, "Nhập nhận xét").max(3000),
  /** Quản lý chốt trạng thái kèm nhận xét; để trống là chỉ trao đổi. */
  decision: z.enum(["CHANGES", "APPROVED", "REJECTED"]).optional(),
});

function loi(error: unknown, mac: string) {
  if (error instanceof z.ZodError) return error.issues[0]?.message ?? mac;
  return error instanceof Error && error.message ? error.message : mac;
}

function lamMoi(id?: string) {
  revalidatePath("/ideas");
  if (id) revalidatePath(`/ideas/${id}`);
}

/** Đăng ý tưởng mới kèm ảnh. Ảnh đã được thu nhỏ ở trình duyệt; ở đây chỉ kiểm tra trần an toàn. */
export async function createIdea(input: unknown): Promise<Result<{ id: string }>> {
  const user = await requireUser();
  if (!can(user, "ideas:write")) return { error: "Bạn không có quyền đăng ý tưởng" };
  let data: z.infer<typeof ideaSchema>;
  try {
    data = ideaSchema.parse(input);
  } catch (e) {
    return { error: loi(e, "Dữ liệu không hợp lệ") };
  }
  const db = await getDb();
  const [row] = await db
    .insert(schema.marketingIdeas)
    .values({
      marketerId: data.marketerId || null,
      marketerName: data.marketerName,
      ideaDate: data.ideaDate,
      content: data.content,
      createdBy: user.email,
      createdByName: user.name || user.email,
    })
    .returning({ id: schema.marketingIdeas.id });

  if (data.images.length) {
    await db.insert(schema.marketingIdeaImages).values(
      data.images.map((a, index) => ({
        ideaId: row.id,
        contentType: a.contentType.toLowerCase(),
        bytes: Math.round((a.base64.length * 3) / 4),
        data: a.base64,
        sortOrder: index,
      })),
    );
  }
  await audit({ userId: user.id, userEmail: user.email, action: "IDEA_CREATE", entity: "IDEA", entityId: row.id, detail: { marketer: data.marketerName, ngay: data.ideaDate, anh: data.images.length } });
  lamMoi(row.id);
  return { ok: true, id: row.id };
}

/**
 * Quản lý nhận xét. Nhận xét đầu tiên tự đưa ý tưởng sang "Quản lý đang xem" — người dùng không
 * phải bấm thêm một nút chỉ để nói rằng mình đã đọc.
 */
export async function commentOnIdea(input: unknown): Promise<Result> {
  const user = await requireUser();
  let data: z.infer<typeof commentSchema>;
  try {
    data = commentSchema.parse(input);
  } catch (e) {
    return { error: loi(e, "Dữ liệu không hợp lệ") };
  }
  const db = await getDb();
  const idea = await db.query.marketingIdeas.findFirst({ where: eq(schema.marketingIdeas.id, data.ideaId), columns: { id: true, createdBy: true, status: true } });
  if (!idea) return { error: "Không tìm thấy ý tưởng" };

  const laQuanLy = can(user, "ideas:review");
  // Marketer được trả lời trên chính ý tưởng của mình; người ngoài thì phải có quyền nhận xét.
  if (!laQuanLy && idea.createdBy !== user.email) return { error: "Bạn không có quyền nhận xét ý tưởng này" };
  if (data.decision && !laQuanLy) return { error: "Chỉ quản lý mới chốt được Duyệt / Cần sửa / Không duyệt" };

  const now = new Date();
  const trangThaiMoi: IdeaStatus | null = data.decision ?? (laQuanLy && idea.status === "NEW" ? "REVIEWING" : null);

  await db.insert(schema.marketingIdeaComments).values({
    ideaId: idea.id,
    authorEmail: user.email,
    authorName: user.name || user.email,
    body: data.body,
    statusSet: data.decision ?? null,
  });
  if (trangThaiMoi) {
    await db
      .update(schema.marketingIdeas)
      .set({
        status: trangThaiMoi,
        updatedAt: now,
        ...(data.decision ? { reviewedAt: now, reviewedBy: user.name || user.email } : {}),
      })
      .where(eq(schema.marketingIdeas.id, idea.id));
  }
  await audit({ userId: user.id, userEmail: user.email, action: data.decision ? "IDEA_REVIEW" : "IDEA_COMMENT", entity: "IDEA", entityId: idea.id, detail: { decision: data.decision ?? "", status: trangThaiMoi ?? idea.status } });
  lamMoi(idea.id);
  return { ok: true };
}

/** Xoá ý tưởng: người đăng xoá được của mình, quản lý xoá được của mọi người. Ảnh và trao đổi xoá theo. */
export async function deleteIdea(input: unknown): Promise<Result> {
  const user = await requireUser();
  const parsed = z.object({ id: z.string().min(1) }).safeParse(input);
  if (!parsed.success) return { error: "Thiếu mã ý tưởng" };
  const db = await getDb();
  const idea = await db.query.marketingIdeas.findFirst({ where: eq(schema.marketingIdeas.id, parsed.data.id), columns: { id: true, createdBy: true } });
  if (!idea) return { error: "Không tìm thấy ý tưởng" };
  const laCuaMinh = idea.createdBy === user.email && can(user, "ideas:write");
  if (!laCuaMinh && !can(user, "ideas:review")) return { error: "Bạn chỉ xoá được ý tưởng của chính mình" };
  await db.delete(schema.marketingIdeas).where(eq(schema.marketingIdeas.id, idea.id));
  await audit({ userId: user.id, userEmail: user.email, action: "IDEA_DELETE", entity: "IDEA", entityId: idea.id, detail: {} });
  lamMoi();
  return { ok: true };
}

/** Bổ sung ảnh cho ý tưởng đã đăng (marketer sửa lại theo yêu cầu của quản lý). */
export async function addIdeaImages(input: unknown): Promise<Result<{ added: number }>> {
  const user = await requireUser();
  if (!can(user, "ideas:write")) return { error: "Bạn không có quyền sửa ý tưởng" };
  const parsed = z.object({ ideaId: z.string().min(1), images: z.array(anhSchema).min(1).max(IDEA_MAX_IMAGES) }).safeParse(input);
  if (!parsed.success) return { error: loi(parsed.error, "Dữ liệu không hợp lệ") };
  const db = await getDb();
  const idea = await db.query.marketingIdeas.findFirst({ where: eq(schema.marketingIdeas.id, parsed.data.ideaId), columns: { id: true, createdBy: true } });
  if (!idea) return { error: "Không tìm thấy ý tưởng" };
  if (idea.createdBy !== user.email && !can(user, "ideas:review")) return { error: "Bạn chỉ sửa được ý tưởng của chính mình" };

  const [dem] = await db.select({ n: sql<number>`count(*)` }).from(schema.marketingIdeaImages).where(eq(schema.marketingIdeaImages.ideaId, idea.id));
  const dangCo = Number(dem?.n ?? 0);
  if (dangCo + parsed.data.images.length > IDEA_MAX_IMAGES) {
    return { error: `Ý tưởng đang có ${dangCo} ảnh, tối đa ${IDEA_MAX_IMAGES} ảnh` };
  }
  await db.insert(schema.marketingIdeaImages).values(
    parsed.data.images.map((a, index) => ({
      ideaId: idea.id,
      contentType: a.contentType.toLowerCase(),
      bytes: Math.round((a.base64.length * 3) / 4),
      data: a.base64,
      sortOrder: dangCo + index,
    })),
  );
  lamMoi(idea.id);
  return { ok: true, added: parsed.data.images.length };
}

/** Xoá một ảnh khỏi ý tưởng. */
export async function deleteIdeaImage(input: unknown): Promise<Result> {
  const user = await requireUser();
  const parsed = z.object({ imageId: z.string().min(1) }).safeParse(input);
  if (!parsed.success) return { error: "Thiếu mã ảnh" };
  const db = await getDb();
  const [anh] = await db
    .select({ id: schema.marketingIdeaImages.id, ideaId: schema.marketingIdeaImages.ideaId, createdBy: schema.marketingIdeas.createdBy })
    .from(schema.marketingIdeaImages)
    .innerJoin(schema.marketingIdeas, eq(schema.marketingIdeas.id, schema.marketingIdeaImages.ideaId))
    .where(eq(schema.marketingIdeaImages.id, parsed.data.imageId))
    .limit(1);
  if (!anh) return { error: "Không tìm thấy ảnh" };
  const laCuaMinh = anh.createdBy === user.email && can(user, "ideas:write");
  if (!laCuaMinh && !can(user, "ideas:review")) return { error: "Bạn chỉ sửa được ý tưởng của chính mình" };
  await db.delete(schema.marketingIdeaImages).where(and(eq(schema.marketingIdeaImages.id, anh.id)));
  lamMoi(anh.ideaId);
  return { ok: true };
}

