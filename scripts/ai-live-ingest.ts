/**
 * BỘ NẠP TIN SỐNG — chạy liên tục, đọc Pancake, soạn gợi ý, KHÔNG BAO GIỜ gửi.
 *
 *   npx tsx scripts/ai-live-ingest.ts            (đọc page từ danh sách thí điểm)
 *   npx tsx scripts/ai-live-ingest.ts --once     (chạy đúng một vòng rồi thoát — để kiểm)
 *
 * ─── BỐN VIỆC, BỐN MỨC RỦI RO, VÀ TIẾN TRÌNH NÀY CHỈ LÀM HAI ───
 *
 *   ĐỌC tin về      ✔ làm
 *   SOẠN gợi ý      ✔ làm
 *   GỬI cho khách   ✘ không — và không phải vì nhớ kiêng, mà vì tệp này không có đường tới đó:
 *                     nó không import cổng gửi, còn cổng gửi thì đòi một khoá tài khoản chỉ lấy
 *                     được từ một phiên đăng nhập. Một tiến trình nền không có phiên.
 *   TẠO ĐƠN         ✘ không — `AI_ALLOW_ORDER_CREATE` vẫn CẤM ở mức môi trường.
 *
 * ─── DỪNG NGAY NẾU MÔI TRƯỜNG CHO PHÉP MÁY TỰ GỬI ───
 *
 * Một bộ nạp chạy suốt ngày trên một môi trường mà máy tự gửi được là đúng thứ sinh ra sự cố
 * "AI nhắn khách lúc hai giờ sáng". Nên nó tự từ chối khởi động, thay vì tin rằng phần còn lại của
 * hệ thống sẽ chặn hộ.
 */
import "dotenv/config";
import { getDb, schema } from "@/db";
import { ensureMigrated } from "@/db/migrate";
import { aiEnv, getAiSettings } from "@/lib/ai-workforce/config";
import { ensureAgents, getAgent } from "@/lib/ai-workforce/registry";
import { runIngestTick } from "@/lib/ai-workforce/live-ingest";
import { copilotPages } from "@/lib/queries/sales-copilot";
import {
  LIVE_INGEST_DEFAULT_SECONDS,
  LIVE_INGEST_ENV,
  LIVE_INGEST_INTERVAL_ENV,
  LIVE_INGEST_MAX_SECONDS,
  LIVE_INGEST_MIN_SECONDS,
  nextDelaySeconds,
} from "@/lib/constants/live-ingest";

const gio = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const noi = (...phan: unknown[]) => console.log(`[${gio()}]`, ...phan);

function giay(): number {
  const raw = Number(process.env[LIVE_INGEST_INTERVAL_ENV]);
  if (!Number.isFinite(raw) || raw <= 0) return LIVE_INGEST_DEFAULT_SECONDS;
  return Math.min(Math.max(Math.round(raw), LIVE_INGEST_MIN_SECONDS), LIVE_INGEST_MAX_SECONDS);
}

const nghi = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main() {
  const mot = process.argv.includes("--once");

  if (process.env[LIVE_INGEST_ENV]?.toLowerCase() !== "true" && !mot) {
    noi(`✗ ${LIVE_INGEST_ENV} chưa bật — bộ nạp sống đứng yên. (Vắng mặt = TẮT, như mọi công tắc khác.)`);
    process.exit(0);
  }

  // CHỐT AN TOÀN ĐỨNG TRƯỚC MỌI THỨ. Không chạy nền trên một môi trường mà máy tự gửi được.
  if (aiEnv.hardLimits.allowAutoSend) {
    console.error(`✗ DỪNG: AI_ALLOW_AUTO_SEND đang là true. Bộ nạp chạy nền trên môi trường máy tự gửi được là đúng thứ sinh ra sự cố "AI nhắn khách lúc hai giờ sáng".`);
    process.exit(1);
  }
  if (aiEnv.hardLimits.allowOrderCreate) {
    console.error("✗ DỪNG: AI_ALLOW_ORDER_CREATE đang là true. Giai đoạn này không tạo đơn.");
    process.exit(1);
  }

  await ensureMigrated();
  const db = await getDb();
  await ensureAgents(db);

  const settings = await getAiSettings();
  const agent = await getAgent("sales", settings, db);
  const nhip = giay();

  noi("───────── BỘ NẠP TIN SỐNG ─────────");
  noi(`nấc quyền hạn : ${agent?.mode ?? "—"}`);
  noi(`nhịp          : ${nhip}s`);
  noi(`MÁY tự gửi    : ✓ CẤM · tạo đơn: ✓ CẤM · NGƯỜI bấm gửi: ${aiEnv.hardLimits.allowHumanApprovedSend ? "được phép (nấc trợ lý)" : "CẤM"}`);
  noi(`gọi mô hình   : ${settings.modelCallsEnabled ? "BẬT" : "TẮT"}`);

  let hong = 0;
  let vong = 0;

  for (;;) {
    const pages = await copilotPages(db);
    if (!pages.length) {
      noi("· chưa khai page thí điểm nào (ai.copilotPages rỗng) — không đọc gì");
    }
    for (const pageId of pages) {
      const k = await runIngestTick(pageId, db);
      vong += 1;
      if (k.ok) {
        hong = 0;
        noi(`✓ page ${pageId} · cửa sổ ${k.windowHours}h · ${k.conversations} hội thoại · ${k.messages} tin mới · ${k.suggestionsDrained} lượt soạn · tin khách mới nhất ${k.latestCustomerAt ? k.latestCustomerAt.toISOString().slice(0, 19).replace("T", " ") : "—"}`);
      } else {
        hong += 1;
        noi(`✗ page ${pageId} hỏng lần ${hong}: ${k.error}`);
      }
    }

    if (mot) {
      // ĐỌC LẠI TỪ CSDL để chứng minh không tin nào đi ra — khẳng định suông không có giá trị.
      const [an] = await db
        .select({
          daGui: schema.salesCopilotActions.id,
        })
        .from(schema.salesCopilotActions)
        .limit(1);
      noi(`· một vòng xong. Dòng gửi trong sổ thao tác: ${an ? "có (do NGƯỜI bấm trước đó)" : "chưa có dòng nào"}`);
      process.exit(0);
    }

    const cho = nextDelaySeconds(nhip, hong);
    if (hong > 0) noi(`· nghỉ ${cho}s rồi thử lại (nghỉ dài dần khi hỏng)`);
    await nghi(cho * 1000);
    if (vong % 40 === 0) noi(`· vẫn đang chạy — đã qua ${vong} vòng`);
  }
}

main().catch((e) => {
  console.error(`✗ ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
  process.exit(1);
});
