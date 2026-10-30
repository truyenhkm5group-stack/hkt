import { z } from "zod";
import { audit } from "@/lib/audit";
import { can, type SessionUser } from "@/lib/auth/session";
import { AGENT_ZONES, agentLabel, type AgentZone } from "@/lib/constants/department-ai";
import { MC_GRADUATION_KEY, graduationRuleZ, parseGraduation } from "@/lib/constants/mission-control";
import { getSettingJson, setSettingJson } from "@/lib/settings";

/**
 * ═══════════ ĐIỀU KIỆN «TỐT NGHIỆP» CỦA TỪNG AGENT — ĐƯỜNG GHI ═══════════
 *
 * `settings["missionControl.graduation"]` của CHÍNH tổ chức đang đăng nhập: `{ <zone>: { minAccuracyPct, minSamples, windowDays } }`.
 * Chỉ người có `settings:manage` khai (đúng quyền các trang /settings — không thêm khoá mới). KHÔNG có bộ mặc định (luật 38/43): xoá
 * một agent ⇒ trở về «chưa khai», không về một con số nào. Khai lại đúng như cũ ⇒ KHÔNG ghi gì (luật 61). Khai điều kiện KHÔNG đổi
 * nấc tự chủ — đổi nấc là quyết định của người + sửa sổ department-ai + deploy (luật 69).
 */

export type GraduationResult = { ok: true; changed: boolean; message: string } | { ok: false; error: string };

const inputZ = z
  .object({
    zone: z.enum(AGENT_ZONES as [AgentZone, ...AgentZone[]], { error: "Agent không có trong sổ department-ai" }),
    rule: graduationRuleZ.nullable(),
  })
  .strict();

export async function setGraduationCore(user: SessionUser, raw: unknown): Promise<GraduationResult> {
  if (!can(user, "settings:manage")) return { ok: false, error: "Chỉ quản trị cài đặt tổ chức (settings:manage) mới khai điều kiện tốt nghiệp." };
  const parsed = inputZ.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const { zone, rule } = parsed.data;
  const current = parseGraduation(await getSettingJson<Record<string, unknown>>(MC_GRADUATION_KEY, {}));
  const before = current[zone] ?? null;
  if (JSON.stringify(before) === JSON.stringify(rule)) return { ok: true, changed: false, message: "Không có gì thay đổi." };
  const next = { ...current };
  if (rule) next[zone] = rule;
  else delete next[zone];
  await setSettingJson(MC_GRADUATION_KEY, next);
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "MISSION_CONTROL_GRADUATION",
    entity: "SETTING",
    entityId: MC_GRADUATION_KEY,
    before: { zone, rule: before },
    after: { zone, rule },
    reason: `Điều kiện tốt nghiệp · ${agentLabel(zone)}${rule ? "" : " · xoá (về «chưa khai»)"}`,
  });
  return { ok: true, changed: true, message: rule ? `Đã khai điều kiện cho ${agentLabel(zone)}.` : `Đã xoá điều kiện của ${agentLabel(zone)} — trở về «chưa khai».` };
}
