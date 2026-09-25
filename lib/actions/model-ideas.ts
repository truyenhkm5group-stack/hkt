"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { registerModelFromIdeaCore } from "@/lib/models/idea-link";

/**
 * "Đăng ký thành mẫu" trên trang ý tưởng (Company OS · A2).
 *
 * requireUser → can(`models:write`) → zod → lõi (`lib/models/idea-link.ts`, nhận `Actor`) → audit →
 * revalidatePath. Tên người thao tác do MÁY CHỦ đọc từ phiên (mục 34). Quyền xem / sửa ý tưởng không đổi:
 * nút này đòi quyền của SỔ MẪU, vì thứ được tạo ra là một mẫu.
 */
const input = z.object({
  ideaId: z.string().min(1),
  code: z.string().trim().min(1, "Nhập mã mẫu").max(40, "Mã mẫu quá dài"),
  name: z.string().max(200).optional().nullable(),
});

export async function registerModelFromIdea(raw: unknown): Promise<{ ok: true; modelId: string } | { error: string }> {
  const user = await requireUser();
  if (!can(user, "models:write")) return { error: "Cần quyền “Vòng đời mẫu: khai & đồng bộ” để đăng ký mẫu" };
  const parsed = input.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const d = parsed.data;

  const db = await getDb();
  const r = await registerModelFromIdeaCore(db, { ideaId: d.ideaId, code: d.code, name: d.name, actor: { id: user.id, label: user.name || user.email } });
  if ("error" in r) return { error: r.error };

  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "MODEL_REGISTER",
    entity: "PRODUCT_MODEL",
    entityId: r.modelId,
    before: null,
    after: { code: r.code, name: (d.name ?? "").trim(), lifecycleState: "IDEA", registeredBy: "USER", fromIdeaId: d.ideaId },
  });
  revalidatePath("/models");
  revalidatePath(`/models/${r.modelId}`);
  revalidatePath(`/ideas/${d.ideaId}`);
  return { ok: true, modelId: r.modelId };
}
