import { NextResponse, type NextRequest } from "next/server";
import { can, getCurrentUser } from "@/lib/auth/session";
import { env } from "@/lib/env";
import { JOB_DEFINITIONS, runJob } from "@/lib/sync/jobs";
import { isJobRunning } from "@/lib/sync/runner";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function authorize(request: NextRequest) {
  const header = request.headers.get("x-cron-secret") ?? request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? request.nextUrl.searchParams.get("secret");
  if (env.cronSecret && header && header === env.cronSecret) return { actor: "scheduler", trigger: "CRON" as const };
  const session = await getCurrentUser();
  if (session && can(session, "sync:run")) return { actor: session.email, trigger: "MANUAL" as const };
  return null;
}

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

  const source = JOB_DEFINITIONS[job].source;
  if (source !== "ALL" && [...request.nextUrl.searchParams.keys()].length === 0 && isJobRunning(`${source}:${job}`)) {
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

export const POST = handle;
export const GET = handle;
