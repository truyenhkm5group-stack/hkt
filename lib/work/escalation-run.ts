import { loadAlertConfig } from "@/lib/alerts/config";
import { sendLark } from "@/lib/alerts/lark";
import type { DepartmentCode } from "@/lib/constants/departments";
import { countEscalations, escalationDigest } from "@/lib/work/escalation";
import { collectWorkItems } from "@/lib/queries/work-adapters";
import { getStaffing } from "@/lib/queries/workforce";
import { getSettingJson, setSettingJson } from "@/lib/settings";

/**
 * ═══════════ GỬI TIN LEO THANG — MỘT LẦN MỘT NGÀY MỖI PHÒNG ═══════════
 *
 * Mức leo thang được TÍNH LÚC ĐỌC (xem `lib/work/escalation.ts`); job này chỉ làm một việc mà đọc
 * màn hình không làm được: **đi tìm người** khi không ai mở màn hình.
 *
 * ─── VÌ SAO CÓ SỔ CHỐNG GỬI LẠI ───
 *
 * Bộ lập lịch chạy job vài lần một giờ. Không có sổ này thì một phòng có 30 việc tồn sẽ nhận đúng
 * tin nhắn đó mỗi 15 phút, cả ngày. Sau buổi sáng đầu tiên không ai còn đọc, và lần thật sự cần
 * báo cũng trôi qua. Mốc chống trùng theo NGÀY GIỜ VIỆT NAM, không theo UTC — "một lần mỗi ngày"
 * phải là một ngày của người đi làm.
 *
 * Job này KHÔNG ghi vào bảng nghiệp vụ nào, KHÔNG đổi mức ưu tiên của việc nào, và KHÔNG tạo
 * cảnh báo nào. Nó chỉ đọc và gửi.
 */

const SENT_KEY = "work.escalation.sent";

/** Ngày theo giờ Việt Nam, dạng `YYYY-MM-DD`. */
export function vnDay(at: Date): string {
  return new Date(at.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
}

export type EscalationRunResult = {
  scanned: number;
  warn: number;
  breach: number;
  stale: number;
  sent: { department: DepartmentCode; stale: number }[];
  skipped: { department: DepartmentCode; reason: string }[];
  detail: string;
};

export async function runEscalationDigest(now: Date = new Date()): Promise<EscalationRunResult> {
  const [{ items }, cfg, sentRaw, alertCfg] = await Promise.all([
    collectWorkItems({ now }),
    getStaffing(),
    getSettingJson<Record<string, string>>(SENT_KEY, {}),
    loadAlertConfig(),
  ]);

  const counts = countEscalations(items, now, cfg);
  const homNay = vnDay(now);
  const sent: EscalationRunResult["sent"] = [];
  const skipped: EscalationRunResult["skipped"] = [];
  const sổ: Record<string, string> = { ...sentRaw };
  const appUrl = (process.env.APP_URL ?? "").replace(/\/$/, "");

  for (const c of counts) {
    const digest = escalationDigest(c, appUrl);
    if (!digest) continue;
    if (sổ[c.department] === homNay) {
      skipped.push({ department: c.department, reason: "đã gửi hôm nay" });
      continue;
    }
    if (!alertCfg.larkWebhookUrl) {
      skipped.push({ department: c.department, reason: "chưa cấu hình Lark" });
      continue;
    }
    const r = await sendLark(alertCfg.larkWebhookUrl, alertCfg.larkSecret, digest.title, digest.lines).catch((e) => ({ ok: false, error: String(e) }));
    if (r.ok) {
      sổ[c.department] = homNay;
      sent.push({ department: c.department, stale: c.stale });
    } else {
      // Gửi hỏng thì KHÔNG ghi sổ: lượt sau phải thử lại, không được im lặng bỏ qua cả ngày.
      skipped.push({ department: c.department, reason: `gửi hỏng: ${r.error ?? "không rõ"}` });
    }
  }

  if (sent.length) await setSettingJson(SENT_KEY, sổ);

  const warn = counts.reduce((s, c) => s + c.warn, 0);
  const breach = counts.reduce((s, c) => s + c.breach, 0);
  const stale = counts.reduce((s, c) => s + c.stale, 0);
  return {
    scanned: items.length,
    warn,
    breach,
    stale,
    sent,
    skipped,
    detail: `${items.length} việc · sắp vỡ hạn ${warn} · quá hạn ${breach} · vỡ hạn lâu chưa ai nhận ${stale} · gửi ${sent.length} tin`,
  };
}
