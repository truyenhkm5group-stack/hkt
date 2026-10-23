/**
 * ═══════════ ĐỆM RIÊNG CỦA /work GIỮ SỐ CŨ KHI NGƯỜI DÙNG GHI (OD-UX-05 mục 2(c), 24/10/2026) ═══════════
 *
 * `clearMemo()` XOÁ HẲN mọi mục đệm sau mỗi lượt ghi của người dùng (audit() và ~15 chỗ gọi thẳng — care gọi cả ngày). Ba nguồn
 * /work nặng nhất khi nguội: đối soát lương 22,5 s · nút thắt fulfillment ~3,2 s · cảnh báo ~2,9 s (perf-probe 24/10). Xoá hẳn
 * nghĩa là lượt mở /work kế tiếp mất 2–3 nguồn («đang tính lại»), và một lượt ghi giữa lúc tính VỨT kết quả đang tính.
 *
 * Các tiền tố dưới đây khi người dùng ghi thì chỉ bị ĐÁNH DẤU CŨ (người đọc kế tiếp nhận ngay số trước lượt ghi, lượt làm mới chạy
 * phía sau, trang tự làm mới khi số đổi), và lượt tính xong mà đã có lượt ghi xen vào thì được LƯU Ở TRẠNG THÁI CŨ thay vì vứt.
 *
 * CHỈ khoá RIÊNG của /work (bọc ngoài hàm nền) — KHÔNG khoá dùng chung của tồn kho (`getStockShortage:*`,
 * `getReplenishmentPlan:*` còn phục vụ /inventory/shortage · /inventory/planning · /alerts: người vừa nhập phiếu phải thấy số mới
 * ngay), KHÔNG cấu hình (`work-config`), KHÔNG khoá báo cáo tiền. Danh sách này là chỗ DUY NHẤT; lib/cache.ts nhận qua
 * `registerStaleOnWrite` để không phụ thuộc miền.
 */
export const WORK_PAYROLL_RECON_PREFIX = "work:payroll-recon:";
export const WORK_FULFILLMENT_KEY = "work:fulfillment:queue";
export const WORK_ALERTS_KEY = "work:alerts:500";

export const WORK_STALE_ON_WRITE_PREFIXES = [WORK_PAYROLL_RECON_PREFIX, "work:fulfillment:", "work:alerts:"] as const;

/** Đệm của hai khoá bọc — bằng đệm ngắn nhất của hàm nền chúng gọi (`getStockShortage` 60 s), để /work không tươi kém hơn trước. */
export const WORK_WRAPPER_TTL_MS = 60_000;
