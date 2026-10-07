import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { clientIpFrom } from "@/lib/auth/client-ip";
import { TECH_GATE_RESULTS, TECH_OWNER_ESCALATIONS } from "@/lib/constants/tech";
import { TECH_LEASE, TECH_RUN_OUTCOMES } from "@/lib/constants/tech-worker";
import { issueWorkerPushToken, recordWorkerDiagnostics, takeWorkerRepair } from "@/lib/tech/worker-onboarding";
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
 *   POST /api/tech/worker/push-credential — token đẩy nhánh NGẮN HẠN cho đúng lượt đang giữ (mục 15)
 *
 * (`POST /api/tech/worker/enroll` là route RIÊNG, không cần khoá worker — bộ cài đổi mã ghi danh lấy khoá.)
 *
 * Nhịp tim mang kèm (tuỳ chọn) BÁO CÁO TỰ KIỂM — máy chủ lọc + che trước khi lưu — và nhận về (tuỳ chọn) MỘT lệnh
 * sửa trong danh sách ĐÓNG `TECH_REPAIR_COMMANDS`.
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
    /** Báo cáo tự kiểm — hình dạng do `sanitizeWorkerDiagnostics` quyết (lọc + che + trần 4 KB); ở đây chỉ chặn cỡ thô. */
    diagnostics: z.record(z.string(), z.unknown()).optional(),
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
const FENCE_ERRORS = new Set(["RUN_NOT_YOURS", "RUN_CLOSED", "STALE_LEASE", "BRANCH_MISMATCH", "WORKER_DISABLED"]);

/**
 * Trần lượt gọi theo worker (review 07/10, mục 18): 120 lượt / phút là gấp ~30 lần nhịp bình thường (nhịp tim 30″ +
 * xin việc 60″). Trong bộ nhớ tiến trình — đủ cho một máy chủ ERP; vượt trần ⇒ 429, không chạm CSDL thêm.
 */
const TRAN_PHUT = 120;
const LUOT = new Map<string, { phut: number; n: number }>();
/**
 * Đếm (hoặc chỉ XEM khi `tang = false`) một ngăn trong phút hiện tại; trả `true` khi ngăn đã vượt trần. Ngăn chỉ sinh
 * ra từ IP (lượt xác thực HỎNG) và id worker ĐÃ xác thực — không còn từ chuỗi do người gọi tự khai, nên bảng không phình
 * theo id ngẫu nhiên; vẫn dọn phút cũ cho chắc (review 07/10, mục B).
 */
function quaTran(id: string, tang = true): boolean {
  const phut = Math.floor(Date.now() / 60_000);
  if (LUOT.size > 1000) for (const [k, v] of LUOT) if (v.phut !== phut) LUOT.delete(k);
  const c = LUOT.get(id);
  if (!c || c.phut !== phut) {
    if (tang) LUOT.set(id, { phut, n: 1 });
    return false;
  }
  if (tang) c.n += 1;
  return c.n > TRAN_PHUT;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ op: string }> }) {
  const { op } = await ctx.params;
  // Trần TRƯỚC khi tra CSDL, theo IP do Caddy ghi (`clientIpFrom`) và CHỈ đếm lượt xác thực HỎNG: người biết id của
  // một worker gửi khoá sai từ máy khác không làm worker thật bị 429 (review 07/10, mục B).
  const auth = req.headers.get("authorization");
  const nganSai = `sai:${clientIpFrom(req.headers.get("x-forwarded-for"))}`;
  if (quaTran(nganSai, false)) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  const worker = await authenticateTechWorker(auth);
  if (!worker) {
    quaTran(nganSai);
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // Ngăn của khoá ĐÃ xác thực — chỉ chính worker đó chạm tới được.
  if (quaTran(`ok:${worker.id}`)) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

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
        if (p.data.diagnostics && JSON.stringify(p.data.diagnostics).length > 16_384) return NextResponse.json({ error: "diagnostics too large" }, { status: 413 });
        const hb = await techWorkerHeartbeat(worker, p.data);
        if (p.data.diagnostics) await recordWorkerDiagnostics(worker.id, p.data.diagnostics);
        const repair = await takeWorkerRepair(worker.id);
        return NextResponse.json(repair ? { ...hb, repair } : hb);
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
      case "push-credential": {
        const p = z.object(fence).strict().safeParse(body);
        if (!p.success) return NextResponse.json({ error: p.error.issues[0]?.message ?? "bad request" }, { status: 400 });
        const r = await issueWorkerPushToken(worker, p.data);
        if ("error" in r) return NextResponse.json(r, { status: r.error === "NOT_CONFIGURED" ? 503 : FENCE_ERRORS.has(r.error) ? 409 : 422 });
        // Token NGẮN HẠN trong thân phản hồi — không ghi nhật ký, không cache.
        return NextResponse.json(r, { headers: { "cache-control": "no-store" } });
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
