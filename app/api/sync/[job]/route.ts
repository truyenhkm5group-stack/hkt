import { NextResponse, type NextRequest } from "next/server";
import { secretEquals } from "@/lib/auth/secret-compare";
import { can, getCurrentUser } from "@/lib/auth/session";
import { env } from "@/lib/env";
import { JOB_DEFINITIONS, runJob } from "@/lib/sync/jobs";
import { isJobRunning } from "@/lib/sync/runner";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Bí mật cron CHỈ nhận qua header. Trước đây còn nhận `?secret=` trên URL: URL nằm trong access log
 * của Caddy, log của proxy và lịch sử trình duyệt — một bí mật in vào ba chỗ không còn là bí mật.
 * scripts/scheduler.mjs và mọi nút bấm trong ERP đều đã gọi bằng POST + header từ lâu.
 */
async function authorize(request: NextRequest) {
  const header = request.headers.get("x-cron-secret") ?? request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (secretEquals(header, env.cronSecret)) return { actor: "scheduler", trigger: "CRON" as const, session: null };
  const session = await getCurrentUser();
  if (session && can(session, "sync:run")) return { actor: session.email, trigger: "MANUAL" as const, session };
  return null;
}

/**
 * Tham số làm job GHI HÀNG LOẠT (`data-check?fix=1`, `--apply`…) — AGENTS.md mục 7 xếp chúng vào việc
 * phải hỏi chủ shop. `sync:run` nằm trong mẫu quyền của MANAGER/LEADER, nên không thể để một cú bấm
 * của họ chạy nhánh sửa dữ liệu; đường thủ công đòi thêm `settings:manage`.
 */
const WRITE_PARAMS = ["fix", "apply"] as const;

async function handle(request: NextRequest, context: { params: Promise<{ job: string }> }) {
  const auth = await authorize(request);
  if (!auth) return NextResponse.json({ error: "Không có quyền" }, { status: 401 });
  const { job } = await context.params;
  if (!JOB_DEFINITIONS[job]) return NextResponse.json({ error: `Không có job ${job}`, jobs: Object.keys(JOB_DEFINITIONS) }, { status: 404 });

  const params: Record<string, string | undefined> = {};
  request.nextUrl.searchParams.forEach((value, key) => {
    params[key] = value;
  });
  const wait = params.wait !== "0";
  const wantsWrite = WRITE_PARAMS.some((k) => params[k] && params[k] !== "0");
  if (wantsWrite && auth.trigger === "MANUAL" && !(auth.session && can(auth.session, "settings:manage"))) {
    return NextResponse.json({ error: "Job ghi dữ liệu hàng loạt cần quyền quản trị cấu hình" }, { status: 403 });
  }

  // Lá chắn "job đang chạy" chỉ được bỏ qua khi có THAM SỐ NGHIỆP VỤ (backfill, days…), không phải vì
  // có `wait=0` — trước đây scheduler gọi với `?wait=0` nên chưa bao giờ được lá chắn này bảo vệ.
  const businessParams = [...request.nextUrl.searchParams.keys()].filter((k) => k !== "wait");
  const source = JOB_DEFINITIONS[job].source;
  if (source !== "ALL" && businessParams.length === 0 && isJobRunning(`${source}:${job}`)) {
    return NextResponse.json({ ok: false, running: true, message: "Job đang chạy" }, { status: 202 });
  }

  const promise = runJob(job, { trigger: auth.trigger, actor: auth.actor, params });
  if (!wait) {
    promise.catch((error) => console.error(`[sync:${job}]`, error));
    return NextResponse.json({ ok: true, started: true, job });
  }
  try {
    const result = await promise;
    return NextResponse.json({ ok: true, job, result: safeJson(result) });
  } catch (error) {
    return NextResponse.json({ ok: false, job, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

function safeJson(value: unknown) {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

// Chỉ POST: một link GET bấm nhầm (hoặc bị nhúng vào trang khác) không được phép khởi động job.
export const POST = handle;
