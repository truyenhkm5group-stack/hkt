import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { secretEquals } from "@/lib/auth/secret-compare";
import { AGENT_INGEST, EXTERNAL_REF_PATTERN, INGESTABLE_STATUSES, ingestAllowed, recordIngest, reportIsFresh } from "@/lib/constants/agent-ingest";
import { TECH_GATE_RESULTS } from "@/lib/constants/tech";
import { env } from "@/lib/env";
import { ingestAgentRun } from "@/lib/tech/agent-run-ingest";

export const dynamic = "force-dynamic";

/**
 * ═══════════ CỬA HẸP: MÁY GITHUB ACTIONS CHÉP SỔ LƯỢT CHẠY AGENT VỀ PRODUCTION ═══════════
 *
 * Phương án B của chủ shop, nguyên văn nguyên tắc: *"code chưa qua review không được chạy cạnh DB
 * production"*. Runner agent vì thế ở lại máy Actions và KHÔNG nối tới PostgreSQL. Hệ quả đo được
 * trước khi có cửa này: `/tech/agents` hiện **12/12 vai "0 lượt chạy"** trong khi `agent-run.yml`
 * đã chạy thành công nhiều lượt — sổ và runner ở hai máy không nhìn thấy nhau.
 *
 * Cửa này là chỗ duy nhất chúng gặp nhau, và nó hẹp tới mức nhàm chán **có chủ ý**:
 *
 *  · **KHÔNG nhận tên bảng, tên cột, mệnh đề `where`, hay bất kỳ mảnh SQL nào.** Lược đồ dưới đây
 *    là `.strict()`: một trường lạ làm cả gói tin bị từ chối, chứ không bị bỏ qua im lặng. Một cửa
 *    "hẹp" mà lờ đi trường nó không hiểu sẽ rộng dần theo mỗi người gọi.
 *  · **Một thao tác duy nhất: chép lại một lượt chạy ĐÃ KẾT THÚC.** Không `start`, không
 *    `heartbeat`, không `finish` — lý do đầy đủ ở `lib/constants/agent-ingest.ts`.
 *  · **Chỉ TẠO, không SỬA.** Gọi lại cùng khoá ⇒ trả về dòng cũ. Không có đường viết lại lịch sử.
 *  · **Không đụng một dòng dữ liệu nghiệp vụ nào** — đơn hàng, vận đơn, tiền, tồn kho đều nằm
 *    ngoài tầm với của nó. Nó ghi đúng một bảng: `tech_agent_runs`.
 *
 * ─── XÁC THỰC ĐÓNG-KHI-THIẾU ───
 *
 * Chỉ khoá qua header, không có đường phiên đăng nhập, không nhận bí mật trên URL (URL nằm trong
 * access log của Caddy và log proxy — cùng bài học với `/api/sync/[job]`). Khoá chính là
 * `AGENT_INGEST_SECRET`, RIÊNG của cửa này; `CRON_SECRET` chỉ là đường lùi cho máy chủ chưa kịp
 * khai khoá riêng. Chưa khai khoá nào thì cửa ĐÓNG, không phải mở toang — xem `duocPhep()`.
 */

const gateSchema = z.enum(TECH_GATE_RESULTS);

const bodySchema = z
  .object({
    /*
      Khoá tự nhiên `provider:runId:attempt`. Người gọi dựng nó bằng `agentRunExternalRef()`; ở đây
      kiểm lại HÌNH DẠNG vì máy chủ không được tin người gọi đã gọi đúng hàm.
    */
    externalRef: z.string().regex(EXTERNAL_REF_PATTERN, "external_ref phải có dạng provider:runId:attempt"),
    agentKey: z.string().min(1).max(64),
    taskCode: z.string().max(64).optional(),
    status: z.enum(INGESTABLE_STATUSES),
    branch: z.string().max(255).optional(),
    baseCommit: z.string().max(64).optional(),
    resultCommit: z.string().max(64).optional(),
    summary: z.string().max(8000).optional(),
    error: z.string().max(8000).optional(),
    testsRun: z.string().max(8000).optional(),
    gates: z.object({ typecheck: gateSchema.optional(), lint: gateSchema.optional(), test: gateSchema.optional(), build: gateSchema.optional() }).strict().optional(),
    filesChanged: z.array(z.string().max(500)).max(AGENT_INGEST.maxFilesChanged).optional(),
    startedAt: z.string().datetime().optional(),
    endedAt: z.string().datetime().optional(),
    externalUrl: z.string().url().max(500).optional(),
  })
  .strict();

/**
 * KHOÁ RIÊNG TRƯỚC, KHOÁ LẬP LỊCH SAU — VÀ CẢ HAI ĐỀU ĐÓNG-KHI-THIẾU.
 *
 * `AGENT_INGEST_SECRET` dành riêng cho cửa này: bán kính thiệt hại của nó đúng bằng MỘT bảng quan
 * sát. `CRON_SECRET` vẫn được nhận, nhưng chỉ như đường lùi — nó mở được cả bộ lập lịch, nên dùng
 * nó ở một cửa hướng ra Internet là trả giá đắt hơn nhiều so với thứ cửa này cần.
 *
 * Hai lượt so LUÔN chạy đủ, KHÔNG ngắn mạch ở vế đầu: thời gian trả lời không được phép tiết lộ
 * máy chủ đang khai khoá nào.
 */
function duocPhep(given: string | undefined): boolean {
  const rieng = secretEquals(given, env.agentIngestSecret);
  const lapLich = secretEquals(given, env.cronSecret);
  return rieng || lapLich;
}

export async function POST(request: NextRequest) {
  const given = request.headers.get("x-cron-secret") ?? request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!duocPhep(given)) {
    return NextResponse.json({ error: "Không có quyền" }, { status: 401 });
  }

  /*
    ĐỌC THÂN GÓI TIN CÓ TRẦN.

    `content-length` chỉ là LỜI KHAI của người gọi — chặn theo nó là chặn được người gọi trung
    thực. Nên đọc ra văn bản rồi đo ĐỘ DÀI THẬT (theo byte UTF-8, vì `.length` của chuỗi JS đếm
    đơn vị UTF-16 và một thân toàn tiếng Việt sẽ lọt trần).
  */
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return NextResponse.json({ error: "Không đọc được thân gói tin" }, { status: 400 });
  }
  if (Buffer.byteLength(raw, "utf8") > AGENT_INGEST.maxBodyBytes) {
    return NextResponse.json({ error: `Thân gói tin vượt ${AGENT_INGEST.maxBodyBytes} byte` }, { status: 413 });
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Thân gói tin không phải JSON hợp lệ" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Gói tin sai lược đồ", issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, { status: 400 });
  }
  const body = parsed.data;

  /*
    TRẦN LƯỢT GỌI ĐẶT SAU XÁC THỰC.

    Đặt trước thì một người lạ không có bí mật vẫn làm cạn quota của người gọi thật. Khoá đếm là
    hằng số vì người gọi hợp lệ chỉ có một (workflow `agent-run.yml`, có `concurrency`).
  */
  const gate = ingestAllowed("agent-run-ingest");
  if (!gate.ok) {
    return NextResponse.json({ error: "Quá nhiều lượt gọi", retryAfterSec: gate.retryAfterSec }, { status: 429, headers: { "retry-after": String(gate.retryAfterSec) } });
  }

  const endedAt = body.endedAt ? new Date(body.endedAt) : new Date();
  if (!reportIsFresh(endedAt)) {
    return NextResponse.json({ error: `Báo cáo cũ hơn ${AGENT_INGEST.maxAgeMinutes} phút — từ chối`, code: "STALE_REPORT" }, { status: 400 });
  }

  recordIngest("agent-run-ingest");

  const result = await ingestAgentRun({
    externalRef: body.externalRef,
    agentKey: body.agentKey,
    taskCode: body.taskCode,
    status: body.status,
    branch: body.branch,
    baseCommit: body.baseCommit,
    resultCommit: body.resultCommit,
    summary: body.summary,
    error: body.error,
    testsRun: body.testsRun,
    gates: body.gates,
    filesChanged: body.filesChanged,
    startedAt: body.startedAt ? new Date(body.startedAt) : undefined,
    endedAt,
    externalUrl: body.externalUrl,
  });

  if ("error" in result) {
    /*
      PHÂN BIỆT "NGƯỜI GỌI KHAI SAI" VỚI "MÁY CHỦ GHI HỎNG".

      Gộp cả hai thành 500 làm người vận hành đi sửa nhầm chỗ: khai sai mã việc thì sửa ở workflow,
      còn ghi hỏng thì phải xem máy chủ. Cùng bài học với luật 55.
    */
    const status = result.code === "WRITE_FAILED" ? 500 : 400;
    return NextResponse.json({ error: result.error, code: result.code }, { status });
  }

  // `created: false` KHÔNG phải lỗi — đó là chống phát lại đang làm đúng việc. 200 (không phải 201)
  // để người gọi phân biệt được bằng mã trạng thái mà không cần đọc thân.
  return NextResponse.json(result, { status: result.created ? 201 : 200 });
}
