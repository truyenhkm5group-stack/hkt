"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { TECH_PRIORITIES } from "@/lib/constants/tech";
import { TECH_GOAL_STATUSES, TECH_MISSION_STATUSES } from "@/lib/constants/tech-control-plane";
import { attachTechTaskToMission, createTechGoal, createTechMission, seedTechProjects, setTechGoalStatus, setTechMissionStatus } from "@/lib/tech/control-plane";
import type { TechActor, TechResult } from "@/lib/tech/service";

/**
 * ───────────── SERVER ACTION — GOAL · MISSION ─────────────
 *
 * Vỏ mỏng như `lib/actions/tech.ts`: **quyền `tech:manage` → zod → `lib/tech/control-plane.ts` → `audit()`
 * → làm mới**. Mọi lượt ghi ở đây mang `kind: "HUMAN"` và khoá tài khoản thật.
 */

const KHONG_QUYEN = "Bạn không có quyền quản trị Phòng Tech AI";

async function nguoiQuanTri() {
  const user = await requireUser();
  if (!can(user, "tech:manage")) return null;
  return user;
}

function actorOf(user: { id: string; name: string; email: string }): TechActor {
  return { kind: "HUMAN", id: user.id, name: user.name || user.email };
}

function parse<T extends z.ZodTypeAny>(schemaZ: T, input: unknown): { data: z.infer<T> } | { error: string } {
  const r = schemaZ.safeParse(input);
  return r.success ? { data: r.data } : { error: r.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
}

function lamMoi(ids: { goalId?: string | null; missionId?: string | null; taskId?: string | null } = {}) {
  revalidatePath("/tech");
  revalidatePath("/tech/goals");
  revalidatePath("/tech/missions");
  revalidatePath("/tech/needs-owner");
  if (ids.goalId) revalidatePath(`/tech/goals/${ids.goalId}`);
  if (ids.missionId) revalidatePath(`/tech/missions/${ids.missionId}`);
  if (ids.taskId) revalidatePath(`/tech/tasks/${ids.taskId}`);
}

export async function seedTechProjectsAction(): Promise<TechResult<{ created: number }>> {
  const user = await nguoiQuanTri();
  if (!user) return { error: KHONG_QUYEN };
  const res = await seedTechProjects(actorOf(user));
  if ("error" in res) return res;
  if (res.created) await audit({ userId: user.id, userEmail: user.email, action: "TECH_PROJECTS_SEEDED", entity: "TECH_PROJECT", after: { created: res.created } });
  lamMoi();
  return res;
}

const goalSchema = z.object({
  title: z.string().trim().min(5, "Mục tiêu quá ngắn").max(300),
  description: z.string().trim().max(20_000).optional(),
  successCriteria: z.string().trim().max(4000).optional(),
  priority: z.enum(TECH_PRIORITIES),
  project: z.string().trim().max(60).nullish(),
  activate: z.boolean().optional(),
});

export async function createTechGoalAction(input: unknown): Promise<TechResult<{ id: string; code: string }>> {
  const user = await nguoiQuanTri();
  if (!user) return { error: KHONG_QUYEN };
  const p = parse(goalSchema, input);
  if ("error" in p) return p;
  const res = await createTechGoal(p.data, actorOf(user));
  if ("error" in res) return res;
  await audit({ userId: user.id, userEmail: user.email, action: "TECH_GOAL_CREATED", entity: "TECH_GOAL", entityId: res.id, after: { code: res.code, title: p.data.title, priority: p.data.priority } });
  lamMoi({ goalId: res.id });
  return res;
}

const goalStatusSchema = z.object({ goalId: z.string().min(1), to: z.enum(TECH_GOAL_STATUSES), note: z.string().trim().max(4000).optional() });

export async function setTechGoalStatusAction(input: unknown): Promise<TechResult> {
  const user = await nguoiQuanTri();
  if (!user) return { error: KHONG_QUYEN };
  const p = parse(goalStatusSchema, input);
  if ("error" in p) return p;
  const res = await setTechGoalStatus(p.data, actorOf(user));
  if ("error" in res) return res;
  if (!res.skipped) {
    await audit({
      userId: user.id,
      userEmail: user.email,
      action: "TECH_GOAL_STATUS",
      entity: "TECH_GOAL",
      entityId: p.data.goalId,
      after: { status: p.data.to, cancelledMissions: res.cancelledMissions ?? 0 },
      reason: p.data.note,
    });
  }
  lamMoi({ goalId: p.data.goalId });
  return { ok: true };
}

const missionSchema = z.object({
  title: z.string().trim().min(5, "Tên sứ mệnh quá ngắn").max(300),
  objective: z.string().trim().max(20_000).optional(),
  definitionOfDone: z.string().trim().max(4000).optional(),
  priority: z.enum(TECH_PRIORITIES),
  goalId: z.string().trim().max(60).nullish(),
  project: z.string().trim().max(60).nullish(),
  registryId: z.string().trim().max(80).nullish(),
});

export async function createTechMissionAction(input: unknown): Promise<TechResult<{ id: string; code: string }>> {
  const user = await nguoiQuanTri();
  if (!user) return { error: KHONG_QUYEN };
  const p = parse(missionSchema, input);
  if ("error" in p) return p;
  const res = await createTechMission(p.data, actorOf(user));
  if ("error" in res) return res;
  await audit({ userId: user.id, userEmail: user.email, action: "TECH_MISSION_CREATED", entity: "TECH_MISSION", entityId: res.id, after: { code: res.code, title: p.data.title, goalId: p.data.goalId ?? null } });
  lamMoi({ goalId: p.data.goalId, missionId: res.id });
  return res;
}

const missionStatusSchema = z.object({ missionId: z.string().min(1), to: z.enum(TECH_MISSION_STATUSES), note: z.string().trim().max(4000).optional() });

export async function setTechMissionStatusAction(input: unknown): Promise<TechResult> {
  const user = await nguoiQuanTri();
  if (!user) return { error: KHONG_QUYEN };
  const p = parse(missionStatusSchema, input);
  if ("error" in p) return p;
  const res = await setTechMissionStatus(p.data, actorOf(user));
  if ("error" in res) return res;
  if (!res.skipped) {
    await audit({ userId: user.id, userEmail: user.email, action: "TECH_MISSION_STATUS", entity: "TECH_MISSION", entityId: p.data.missionId, after: { status: p.data.to }, reason: p.data.note });
  }
  lamMoi({ missionId: p.data.missionId });
  return { ok: true };
}

const attachSchema = z.object({ taskId: z.string().min(1), missionId: z.string().trim().max(60).nullable() });

export async function attachTechTaskToMissionAction(input: unknown): Promise<TechResult> {
  const user = await nguoiQuanTri();
  if (!user) return { error: KHONG_QUYEN };
  const p = parse(attachSchema, input);
  if ("error" in p) return p;
  const res = await attachTechTaskToMission(p.data, actorOf(user));
  if ("error" in res) return res;
  if (!res.skipped) {
    await audit({ userId: user.id, userEmail: user.email, action: "TECH_TASK_MISSION", entity: "TECH_TASK", entityId: p.data.taskId, after: { missionId: p.data.missionId } });
  }
  lamMoi({ missionId: p.data.missionId, taskId: p.data.taskId });
  if (res.previousMissionId) revalidatePath(`/tech/missions/${res.previousMissionId}`);
  return { ok: true };
}
