import { and, desc, eq, gte, ne } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { resolveProviderName } from "@/lib/ai/router";
import { AI_INCIDENT_RULE, aiIncidentTitle, aiIncidentViecPhaiLam, shouldOpenAiIncident } from "@/lib/constants/ai-incidents";
import { AI_SELFTEST_ROUTE } from "@/lib/constants/ai-selftest";
import { runSyncJob, type SyncTrigger } from "@/lib/sync/runner";
import { createTechIncident } from "@/lib/tech/service";

/**
 * ═══════════ KHOÁ AI HỎNG → `tech_incidents` — MÁY PHÁT HIỆN, NGƯỜI ĐÓNG ═══════════
 *
 * ─── VÌ SAO CÓ TỆP NÀY ───
 *
 * 20/09/2026 lúc 21:48, lượt chạy agent thứ 10 dừng với *"Your credit balance is too low"*. Không
 * màn hình nào báo: `tech-incident-watch` chỉ nhìn `sync_runs`, còn thẻ sức khoẻ AI chỉ biết sau
 * khi đã có người dùng đâm vào tường. Một sự cố kiểu "cần người trả tiền" mà phải chờ người dùng
 * phát hiện hộ là đúng thứ một phòng Tech tự động sinh ra để tránh.
 *
 * ─── CHỈ MỞ, KHÔNG BAO GIỜ ĐÓNG ───
 *
 * Cùng luật với `sync-incident-watch`: một lượt gọi thành công KHÔNG chứng minh credit đã được
 * nạp — có thể chỉ là một lượt rơi vào hạn mức miễn phí. Và ràng buộc của kho đòi một câu ĐÃ LÀM
 * GÌ trước khi đóng; máy không có câu đó nên nếu tự đóng thì nó phải bịa.
 *
 * ─── KHÔNG ĐẾM LƯỢT TỰ KIỂM ───
 *
 * `ops ai-check` CỐ Ý gây lỗi để chứng minh "lỗi có để lại dấu vết" (xem `lib/constants/ai-selftest.ts`).
 * Đếm chúng là mở sự cố cho chính lượt kiểm tra — bộ canh sẽ kêu mỗi lần ai đó chạy tự kiểm, và
 * người trực học cách bỏ qua nó.
 */

export type AiIncidentWatchResult = {
  provider: string | null;
  /** Số lượt gọi THẬT (đã bỏ lượt tự kiểm) xét trong cửa sổ. */
  luotXet: number;
  opened: number;
  /** Đã có sự cố chưa đóng mang đúng khoá này ⇒ KHÔNG mở thêm. Không phải lỗi. */
  alreadyOpen: number;
  reason: string;
};

export async function watchAiProviderHealth(opts: { lookbackHours?: number } = {}): Promise<AiIncidentWatchResult> {
  const provider = resolveProviderName();
  /*
    CHƯA CẤU HÌNH NHÀ CUNG CẤP NÀO ⇒ KHÔNG PHẢI SỰ CỐ.
    "AI tắt" là một lựa chọn hợp lệ; mở sự cố cho nó là kêu về một thứ đang đúng ý chủ shop.
  */
  if (!provider) return { provider: null, luotXet: 0, opened: 0, alreadyOpen: 0, reason: "Chưa cấu hình nhà cung cấp AI — không phải sự cố, là chưa bật." };

  const db = await getDb();
  const gio = Math.max(1, opts.lookbackHours ?? AI_INCIDENT_RULE.lookbackHours);
  const tu = new Date(Date.now() - gio * 3_600_000);

  const rows = await db.query.aiInteractions.findMany({
    where: and(
      gte(schema.aiInteractions.createdAt, tu),
      // Lượt tự kiểm KHÔNG được tính — xem khối trên.
      ne(schema.aiInteractions.route, AI_SELFTEST_ROUTE),
      // Chỉ nhà cung cấp ĐANG dùng: lỗi của một nhà cung cấp đã bỏ không nói gì về nhà cung cấp này.
      // (so sánh ở tầng ứng dụng để cột `provider` giữ nguyên chữ thường/hoa như driver ghi)
    ),
    orderBy: [desc(schema.aiInteractions.createdAt)],
    columns: { provider: true, status: true, error: true },
    limit: 200,
  });
  const cuaProvider = rows.filter((r) => r.provider === provider);

  const phan = shouldOpenAiIncident(cuaProvider.map((r) => ({ status: r.status, error: r.error })));
  if (!phan.open) return { provider, luotXet: cuaProvider.length, opened: 0, alreadyOpen: 0, reason: phan.reason };

  const title = aiIncidentTitle(provider, phan.lop);
  /* Tiêu đề là KHOÁ TỰ NHIÊN của sự cố này — chạy lại bộ canh không được đẻ ra sự cố thứ hai. */
  const dangMo = await db.query.techIncidents.findFirst({
    where: and(eq(schema.techIncidents.title, title), ne(schema.techIncidents.status, "RESOLVED")),
    columns: { id: true },
  });
  if (dangMo) return { provider, luotXet: cuaProvider.length, opened: 0, alreadyOpen: 1, reason: `Đã có sự cố đang mở: ${title}` };

  const bangChung = [
    `${phan.soLuot} lượt gọi ${provider} hỏng LIÊN TIẾP trong ${gio} giờ gần đây (ngưỡng: ${AI_INCIDENT_RULE.consecutiveErrors}).`,
    `Lớp lỗi: ${phan.lop} — lớp này KHÔNG tự khỏi.`,
    `Lỗi gần nhất: ${phan.viDu || "(không có câu lỗi)"}`,
    "",
    `VIỆC PHẢI LÀM: ${aiIncidentViecPhaiLam(phan.lop, provider)}`,
    "",
    `Tra lại: select created_at, provider, status, left(error, 200) from ai_interactions where route <> '${AI_SELFTEST_ROUTE}' order by created_at desc limit 20;`,
  ].join("\n");

  const res = await createTechIncident(
    { title, severity: AI_INCIDENT_RULE.severity, module: "PLATFORM", source: "MONITOR", evidence: bangChung },
    { kind: "SYSTEM", id: null, name: "job:ai-incident-watch" },
  );
  if ("error" in res) return { provider, luotXet: cuaProvider.length, opened: 0, alreadyOpen: 0, reason: `Không mở được sự cố: ${res.error}` };
  return { provider, luotXet: cuaProvider.length, opened: 1, alreadyOpen: 0, reason: `Đã mở sự cố: ${title}` };
}

/**
 * Bọc thành một job có sổ, để nó xuất hiện ở trang Kết nối dữ liệu như mọi job khác.
 *
 * `warning` bật khi ĐANG có sự cố — không có dòng ấy thì lượt chạy ghi SUCCESS kèm một con số, và
 * màn hình hiện dấu xanh cho đúng cái lượt vừa phát hiện AI đã chết.
 */
export async function runAiIncidentWatch(opts: { trigger: SyncTrigger; actor: string; hours?: number }) {
  return runSyncJob({ source: "ERP", job: "ai-incident-watch", trigger: opts.trigger, actor: opts.actor }, async (ctx) => {
    const r = await watchAiProviderHealth({ lookbackHours: opts.hours });
    ctx.summary.imported = r.opened;
    ctx.summary.skipped = r.alreadyOpen;
    ctx.summary.detail = `${r.provider ?? "(chưa cấu hình)"} · xét ${r.luotXet} lượt gọi thật · ${r.reason}`;
    if (r.opened || r.alreadyOpen) ctx.summary.warning = r.reason;
    return r;
  });
}
