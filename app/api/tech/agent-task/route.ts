import { NextResponse, type NextRequest } from "next/server";
import { secretEquals } from "@/lib/auth/secret-compare";
import { ingestAllowed, recordIngest } from "@/lib/constants/agent-ingest";
import { env } from "@/lib/env";
import { readAgentTask } from "@/lib/tech/agent-task-read";

export const dynamic = "force-dynamic";

/**
 * ═══════════ CỬA ĐỌC HẸP: MÁY CHẠY AGENT NHẬN ĐÚNG VIỆC ĐƯỢC GIAO ═══════════
 *
 * Đối xứng với cửa GHI `/api/tech/agent-run`, và hẹp theo đúng cách ấy:
 *
 *  · **Chỉ `GET`, chỉ một tham số `code`.** Không nhận tên bảng, không nhận bộ lọc, không phân
 *    trang, không liệt kê. Một cửa đọc liệt kê được là một cửa xuất dữ liệu.
 *  · **Trả về đúng sáu trường** agent cần để làm việc, cộng phạm vi ghi của vai. Không trả "cả
 *    dòng cho tiện" — làm thế là rò rỉ mọi cột được thêm vào bảng sau này, kể cả cột chưa tồn tại
 *    lúc viết cửa này.
 *  · **Chỉ việc được phép giao.** Dùng LẠI `canDispatchTask()`, đúng bộ luật của nút giao việc.
 *    Cửa đọc rộng hơn cổng giao việc thì nó trở thành đường vòng.
 *
 * ─── VÌ SAO THAM SỐ Ở URL Ở ĐÂY LÀ CHẤP NHẬN ĐƯỢC, CÒN BÍ MẬT THÌ KHÔNG ───
 *
 * `/api/sync/[job]` từng nhận bí mật qua `?secret=` và đó là lỗi: URL nằm trong access log của
 * Caddy, log proxy và lịch sử trình duyệt. Ở đây `code` là MÃ VIỆC (`TECH-12`) — không phải bí
 * mật, và nó phải nằm đâu đó. Bí mật vẫn CHỈ đi qua header.
 *
 * ─── VIỆC LẠ VÀ VIỆC KHÔNG ĐƯỢC GIAO TRẢ CÙNG MỘT 404 ───
 *
 * Tầng dịch vụ phân biệt hai ca để log nói được chuyện gì; tầng HTTP thì không. Trả 403 cho "có
 * việc này nhưng chưa duyệt" và 404 cho "không có việc này" là biến cửa thành máy dò: gọi lần
 * lượt `TECH-1…TECH-500` là biết chính xác kho có bao nhiêu việc và việc nào đang chờ duyệt.
 */
export async function GET(request: NextRequest) {
  const given = request.headers.get("x-cron-secret") ?? request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  /*
    Cùng khoá với cửa ghi: đây là khoá của MÁY CHẠY AGENT, và máy ấy cần cả hai chiều. `CRON_SECRET`
    là đường lùi cho máy chủ chưa kịp khai khoá riêng. Hai lượt so LUÔN chạy đủ — thời gian trả lời
    không được tiết lộ máy chủ đang khai khoá nào.
  */
  const rieng = secretEquals(given, env.agentIngestSecret);
  const lapLich = secretEquals(given, env.cronSecret);
  if (!(rieng || lapLich)) return NextResponse.json({ error: "Không có quyền" }, { status: 401 });

  const gate = ingestAllowed("agent-task-read");
  if (!gate.ok) {
    return NextResponse.json({ error: "Quá nhiều lượt gọi", retryAfterSec: gate.retryAfterSec }, { status: 429, headers: { "retry-after": String(gate.retryAfterSec) } });
  }
  recordIngest("agent-task-read");

  const code = (request.nextUrl.searchParams.get("code") ?? "").trim();
  // Hình dạng mã việc là ĐÓNG: `TECH-12`. Không cho chuỗi tuỳ ý đi tới tầng truy vấn.
  if (!/^[A-Z][A-Z0-9]{1,15}-\d{1,9}$/.test(code)) {
    return NextResponse.json({ error: "Mã việc sai hình dạng (ví dụ đúng: TECH-12)." }, { status: 400 });
  }

  const res = await readAgentTask(code);
  if ("error" in res) {
    // MỘT câu trả lời cho cả hai ca — xem khối trên.
    return NextResponse.json({ error: "Không có việc nào giao được với mã này." }, { status: 404 });
  }
  return NextResponse.json({ ok: true, task: res.task });
}
