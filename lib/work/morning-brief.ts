import { loadAlertConfig } from "@/lib/alerts/config";
import { sendLark } from "@/lib/alerts/lark";
import { vnDayOf } from "@/lib/constants/feed-freshness";
import { WORK_SOURCE_SPEC, type WorkSource } from "@/lib/constants/work-sources";
import { env } from "@/lib/env";
import { formatVND } from "@/lib/format";
import { getManagerDay, INTERVENTION_LABEL, type ManagerDay } from "@/lib/queries/manager-day";
import { getSettingJson, setSettingJson } from "@/lib/settings";

/**
 * ═══════════ BẢN TIN SÁNG — MÀN HÌNH "NGÀY CỦA QUẢN LÝ" ĐI TÌM NGƯỜI ĐỌC ═══════════
 *
 * `/work/today` đã trả lời "sáng nay chạm vào đâu": ba việc đáng làm nhất xếp LIÊN PHÒNG, việc quá
 * hạn, việc chưa ai nhận, phòng chưa có người. Nhưng nó chỉ trả lời người đã mở nó ra. Job này làm
 * đúng MỘT việc mà màn hình không làm được: gửi câu trả lời ấy vào nhóm Lark của người điều hành
 * mỗi sáng một lần.
 *
 * ─── KHÔNG CÓ PHÉP TÍNH MỚI NÀO Ở ĐÂY ───
 *
 * Mọi con số đọc từ `getManagerDay(null)` — CÙNG hàm mà màn hình dùng. Tin nhắn nói khác màn hình
 * là tin nhắn sai, và người đọc sẽ thôi tin cả hai. Không gọi AI: đây là một bản chép lại có định
 * dạng, không phải một bản tóm tắt.
 *
 * ─── KHÔNG LÙI VỀ NHÓM VẬN ĐƠN ───
 *
 * Chưa khai webhook nhóm Quản lý thì KHÔNG gửi. Bản tin viết cho người điều hành; rơi vào nhóm vận
 * đơn thì mười người đọc một tin không phải của mình và học cách bỏ qua kênh đó.
 *
 * ─── MỘT TIN MỘT NGÀY ───
 *
 * Bộ lập lịch gọi 30 phút một lần để tin tới sớm cả khi máy chủ vừa khởi động lại; sổ chống gửi
 * lại (`settings["work.morning-brief.sent"]`) khoá theo NGÀY GIỜ VIỆT NAM. Gửi hỏng thì KHÔNG ghi
 * sổ: lượt sau phải thử lại, không được im lặng bỏ qua cả ngày.
 */

/** Trước giờ này (giờ Việt Nam) không gửi — bản tin phải tới lúc người ta bắt đầu ngày làm việc. */
export const MORNING_BRIEF_HOUR_VN = 7;

const SENT_KEY = "work.morning-brief.sent";

type Line = { text: string; href?: string }[];

function linkOf(appUrl: string, url: string): string | undefined {
  if (!url) return undefined;
  if (/^https?:\/\//.test(url)) return url;
  return appUrl ? `${appUrl}${url.startsWith("/") ? "" : "/"}${url}` : undefined;
}

/**
 * Dựng tin nhắn từ đúng dữ liệu màn hình đang hiện. HÀM THUẦN — kiểm được từng dòng.
 *
 * Tiền CHƯA TRA ĐƯỢC không bao giờ in thành 0 (AGENTS.md mục 42): việc không có số tiền nói "chưa
 * tra được tiền", và tổng tiền treo đi kèm số việc chưa tra được.
 */
export function morningBriefMessage(day: ManagerDay, now: Date, appUrl: string): { title: string; lines: Line[] } {
  const [, thang, ngay] = vnDayOf(now).split("-");
  const picks = day.morning?.picks ?? [];
  const title = picks.length ? `☀️ Sáng ${ngay}/${thang} · ${picks.length} việc đáng làm nhất` : `☀️ Sáng ${ngay}/${thang} · không có việc nào làm được ngay`;

  const lines: Line[] = [];
  lines.push([
    {
      text: `Toàn shop: ${day.backlog} việc mở · ${day.overdue} quá hạn · ${day.dueSoon} sắp vỡ hạn · ${day.unassigned} chưa ai nhận · ${day.blocked} bị chặn · ${day.waiting} đang chờ bên ngoài`,
    },
  ]);
  const chuaTra = day.money.unknown ? ` · ${day.money.unknown} việc chưa tra được tiền` : "";
  lines.push([{ text: `Tiền đang treo trên việc mở: ${formatVND(day.money.atRisk)}${chuaTra}` }]);

  if (picks.length) {
    lines.push([{ text: "Ba chỗ đáng chạm vào trước (mỗi phòng một việc, xếp theo mức gấp rồi tiền):" }]);
    for (const p of picks) {
      const tien = p.moneyAtRisk === null ? "chưa tra được tiền" : formatVND(p.moneyAtRisk);
      const gap = p.escalation ? ` · ${p.escalation.label}` : "";
      lines.push([{ text: `${p.rank}. [${p.departmentLabel}] ${p.item.title} — ${tien}${gap}`, href: linkOf(appUrl, p.item.sourceUrl) }]);
    }
  }

  const canThiep = day.interventions.slice(0, 3);
  if (canThiep.length) {
    lines.push([{ text: "Cần quản lý gỡ:" }]);
    for (const i of canThiep) lines.push([{ text: `• ${INTERVENTION_LABEL[i.kind]}: ${i.title} — ${i.detail}`, href: linkOf(appUrl, i.url) }]);
  }

  for (const e of day.emptyDepartments) lines.push([{ text: `⚠️ ${e.label}: ${e.open} việc mở mà phòng chưa có thành viên nào — không ai nhận được.` }]);

  // Nguồn việc đọc hỏng thì các con số trên THIẾU phần của nó — phải nói ra, không để trông như đủ.
  if (day.failedSources.length) {
    const ten = day.failedSources.map((f) => WORK_SOURCE_SPEC[f.source as WorkSource]?.label ?? f.source).join(", ");
    lines.push([{ text: `⚠️ Không đọc được nguồn việc: ${ten} — số liệu trên THIẾU phần của các nguồn này.` }]);
  }

  const moTrang = linkOf(appUrl, "/work/today");
  if (moTrang) lines.push([{ text: "Mở màn hình sáng", href: moTrang }]);
  return { title, lines };
}

export type MorningBriefResult = { sent: boolean; reason: string; detail: string };

export async function runMorningBrief(now: Date = new Date(), opts: { force?: boolean } = {}): Promise<MorningBriefResult> {
  const cfg = await loadAlertConfig();
  const homNay = vnDayOf(now);
  const gioVn = new Date(now.getTime() + 7 * 3_600_000).getUTCHours();

  if (!cfg.enabled.morningBrief) return { sent: false, reason: "đã tắt ở trang Cảnh báo", detail: "bản tin sáng đang tắt" };
  if (!cfg.larkManagerWebhookUrl) return { sent: false, reason: "chưa khai webhook nhóm Quản lý", detail: "chưa khai webhook nhóm Quản lý — không gửi (không lùi về nhóm vận đơn)" };
  if (!opts.force && gioVn < MORNING_BRIEF_HOUR_VN) return { sent: false, reason: "chưa tới giờ", detail: `chưa tới ${MORNING_BRIEF_HOUR_VN} giờ sáng` };

  const so = await getSettingJson<{ day?: string }>(SENT_KEY, {});
  if (!opts.force && so.day === homNay) return { sent: false, reason: "đã gửi hôm nay", detail: `đã gửi bản tin ngày ${homNay}` };

  const day = await getManagerDay(null, now);
  const msg = morningBriefMessage(day, now, env.appUrl.replace(/\/$/, ""));
  const r = await sendLark(cfg.larkManagerWebhookUrl, cfg.larkManagerSecret, msg.title, msg.lines).catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  if (!r.ok) return { sent: false, reason: `gửi hỏng: ${r.error ?? "không rõ"}`, detail: `gửi hỏng: ${r.error ?? "không rõ"}` };

  await setSettingJson(SENT_KEY, { day: homNay });
  return { sent: true, reason: "", detail: `đã gửi · ${day.backlog} việc mở · ${day.overdue} quá hạn · ${day.morning?.picks.length ?? 0} việc đầu bảng` };
}
