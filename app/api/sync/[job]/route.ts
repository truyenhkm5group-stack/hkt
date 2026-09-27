import { NextResponse, type NextRequest } from "next/server";
import { secretEquals } from "@/lib/auth/secret-compare";
import { can, getCurrentUser } from "@/lib/auth/session";
import { env } from "@/lib/env";
import { JOB_DEFINITIONS, runJob } from "@/lib/sync/jobs";
import { isJobRunning, jobLockKey } from "@/lib/sync/runner";
import { currentOrganization } from "@/lib/platform/context";
import { findOrganization } from "@/lib/platform/organizations";
import { ORGANIZATION_CODE_PATTERN } from "@/lib/platform/types";

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

/**
 * ═══════ `?org=<mã>` — NGOẠI LỆ DUY NHẤT ĐƯỢC ĐỔI NGỮ CẢNH TỪ THAM SỐ (hợp đồng mục 3) ═══════
 *
 * Chỉ nhận SAU khi đã xác thực bằng `CRON_SECRET` (bí mật của NỀN TẢNG, không của khách). Phiên
 * người dùng gửi `?org` ⇒ 403: người dùng chỉ chạy job của tổ chức trong phiên mình, nếu không một
 * người của tổ chức B sửa URL là chạy được job GHI hàng loạt cho tổ chức A. Mã sai ⇒ trả lỗi rõ
 * ràng, KHÔNG rơi về nhà. Không có `?org` ⇒ ngữ cảnh hiện hành: bộ lập lịch (không phiên) ⇒ nhà,
 * y như trước nền tảng; người bấm ⇒ tổ chức trong phiên của họ.
 */
async function resolveJobOrganization(request: NextRequest, trigger: "CRON" | "MANUAL"): Promise<{ code: string; isHome: boolean } | NextResponse> {
  const requested = request.nextUrl.searchParams.get("org");
  if (requested === null) return currentOrganization();
  if (trigger !== "CRON") return NextResponse.json({ error: "Tham số org chỉ dành cho bộ lập lịch (xác thực bằng CRON_SECRET)" }, { status: 403 });
  if (!ORGANIZATION_CODE_PATTERN.test(requested)) return NextResponse.json({ error: `Mã tổ chức "${requested}" không hợp lệ` }, { status: 400 });
  const org = await findOrganization(requested);
  if (!org) return NextResponse.json({ error: `Không có tổ chức "${requested}"` }, { status: 404 });
  if (org.status !== "ACTIVE") return NextResponse.json({ ok: false, skipped: true, error: `Tổ chức "${requested}" đang ${org.status} — không chạy job` }, { status: 409 });
  return org;
}

async function handle(request: NextRequest, context: { params: Promise<{ job: string }> }) {
  const auth = await authorize(request);
  if (!auth) return NextResponse.json({ error: "Không có quyền" }, { status: 401 });
  const { job } = await context.params;
  if (!JOB_DEFINITIONS[job]) return NextResponse.json({ error: `Không có job ${job}`, jobs: Object.keys(JOB_DEFINITIONS) }, { status: 404 });

  const org = await resolveJobOrganization(request, auth.trigger);
  if (org instanceof NextResponse) return org;

  const params: Record<string, string | undefined> = {};
  request.nextUrl.searchParams.forEach((value, key) => {
    // `org` là địa chỉ của lượt chạy, không phải tham số nghiệp vụ của job.
    if (key !== "org") params[key] = value;
  });
  const wait = params.wait !== "0";
  const wantsWrite = WRITE_PARAMS.some((k) => params[k] && params[k] !== "0");
  if (wantsWrite && auth.trigger === "MANUAL" && !(auth.session && can(auth.session, "settings:manage"))) {
    return NextResponse.json({ error: "Job ghi dữ liệu hàng loạt cần quyền quản trị cấu hình" }, { status: 403 });
  }

  // Lá chắn "job đang chạy" chỉ được bỏ qua khi có THAM SỐ NGHIỆP VỤ (backfill, days…), không phải vì
  // có `wait=0` — trước đây scheduler gọi với `?wait=0` nên chưa bao giờ được lá chắn này bảo vệ.
  const businessParams = [...request.nextUrl.searchParams.keys()].filter((k) => k !== "wait" && k !== "org");
  const source = JOB_DEFINITIONS[job].source;
  /*
    Khoá hỏi THEO TỔ CHỨC (ISO-12). Lưu ý đã biết, CHƯA sửa vì sửa là đổi hành vi: lá chắn hỏi theo
    SLUG (`PANCAKE:pancake-orders`) còn runner khoá theo tên job NỘI BỘ (`PANCAKE:orders_incremental`,
    xem `JOB_RUN_KEYS`), nên lá chắn gần như không bao giờ khớp — `runSyncJob` tự chặn bên trong.
  */
  if (source !== "ALL" && businessParams.length === 0 && isJobRunning(jobLockKey(org, source, job))) {
    return NextResponse.json({ ok: false, running: true, message: "Job đang chạy" }, { status: 202 });
  }

  // `runJob` tự bọc `withOrganization(org)` — lượt bỏ rơi của `?wait=0` vẫn mang đúng tổ chức (ISO-16).
  const promise = runJob(job, { trigger: auth.trigger, actor: auth.actor, params, org: org.code });
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
