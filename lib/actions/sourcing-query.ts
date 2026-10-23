"use server";

/**
 * Sinh từ khoá tiếng Trung cho Tìm hàng nguồn (SRC-2). Quyền `sourcing:search` (lượt tìm có thể tốn lượt AI). Không ghi dữ liệu
 * nghiệp vụ nào — chỉ dòng sổ dùng AI khi AI thật sự được gọi — nên không có nhật ký / revalidate.
 */
import { z } from "zod";
import { can, requireUser } from "@/lib/auth/session";
import { defaultSourcingAiDeps } from "@/lib/sourcing/ai-deps";
import { expandWithAi, type AiExpansion } from "@/lib/sourcing/ai-expand";
import { SOURCING_INPUT_MAX, buildChineseQueries, type QueryBuild } from "@/lib/sourcing/query";

export type SourcingQueryResult = { ok: true; build: QueryBuild; ai: AiExpansion } | { ok: false; errors: { message: string }[] };

const schema = z.object({
  text: z.string().trim().min(2, "Gõ ít nhất một từ mô tả món hàng").max(SOURCING_INPUT_MAX, `Tối đa ${SOURCING_INPUT_MAX} ký tự`),
  allowAi: z.boolean(),
});

export async function buildSourcingQueriesAction(input: z.input<typeof schema>): Promise<SourcingQueryResult> {
  const user = await requireUser();
  if (!can(user, "sourcing:search")) return { ok: false, errors: [{ message: "Bạn chưa có quyền «Tìm hàng: tìm»." }] };
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => ({ message: i.message })) };
  const build = buildChineseQueries(parsed.data.text);
  const ai = await expandWithAi(build, parsed.data.allowAi, await defaultSourcingAiDeps(user.id));
  return { ok: true, build, ai };
}
