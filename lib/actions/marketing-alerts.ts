"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { sendLark } from "@/lib/alerts/lark";
import { MARKETING_ALERT_KEY } from "@/lib/constants/marketing-alerts";
import { loadMarketingAlertConfig, runMarketingDigest } from "@/lib/marketing/digest";
import { setSettingJson } from "@/lib/settings";

/**
 * ═══════════ AI NHẬN BẢN TIN MARKETING — CẤU HÌNH TRONG ERP, KHÔNG PHẢI QUA SSH ═══════════
 *
 * Trước tệp này, `settings["marketing.alerts"]` chỉ ghi được bằng ops `set-setting`. Một tính năng
 * chủ shop dùng hằng ngày mà phải mở GitHub Actions mới đổi được người nhận thì trên thực tế nó
 * không được đổi bao giờ.
 *
 * ─── VÌ SAO LƯỢC ĐỒ PHẢI KHAI ĐỦ MỌI KHOÁ ───
 *
 * `z.object()` CẮT BỎ khoá không khai báo. Thiếu một khoá ở đây thì mỗi lần bấm Lưu là nó biến mất
 * khỏi settings, rồi `loadMarketingAlertConfig` trộn lại với mặc định — nên một cờ vừa tắt sẽ âm
 * thầm bật lại mà không có lỗi nào hiện ra. Đúng lớp lỗi mà `configSchema` của cảnh báo vận hành
 * đã ghi lại bằng một sự cố thật (`incomplete`).
 */

const webhook = z
  .string()
  .trim()
  .max(300)
  .refine((v) => !v || /^https:\/\/open\.(larksuite|feishu)\.(com|cn)\/open-apis\/bot\/v2\/hook\//.test(v), "Webhook Lark phải có dạng https://open.larksuite.com/open-apis/bot/v2/hook/…");

const schema = z.object({
  enabled: z.boolean(),
  managerWebhookUrl: webhook.default(""),
  managerSecret: z.string().trim().max(200).default(""),
  perMarketer: z.boolean().default(true),
  digestHour: z.number().int().min(0).max(23).default(9),
  minSeverityToSend: z.enum(["INFO", "WARNING", "CRITICAL"]).default("WARNING"),
  cooldownHours: z.number().int().min(1).max(168).default(12),
  baseUrl: z.string().trim().max(200).default(""),
  recipients: z
    .array(
      z.object({
        marketerId: z.string().trim().min(1).max(100),
        larkWebhookUrl: webhook.default(""),
        larkSecret: z.string().trim().max(200).default(""),
        active: z.boolean().default(true),
      }),
    )
    .max(50)
    .default([]),
});

export async function saveMarketingAlertConfig(input: unknown): Promise<{ ok: true } | { error: string }> {
  const user = await requireUser();
  if (!can(user, "alerts:manage")) return { error: "Không có quyền" };
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };

  // MỘT NGƯỜI MỘT DÒNG: hai dòng cùng `marketerId` thì `digest` lấy dòng đầu và dòng sau im lặng
  // không bao giờ được dùng — người khai tưởng đã đổi webhook trong khi không có gì đổi.
  const ids = parsed.data.recipients.map((r) => r.marketerId);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) return { error: `Marketer "${dup}" bị khai hai lần — mỗi người chỉ một dòng` };

  await setSettingJson(MARKETING_ALERT_KEY, parsed.data);
  /*
    NHẬT KÝ KHÔNG BAO GIỜ MANG KHOÁ KÝ.

    Kho mã này PUBLIC và nhật ký đọc được trên màn hình. Ghi `larkSecret` vào đây là để một khoá gửi
    tin vào nhóm nội bộ nằm trong một bảng ai cũng mở được. Số lượng người nhận thì ghi — đó là thứ
    cần truy khi có người hỏi "vì sao hôm nay tôi không nhận được bản tin".
  */
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "SETTINGS_UPDATE",
    entity: "SETTINGS",
    entityId: MARKETING_ALERT_KEY,
    detail: {
      enabled: parsed.data.enabled,
      perMarketer: parsed.data.perMarketer,
      digestHour: parsed.data.digestHour,
      minSeverityToSend: parsed.data.minSeverityToSend,
      recipients: parsed.data.recipients.map((r) => ({ marketerId: r.marketerId, active: r.active, hasWebhook: Boolean(r.larkWebhookUrl) })),
      managerWebhook: parsed.data.managerWebhookUrl ? "***" : "",
    },
  });
  revalidatePath("/alerts");
  return { ok: true };
}

/** Gửi thử vào nhóm quản lý. Không đụng sổ chống gửi lại, nên không làm mất bản tin thật của hôm nay. */
export async function sendTestMarketingLark(): Promise<{ ok: true } | { error: string }> {
  const user = await requireUser();
  if (!can(user, "alerts:manage")) return { error: "Không có quyền" };
  const cfg = await loadMarketingAlertConfig();
  if (!cfg.managerWebhookUrl) return { error: "Chưa khai webhook nhóm quản lý" };
  const res = await sendLark(cfg.managerWebhookUrl, cfg.managerSecret, "✅ ERP đã kết nối bản tin marketing", [
    [{ text: "Bản tin hiệu quả marketing hằng ngày sẽ gửi vào nhóm này. " }, { text: "Mở báo cáo", href: `${cfg.baseUrl || process.env.APP_URL || ""}/ads/daily` }],
  ]);
  return res.ok ? { ok: true } : { error: res.error ?? "Gửi thất bại" };
}

/**
 * ═══════════ XEM TRƯỚC BẢN TIN — ĐỌC ĐÚNG THỨ SẼ ĐẾN TAY NGƯỜI NHẬN ═══════════
 *
 * Nút "gửi thử" chứng minh webhook còn sống. Nó KHÔNG cho biết bản tin thật nói gì, gửi cho ai, và
 * ai sẽ không nhận — ba câu hỏi phải trả lời được TRƯỚC khi bật một kênh gửi mỗi sáng cho cả đội.
 *
 * Dựng đủ bản tin rồi dừng ngay trước lời gọi Lark: không gửi một tin nào, không chạm sổ chống gửi
 * lại. Nên bấm bao nhiêu lần cũng không làm mất bản tin thật của hôm nay.
 */
export async function previewMarketingDigest(): Promise<{ ok: true; day: string; settledDay: string | null; blocks: { scope: string; title: string; lines: string[]; willSend: boolean; reason: string | null }[] } | { error: string }> {
  const user = await requireUser();
  if (!can(user, "alerts:manage")) return { error: "Không có quyền" };
  const r = await runMarketingDigest(new Date(), { preview: true });
  return { ok: true, day: r.day, settledDay: r.settledDay, blocks: r.preview };
}

/**
 * Chạy bản tin NGAY.
 *
 * Cố ý đi qua đúng hàm mà bộ lập lịch gọi — kể cả sổ chống gửi lại. Một nút "gửi ngay" đi vòng qua
 * sổ ấy sẽ là đường duy nhất trong cả hệ thống gửi được hai bản tin cho cùng một ngày, và nó sẽ bị
 * bấm đúng vào lúc người ta đang thắc mắc vì sao chưa nhận được tin.
 */
export async function runMarketingDigestNow(): Promise<{ ok: true; detail: string } | { error: string }> {
  const user = await requireUser();
  if (!can(user, "alerts:manage")) return { error: "Không có quyền" };
  const r = await runMarketingDigest();
  revalidatePath("/alerts");
  return { ok: true, detail: r.detail };
}
