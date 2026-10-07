import { and, asc, desc, eq, gt, gte, inArray, isNotNull, lte, ne } from "drizzle-orm";
import { getSyncState, setSyncState } from "@/lib/sync/runner";
import { getDb, schema } from "@/db";
import type { TechTaskStatus } from "@/lib/constants/tech";
import { ciFixDecision, deployCatchUpSteps, observationVerdict, prTransitionEvents, type PrSnapshot } from "@/lib/constants/tech-delivery";
import { WORKER_BRANCH_PATTERN } from "@/lib/constants/tech-worker";
import { commitContains, getPull } from "@/lib/integrations/github/client";
import { dispatchAgentOpenPr } from "@/lib/integrations/github/dispatch";
import { recordTechEvent } from "@/lib/tech/control-plane";
import { createTechTask, recordTechTaskEvent, setTechTaskStatus, verifyTechTaskOnProduction, type TechActor } from "@/lib/tech/service";

/**
 * ═══════════ ĐƯỜNG GIAO HÀNG — PHẢN ỨNG TẤT ĐỊNH VỚI GITHUB (Pha 3) ═══════════
 *
 * docs/tech-control-plane/README.md mục 10. Luật ở `lib/constants/tech-delivery.ts` (thuần); tệp này chỉ đọc /
 * ghi và gọi GitHub. Chạy trong các job ĐÃ CÓ LỊCH (`github-pr-sync`, `task-advance-watch`) — không thêm lịch mới.
 *
 * Mọi lượt ghi đi qua `setTechTaskStatus` với danh tính `SYSTEM` — cùng đường của người, cùng bảng phép chuyển,
 * cùng cổng duyệt R2. Máy không bao giờ đặt `DONE` mà không có bằng chứng xác minh ghi trước.
 */

const MAY: TechActor = { kind: "SYSTEM", name: "job:tech-delivery" };
const CON_TRO_GIAO_HANG = "tech-delivery.deploy-cursor";

/* ═════════════════════ 1 · YÊU CẦU MỞ PR ═════════════════════ */

/**
 * Worker vừa đẩy nhánh và lượt chạy THÀNH CÔNG ⇒ máy chủ yêu cầu cầu nối mở PR bằng danh tính bot. Không bao giờ
 * làm hỏng lượt kết thúc: lỗi ở đây thành một sự kiện `pr.request_failed` kèm lý do, việc vẫn ở REVIEW với nhánh.
 */
export async function requestWorkerPullRequest(task: { id: string; code: string; title: string; missionId: string | null }, branch: string, summary: string) {
  if (!WORKER_BRANCH_PATTERN.test(branch)) return { requested: false as const, reason: "NOT_WORKER_BRANCH" };
  const db = await getDb();
  const body = [
    `Việc **${task.code}** trên /tech — mở tự động sau lượt chạy worker.`,
    "",
    summary.slice(0, 3000),
    "",
    "Cổng bắt buộc: `gates / gates`. Bot không gộp, không duyệt — người duyệt rồi Delivery Controller gộp theo hàng đợi.",
  ].join("\n");
  const res = await dispatchAgentOpenPr({ head: branch, title: `${task.code}: ${task.title}`, body });
  await recordTechEvent(
    db,
    {
      name: res.ok ? "pr.requested" : "pr.request_failed",
      subjectType: "TASK",
      subjectId: task.id,
      taskId: task.id,
      missionId: task.missionId,
      payload: res.ok ? { taskCode: task.code, branch } : { taskCode: task.code, branch, kind: res.kind, detail: res.detail },
      dedupeKey: res.ok ? `prreq:${branch}` : null,
    },
    MAY,
  );
  await recordTechTaskEvent({ taskId: task.id, kind: "PR", note: res.ok ? `Đã yêu cầu mở PR cho ${branch} (bot erp-agent)` : `Chưa mở được PR cho ${branch}: ${res.detail}` }, MAY);
  return res.ok ? { requested: true as const } : { requested: false as const, reason: res.kind };
}

/* ═════════════════════ 2 · PR / CI ĐỔI ⇒ SỰ KIỆN + PHẢN ỨNG ═════════════════════ */

/** Gọi bởi `github-pr-sync` mỗi khi phép chiếu PR của một việc ĐỔI. */
export async function onPullRequestChanged(task: { id: string; code: string; missionId: string | null }, prev: PrSnapshot, next: PrSnapshot) {
  const db = await getDb();
  const events = prTransitionEvents(prev, next);
  for (const e of events) {
    await recordTechEvent(
      db,
      { name: e.name, subjectType: "TASK", subjectId: task.id, taskId: task.id, missionId: task.missionId, payload: { taskCode: task.code, prNumber: next.prNumber, headSha: next.headSha }, dedupeKey: `${e.dedupe}:${task.id}` },
      MAY,
    );
  }
  if (events.some((e) => e.name === "ci.failed")) await handleCiFailure(task.id, next);
  return events.map((e) => e.name);
}

/**
 * CI đỏ trên PR của việc worker ⇒ mở MỘT việc con `ci-debug` trên CHÍNH nhánh đó (worker sửa tiếp, PR tự cập
 * nhật, CI chạy lại). Có trần `CI_FIX_MAX`; hết trần ⇒ việc gốc FAILED (vẫn mở, hiện ở nhóm thất bại) — không vòng
 * thử vô hạn. Việc con thất bại / đỏ tiếp thì đếm vào CÙNG trần của việc gốc.
 */
export async function handleCiFailure(taskId: string, pr: PrSnapshot) {
  const db = await getDb();
  const t0 = await db.query.techTasks.findFirst({ where: eq(schema.techTasks.id, taskId) });
  if (!t0) return { decision: "NOT_OPEN" as const };
  // Việc sửa đỏ tiếp ⇒ quy về việc GỐC (một PR, một trần).
  const root = t0.capability === "ci-debug" && t0.parentTaskId ? ((await db.query.techTasks.findFirst({ where: eq(schema.techTasks.id, t0.parentTaskId) })) ?? t0) : t0;
  const fixes = await db
    .select({ id: schema.techTasks.id, status: schema.techTasks.status })
    .from(schema.techTasks)
    .where(and(eq(schema.techTasks.parentTaskId, root.id), eq(schema.techTasks.capability, "ci-debug")));
  const open = fixes.filter((f) => f.status !== "DONE" && f.status !== "CANCELLED" && f.status !== "REVIEW" && f.status !== "FAILED").length;
  const decision = ciFixDecision({ branch: root.branch, prState: pr.prState || root.prState, fixTasksTotal: fixes.length, fixTasksOpen: open });

  if (decision === "CREATE_FIX") {
    const r = await createTechTask(
      {
        title: `Sửa CI đỏ: ${root.code} · PR #${pr.prNumber ?? root.prNumber ?? "?"} (lần ${fixes.length + 1})`,
        description: [
          `PR #${pr.prNumber ?? root.prNumber} của việc ${root.code} đỏ cổng \`gates / gates\` ở commit ${pr.headSha.slice(0, 12)}.`,
          `Làm việc TRÊN CHÍNH nhánh ${root.branch}: đọc lỗi cổng (npm run typecheck · lint · test), sửa MÃ cho xanh.`,
          "Không sửa giá trị kỳ vọng của bài kiểm để cho xanh; không nới cổng.",
        ].join("\n"),
        taskType: "BUGFIX",
        module: root.module as never,
        priority: root.priority as never,
        source: "TEST_FAILURE",
        sourceRef: `PR #${pr.prNumber ?? root.prNumber} @ ${pr.headSha.slice(0, 12)}`,
        parentTaskId: root.id,
        missionId: root.missionId,
        branch: root.branch,
      },
      MAY,
    );
    if ("ok" in r) {
      await db.update(schema.techTasks).set({ capability: "ci-debug" }).where(eq(schema.techTasks.id, r.id));
      for (const to of ["TRIAGED", "SPEC_READY"] as const) await setTechTaskStatus({ taskId: r.id, to }, MAY);
      await recordTechEvent(
        db,
        { name: "ci.fix_requested", subjectType: "TASK", subjectId: root.id, taskId: root.id, missionId: root.missionId, payload: { taskCode: root.code, fixCode: r.code, attempt: fixes.length + 1 }, dedupeKey: `cifix:${root.id}:${pr.headSha}` },
        MAY,
      );
    }
  } else if (decision === "EXHAUSTED" && root.status === "REVIEW") {
    await setTechTaskStatus({ taskId: root.id, to: "FAILED", note: `CI vẫn đỏ sau ${fixes.length} lượt sửa tự động — dừng, người xem PR #${root.prNumber}.` }, MAY);
    await recordTechEvent(db, { name: "ci.retry_exhausted", subjectType: "TASK", subjectId: root.id, taskId: root.id, missionId: root.missionId, payload: { taskCode: root.code, fixes: fixes.length }, dedupeKey: `ciexhaust:${root.id}` }, MAY);
  }
  return { decision };
}

/* ═════════════════════ 3 · ĐÃ GỘP + ĐÃ DEPLOY ⇒ OBSERVING ═════════════════════ */

/** Lượt deploy THÀNH CÔNG + ĐÃ ĐỐI CHIẾU mới nhất — "production đang chạy commit này", có chứng cứ. */
async function latestVerifiedDeployment() {
  const db = await getDb();
  return db.query.techDeployments.findFirst({
    where: and(eq(schema.techDeployments.status, "SUCCEEDED"), eq(schema.techDeployments.verification, "VERIFIED")),
    orderBy: [desc(schema.techDeployments.startedAt)],
  });
}

/**
 * Việc đã gộp (QA / READY_TO_DEPLOY / DEPLOYING) mà commit đang chạy production CHỨA commit gộp của nó ⇒ đi tới
 * OBSERVING qua đủ các khâu. Việc R2 chưa duyệt KHÔNG đi (cổng duyệt deploy vẫn đứng nguyên). Mỗi lượt tối đa
 * `limit` việc — mỗi việc tốn 2 lượt gọi GitHub.
 */
export async function advanceDeployedTasks(limit = 10) {
  const db = await getDb();
  const dep = await latestVerifiedDeployment();
  const out = { considered: 0, advanced: 0, notContained: 0, skippedApproval: 0, errors: 0 };
  if (!dep) return out;
  /*
    XOAY VÒNG (review 07/10, mục 13): con trỏ theo `id` lưu ở sync_state — việc gộp nhầm nhánh / không bao giờ lên
    production không chiếm chỗ mãi. Hết vòng thì quay về đầu.
  */
  const conTro = (await getSyncState<string>(CON_TRO_GIAO_HANG)) ?? "";
  const dieuKien = and(inArray(schema.techTasks.status, ["QA", "READY_TO_DEPLOY", "DEPLOYING"]), eq(schema.techTasks.prState, "MERGED"), isNotNull(schema.techTasks.prNumber));
  let tasks = await db.query.techTasks.findMany({ where: and(dieuKien, gt(schema.techTasks.id, conTro)), orderBy: [asc(schema.techTasks.id)], limit });
  if (tasks.length < limit && conTro) {
    const dau = await db.query.techTasks.findMany({ where: and(dieuKien, lte(schema.techTasks.id, conTro)), orderBy: [asc(schema.techTasks.id)], limit: limit - tasks.length });
    tasks = [...tasks, ...dau];
  }
  if (tasks.length) await setSyncState(CON_TRO_GIAO_HANG, tasks[tasks.length - 1].id);
  for (const t of tasks) {
    out.considered += 1;
    if (t.approvalRequired && t.approvalStatus !== "APPROVED") {
      out.skippedApproval += 1;
      continue;
    }
    try {
      const pull = await getPull(t.prNumber!);
      if (!pull.mergeCommitSha || !(await commitContains(dep.commitSha, pull.mergeCommitSha))) {
        out.notContained += 1;
        continue;
      }
      for (const to of deployCatchUpSteps(t.status as TechTaskStatus)) {
        const r = await setTechTaskStatus({ taskId: t.id, to, note: `Lượt deploy ${dep.externalRunId || dep.id} (commit ${dep.commitSha.slice(0, 12)}, đã đối chiếu) chứa commit gộp ${pull.mergeCommitSha.slice(0, 12)} của PR #${t.prNumber}` }, MAY);
        if ("error" in r) throw new Error(r.error);
      }
      await recordTechEvent(
        db,
        { name: "deploy.reached", subjectType: "TASK", subjectId: t.id, taskId: t.id, missionId: t.missionId, payload: { taskCode: t.code, deploymentId: dep.id, commitSha: dep.commitSha, mergeSha: pull.mergeCommitSha, deployedAt: dep.startedAt.toISOString() }, dedupeKey: `deploy:${dep.id}:${t.id}` },
        MAY,
      );
      out.advanced += 1;
    } catch {
      out.errors += 1;
    }
  }
  return out;
}

/* ═════════════════════ 4 · HẬU KIỂM ⇒ DONE / CẦN CHỦ SHOP ═════════════════════ */

/**
 * Việc OBSERVING: đủ cửa sổ quan sát, production vẫn chạy bản đã đối chiếu, không sự cố SEV0/SEV1 mở sau mốc deploy
 * ⇒ ghi bằng chứng xác minh rồi DONE. Có sự cố nặng ⇒ "Cần chủ shop" (PRODUCTION_INCIDENT). Không có chứng cứ deploy
 * (việc vào OBSERVING bằng tay) ⇒ KHÔNG đụng — người xác minh như trước.
 */
export async function verifyObservedTasks(now = new Date(), limit = 20) {
  const db = await getDb();
  const out = { considered: 0, passed: 0, incident: 0, waiting: 0, noEvidence: 0, rolledBack: 0 };
  const tasks = await db.query.techTasks.findMany({ where: eq(schema.techTasks.status, "OBSERVING"), orderBy: [asc(schema.techTasks.updatedAt)], limit });
  if (!tasks.length) return out;
  const dep = await latestVerifiedDeployment();
  for (const t of tasks) {
    out.considered += 1;
    const [toi] = await db
      .select({ payload: schema.techEvents.payload, at: schema.techEvents.occurredAt })
      .from(schema.techEvents)
      .where(and(eq(schema.techEvents.taskId, t.id), eq(schema.techEvents.name, "deploy.reached")))
      .orderBy(asc(schema.techEvents.occurredAt))
      .limit(1);
    const p = (toi?.payload ?? {}) as { deployedAt?: string; deploymentId?: string; mergeSha?: string };
    const deployedAt = toi ? new Date(String(p.deployedAt ?? toi.at.toISOString())) : null;
    /*
      PRODUCTION CÒN CHẠY MÃ CỦA VIỆC KHÔNG (review 07/10, mục 4): lượt deploy hiện hành khác lượt đã đưa việc lên ⇒
      kiểm LẠI commit đang chạy có chứa commit gộp. Không chứa (deploy lại một SHA cũ / quay lui) ⇒ ROLLED_BACK,
      không bao giờ DONE. Không đối chiếu được (GitHub lỗi) ⇒ chờ lượt sau, không kết luận.
    */
    let conChay: boolean | null = null;
    if (toi && dep && p.mergeSha) {
      if (dep.id === p.deploymentId) conChay = true;
      else conChay = await commitContains(dep.commitSha, p.mergeSha).catch(() => null);
    }
    if (conChay === false) {
      const r = await setTechTaskStatus({ taskId: t.id, to: "ROLLED_BACK", note: `Lượt deploy hiện hành ${dep?.externalRunId || dep?.id} (commit ${dep?.commitSha.slice(0, 12)}) KHÔNG chứa commit gộp ${p.mergeSha?.slice(0, 12)} — mã của việc không còn trên production.` }, MAY);
      if ("ok" in r) {
        out.rolledBack += 1;
        await recordTechEvent(db, { name: "verification.failed", subjectType: "TASK", subjectId: t.id, taskId: t.id, missionId: t.missionId, payload: { taskCode: t.code, reason: "NOT_IN_PRODUCTION", deploymentId: dep?.id }, dedupeKey: `verifygone:${t.id}:${dep?.id}` }, MAY);
      }
      continue;
    }
    if (conChay === null && toi) {
      out.waiting += 1;
      continue;
    }
    const severe = deployedAt
      ? (
          await db
            .select({ code: schema.techIncidents.code })
            .from(schema.techIncidents)
            .where(and(inArray(schema.techIncidents.severity, ["SEV0", "SEV1"]), ne(schema.techIncidents.status, "RESOLVED"), gte(schema.techIncidents.detectedAt, deployedAt)))
        ).map((x) => x.code)
      : [];
    const v = observationVerdict({ deployedAt, verified: !!dep, severeIncidentsSince: severe.length, now });
    if (v === "NO_EVIDENCE") out.noEvidence += 1;
    else if (v === "WAIT") out.waiting += 1;
    else if (v === "INCIDENT") {
      const r = await setTechTaskStatus(
        { taskId: t.id, to: "NEEDS_OWNER", ownerEscalation: "PRODUCTION_INCIDENT", ownerAction: `Có sự cố nặng mở sau khi ${t.code} lên production (${severe.join(", ")}). Mở sự cố, quyết sửa tiến hay quay lui.` },
        MAY,
      );
      if ("ok" in r) {
        out.incident += 1;
        await recordTechEvent(db, { name: "verification.failed", subjectType: "TASK", subjectId: t.id, taskId: t.id, missionId: t.missionId, payload: { taskCode: t.code, incidents: severe }, dedupeKey: `verifyfail:${t.id}:${severe.join(",")}` }, MAY);
      }
    } else {
      const evidence = `Máy hậu kiểm: lượt deploy ${dep?.externalRunId || dep?.id} commit ${dep?.commitSha.slice(0, 12)} đã đối chiếu với commit đang chạy và CHỨA commit gộp ${p.mergeSha?.slice(0, 12)}; quan sát ≥ ${Math.round((now.getTime() - deployedAt!.getTime()) / 60000)} phút, 0 sự cố SEV0/SEV1 mở sau mốc deploy.`;
      // Không ghi được bằng chứng xác minh ⇒ KHÔNG đóng (DONE không được đi bằng câu ghi chú thay cho chứng cứ).
      const xm = await verifyTechTaskOnProduction({ taskId: t.id, evidence }, MAY);
      if ("error" in xm) {
        out.waiting += 1;
        continue;
      }
      const r = await setTechTaskStatus({ taskId: t.id, to: "DONE", note: evidence }, MAY);
      if ("ok" in r) {
        out.passed += 1;
        await recordTechEvent(db, { name: "verification.passed", subjectType: "TASK", subjectId: t.id, taskId: t.id, missionId: t.missionId, payload: { taskCode: t.code, deploymentId: dep?.id }, dedupeKey: `verifyok:${t.id}` }, MAY);
      }
    }
  }
  return out;
}

/** Một bước của job đã có lịch (`task-advance-watch`): nối deploy rồi hậu kiểm. Không ném lỗi ra ngoài. */
export async function runDeliveryWatch(now = new Date()) {
  const deploy = await advanceDeployedTasks().catch(() => ({ considered: 0, advanced: 0, notContained: 0, skippedApproval: 0, errors: 1 }));
  const verify = await verifyObservedTasks(now).catch(() => ({ considered: 0, passed: 0, incident: 0, waiting: 0, noEvidence: 0, rolledBack: 0 }));
  return { deploy, verify, at: now.toISOString() };
}
