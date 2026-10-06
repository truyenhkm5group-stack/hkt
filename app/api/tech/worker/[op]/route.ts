import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { TECH_GATE_RESULTS, TECH_OWNER_ESCALATIONS } from "@/lib/constants/tech";
import { TECH_LEASE, TECH_RUN_OUTCOMES } from "@/lib/constants/tech-worker";
import {
  authenticateTechWorker,
  claimNextTechTask,
  completeTechWorkerRun,
  openRunsOfWorker,
  startTechWorkerRun,
  techWorkerHeartbeat,
} from "@/lib/tech/worker-service";

export const dynamic = "force-dynamic";

/**
 * ═══════════ CỬA CỦA WORKER — HẸP, CÓ DANH TÍNH, KHÔNG BAO GIỜ CHẠM CSDL TỪ XA ═══════════
 *
 * Worker chạy trên máy khác (máy dev có Claude Code, hoặc máy build) và KHÔNG có `DATABASE_URL`: "mã chưa qua
 * review không được chạy cạnh DB production" (cùng nguyên tắc với `/api/tech/agent-run`). Nó nói chuyện với mặt
 * phẳng điều khiển qua đúng năm thao tác:
 *
 *   POST /api/tech/worker/hello      — tôi là ai, tôi còn giữ lượt nào (khởi động lại sau sập)
 *   POST /api/tech/worker/heartbeat  — còn sống · gia hạn lease · nhật ký · nhận lệnh DỪNG
 *   POST /api/tech/worker/claim      — xin MỘT việc
 *   POST /api/tech/worker/start      — đã dựng cây làm việc
 *   POST /api/tech/worker/complete   — kết cục trong danh sách đóng
 *
 * Xác thực bằng khoá RIÊNG từng worker (`Authorization: Bearer tw_<id>.<secret>`, CSDL chỉ giữ băm) — không
 * dùng `CRON_SECRET` hay khoá chung: tắt một worker không được làm sập worker khác. Lược đồ `.strict()`: trường
 * lạ ⇒ từ chối cả gói, không bỏ qua im lặng.
 */

const fence = { runId: z.string().min(8).max(64), leaseGeneration: z.number().int().min(1) };

const heartbeatSchema = z
  .object({
    version: z.string().max(60).optional(),
    runs: z
      .array(
        z
          .object({
            ...fence,
            progressPct: z.number().min(0).max(100).nullable().optional(),
            step: z.string().max(200).optional(),
            logs: z.array(z.object({ level: z.enum(["info", "warn", "error"]).optional(), line: z.string().max(TECH_LEASE.maxLogLineChars * 2) }).strict()).max(TECH_LEASE.maxLogLinesPerBeat * 2).optional(),
          })
          .strict(),
      )
      .max(TECH_LEASE.maxConcurrencyCeiling)
      .optional(),
  })
  .strict();

const startSchema = z.object({ ...fence, baseCommit: z.string().max(64).optional(), worktree: z.string().max(300).optional(), model: z.string().max(100).optional() }).strict();

const gateSchema = z.enum(TECH_GATE_RESULTS);
const completeSchema = z
  .object({
    ...fence,
    outcome: z.enum(TECH_RUN_OUTCOMES),
    summary: z.string().max(8000).optional(),
    error: z.string().max(8000).optional(),
    branch: z.string().max(255).optional(),
    resultCommit: z.string().max(64).optional(),
    filesChanged: z.array(z.string().max(500)).max(500).optional(),
    testsRun: z.string().max(8000).optional(),
    gates: z.object({ typecheck: gateSchema.optional(), lint: gateSchema.optional(), test: gateSchema.optional(), build: gateSchema.optional() }).strict().optional(),
    model: z.string().max(100).optional(),
    cost: z.object({ usd: z.number().min(0).nullable().optional(), inputTokens: z.number().int().min(0).optional(), outputTokens: z.number().int().min(0).optional(), estimated: z.boolean().optional() }).strict().nullable().optional(),
    ownerEscalation: z.enum(TECH_OWNER_ESCALATIONS).nullable().optional(),
    ownerAction: z.string().max(2000).nullable().optional(),
  })
  .strict();

/** Lỗi fencing là câu trả lời BÌNH THƯỜNG (worker cũ sống lại) ⇒ 409, không phải 500. */
const FENCE_ERRORS = new Set(["RUN_NOT_YOURS", "RUN_CLOSED", "STALE_LEASE"]);

export async function POST(req: NextRequest, ctx: { params: Promise<{ op: string }> }) {
  const { op } = await ctx.params;
  const worker = await authenticateTechWorker(req.headers.get("authorization"));
  if (!worker) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  try {
    switch (op) {
      case "hello": {
        const runs = await openRunsOfWorker(worker.id);
        return NextResponse.json({ worker: { id: worker.id, key: worker.key, provider: worker.provider, capabilities: worker.capabilities, maxConcurrency: worker.maxConcurrency, enabled: worker.enabled }, openRuns: runs, lease: TECH_LEASE });
      }
      case "heartbeat": {
        const p = heartbeatSchema.safeParse(body);
        if (!p.success) return NextResponse.json({ error: p.error.issues[0]?.message ?? "bad request" }, { status: 400 });
        return NextResponse.json(await techWorkerHeartbeat(worker, p.data));
      }
      case "claim": {
        return NextResponse.json(await claimNextTechTask(worker));
      }
      case "start": {
        const p = startSchema.safeParse(body);
        if (!p.success) return NextResponse.json({ error: p.error.issues[0]?.message ?? "bad request" }, { status: 400 });
        const r = await startTechWorkerRun(worker, p.data);
        if ("error" in r) return NextResponse.json(r, { status: FENCE_ERRORS.has(r.error) ? 409 : 422 });
        return NextResponse.json(r);
      }
      case "complete": {
        const p = completeSchema.safeParse(body);
        if (!p.success) return NextResponse.json({ error: p.error.issues[0]?.message ?? "bad request" }, { status: 400 });
        const r = await completeTechWorkerRun(worker, p.data);
        if ("error" in r) return NextResponse.json(r, { status: FENCE_ERRORS.has(r.error) ? 409 : 422 });
        return NextResponse.json(r);
      }
      default:
        return NextResponse.json({ error: "unknown op" }, { status: 404 });
    }
  } catch (e) {
    // Không in khoá, không in thân gói — chỉ loại lỗi.
    console.error("[tech-worker-api]", op, e instanceof Error ? e.message : "lỗi");
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
