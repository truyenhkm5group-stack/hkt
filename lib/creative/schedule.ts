import type { CreativeLoopConfig } from "@/lib/constants/creative-loop";
import { shiftDay, vnDay } from "@/lib/constants/marketing-decision-ledger";

/**
 * ═══════════ LỊCH MỘT LÔ — HÀM THUẦN ═══════════
 *
 * Không đọc đồng hồ ngoài tham số, không đọc CSDL. Mọi mốc là giờ Việt Nam quy ra UTC.
 *
 * Một lô mang tên NGÀY CHẠY (`batchDay`, `YYYY-MM-DD` giờ Việt Nam). Lô của ngày D:
 *   · được dựng từ `genHourVn` của ngày D−1,
 *   · phải được duyệt trước `startAt − approvalLeadMinutes`,
 *   · chạy từ `startAt` (D, `startHourVn`:00) tới `endAt` (`startAt` + `testDays` × 24 giờ).
 *
 * `endAt` được ghi thẳng vào `end_time` của nhóm quảng cáo trên Facebook: hết khung là Facebook tự
 * dừng, không cần lời gọi ghi nào. Đó là lý do một lô KHÔNG thể tiêu quá ngân sách đã duyệt kể cả
 * khi ERP chết hẳn giữa chừng.
 */

export type BatchWindow = {
  batchDay: string;
  startAt: Date;
  endAt: Date;
  approvalDeadline: Date;
  /** Từ mốc này job mới dựng lô cho `batchDay`. */
  buildFrom: Date;
};

function vnAt(day: string, hour: number, minute = 0): Date {
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  return new Date(`${day}T${hh}:${mm}:00+07:00`);
}

export function batchWindow(batchDay: string, cfg: Pick<CreativeLoopConfig, "startHourVn" | "testDays" | "approvalLeadMinutes" | "genHourVn">): BatchWindow {
  const startAt = vnAt(batchDay, cfg.startHourVn);
  return {
    batchDay,
    startAt,
    endAt: new Date(startAt.getTime() + cfg.testDays * 24 * 3_600_000),
    approvalDeadline: new Date(startAt.getTime() - cfg.approvalLeadMinutes * 60_000),
    buildFrom: vnAt(shiftDay(batchDay, -1), cfg.genHourVn),
  };
}

/**
 * Lô nào job NÊN dựng lúc `now`: ngày mai khi đã qua giờ dựng, còn không thì chưa có lô nào.
 *
 * Không bao giờ trả về HÔM NAY: dựng lô cho hôm nay sau giờ dựng của hôm qua nghĩa là người duyệt
 * có ít thời gian hơn khung đã hứa — và nếu job chết cả ngày hôm qua thì hôm nay KHÔNG CHẠY là
 * hướng đúng, không phải chạy vội một lô chưa ai kịp xem.
 */
export function batchDayToBuild(now: Date, cfg: Pick<CreativeLoopConfig, "startHourVn" | "testDays" | "approvalLeadMinutes" | "genHourVn">): string | null {
  const tomorrow = shiftDay(vnDay(now), 1);
  const w = batchWindow(tomorrow, cfg);
  if (now < w.buildFrom) return null;
  if (now >= w.approvalDeadline) return null;
  return tomorrow;
}

/**
 * Mốc VẼ NỐT của lô Batch: tới đây mà lô Batch còn chưa xong thì huỷ và vẽ phần còn lại bằng gọi ngay
 * (chủ shop chốt 24/09/2026: 2:00 sáng của ngày chạy). Là mốc `batchFallbackHourVn:00` giờ VN GẦN NHẤT
 * ĐỨNG TRƯỚC hạn duyệt — giờ 2 với lịch mặc định (chạy 6:00, hạn 5:30) là 2:00 ngày chạy; một giờ ghi
 * sau hạn duyệt (vd 22) được hiểu là tối hôm trước, không bao giờ là một mốc lô đã hết hạn.
 */
export function imageBatchFallbackAt(batchDay: string, cfg: Pick<CreativeLoopConfig, "startHourVn" | "testDays" | "approvalLeadMinutes" | "genHourVn" | "batchFallbackHourVn">): Date {
  const w = batchWindow(batchDay, cfg);
  const at = vnAt(batchDay, cfg.batchFallbackHourVn);
  return at < w.approvalDeadline ? at : new Date(at.getTime() - 24 * 3_600_000);
}

/** Còn duyệt kịp không. Quá hạn ⇒ lô `EXPIRED`, không đồng nào được chi. */
export function isApprovalOpen(now: Date, w: BatchWindow): boolean {
  return now < w.approvalDeadline;
}

/**
 * Còn được ĐĂNG không. Đăng sau `startAt` là chạy một khung ngắn hơn khung đã duyệt — số đo của mẫu
 * ấy không so được với các mẫu cùng lô, nên thà không đăng.
 */
export function isPublishOpen(now: Date, w: BatchWindow): boolean {
  return now < w.startAt;
}
