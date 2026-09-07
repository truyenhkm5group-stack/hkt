import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { env } from "@/lib/env";
import { MAX_LIST_BASE64, MAX_LIST_FILES } from "@/lib/constants/cod";
import { runVtpDataFileImport } from "@/lib/integrations/viettelpost/import-run";
import { clearMemo } from "@/lib/cache";

export const dynamic = "force-dynamic";

/**
 * NHẬN TỆP BẢNG KÊ VIETTEL POST TỪ HỘP THƯ.
 *
 * Viettel Post tự gửi thư "BẢNG KÊ ĐỐI SOÁT THANH TOÁN" kèm tệp BangKeChiCOD….xlsx về Gmail của
 * shop. Trước đây chủ shop phải tải tay rồi tải lên ERP, nên bảng kê hay bị nhập trễ hoặc bỏ sót
 * — mà thiếu bảng kê thì không biết tiền COD nào đã thực về.
 *
 * Một đoạn Apps Script chạy trong chính Gmail của shop (xem `docs/GMAIL-BANG-KE-VTP.md`) tìm thư
 * của Viettel Post, lấy tệp đính kèm rồi POST sang đây. Cách này KHÔNG bắt ERP giữ mật khẩu hộp
 * thư: script chạy dưới tài khoản của chủ shop và tắt được bất cứ lúc nào.
 *
 * Xác thực bằng đúng tham số bí mật của webhook Viettel Post (đổi được bằng ops
 * `rotate-webhook-secrets`), nên không phát sinh thêm khoá cần quản lý.
 *
 * Idempotent: gửi lại cùng một tệp không nhân đôi số liệu — lõi nhập đã chống trùng theo mã vận
 * đơn và mã bảng kê, và chỉ NÂNG trạng thái COD chứ không hạ.
 */
const bodySchema = z.object({
  files: z
    .array(
      z.object({
        filename: z.string().trim().min(1).max(300),
        base64: z.string().min(1).max(MAX_LIST_BASE64),
      }),
    )
    .min(1, "Không có tệp nào")
    .max(MAX_LIST_FILES),
  source: z.string().trim().max(120).optional(),
});

function secretsFrom(request: NextRequest, body: Record<string, unknown>) {
  const auth = request.headers.get("authorization") ?? "";
  return [
    typeof body.token === "string" ? body.token : "",
    typeof body.TOKEN === "string" ? body.TOKEN : "",
    request.headers.get("x-webhook-secret") ?? "",
    request.headers.get("x-token") ?? "",
    auth.replace(/^(Bearer|Token)\s+/i, ""),
    request.nextUrl.searchParams.get("secret") ?? "",
    request.nextUrl.searchParams.get("token") ?? "",
  ].filter(Boolean);
}

export async function POST(request: NextRequest) {
  const expected = env.viettelPost.webhookSecret;
  if (!expected) return NextResponse.json({ ok: false, error: "Chưa cấu hình tham số bí mật webhook" }, { status: 503 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "Body không phải JSON" }, { status: 400 });
  }
  if (!secretsFrom(request, body).includes(expected)) {
    console.warn(`[vtp-statement] 401 sai tham số bí mật · ua=${request.headers.get("user-agent") ?? "?"}`);
    return NextResponse.json({ ok: false, error: "Sai tham số bí mật" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" }, { status: 400 });
  }

  const actor = `GMAIL:${parsed.data.source || "viettelpost"}`;
  const db = await getDb();
  const [run] = await db
    .insert(schema.syncRuns)
    .values({ source: "VIETTELPOST", job: "vtp-statement-mail", status: "RUNNING", trigger: "WEBHOOK", actor })
    .returning({ id: schema.syncRuns.id });

  try {
    const result = await runVtpDataFileImport(parsed.data.files, actor);
    const imported = result.files.filter((f) => f.kind !== "ERROR").length;
    const failed = result.files.filter((f) => f.kind === "ERROR");
    await db
      .update(schema.syncRuns)
      .set({
        status: failed.length && !imported ? "FAILED" : failed.length ? "PARTIAL" : "SUCCESS",
        imported,
        failed: failed.length,
        finishedAt: new Date(),
        error: failed.length ? failed.map((f) => `${f.filename}: ${f.note}`).join(" · ").slice(0, 900) : null,
        detail: JSON.stringify(result).slice(0, 4000),
      })
      .where(eq(schema.syncRuns.id, run.id));
    clearMemo();
    const body = { ok: imported > 0, imported, failed: failed.length, files: result.files.map((f) => ({ filename: f.filename, kind: f.kind, rows: f.rows, applied: f.applied, note: f.note })) };
    // KHÔNG được trả 200 khi không nhập được tệp nào. Script trong Gmail chỉ gắn nhãn
    // "đã nhập" khi nhận HTTP 200; trả 200 cho một lượt hỏng sạch khiến thư bị đánh dấu xong
    // và KHÔNG BAO GIỜ gửi lại — đúng chuyện đã xảy ra: 11 lượt hỏng mà không lượt nào thử lại.
    return NextResponse.json(body, { status: imported > 0 ? 200 : 422 });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Lỗi không rõ";
    await db.update(schema.syncRuns).set({ status: "FAILED", error: message.slice(0, 900), finishedAt: new Date() }).where(eq(schema.syncRuns.id, run.id));
    // Trả 500 để Apps Script biết mà thử lại lần chạy sau; tệp chưa được nhập nên không mất dữ liệu.
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
