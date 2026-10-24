/**
 * ═══════ CÁC TRANG LÀM ẤM NGAY SAU KHI CONTAINER APP LÊN (scripts/warm-pages.ts, scripts/install-vps.sh) ═══════
 *
 * Deploy thay container app rồi Caddy chuyển traffic sang NGAY — không có cổng chờ. Lượt ĐẦU tới một tuyến sau
 * khi tiến trình Next khởi động phải nạp + chạy bundle máy chủ của tuyến đó TRƯỚC khi flush được khung loading.
 * Đo production 24/10/2026 (ops returns-page-probe, run 40027244792 + returns-probe-2): /reports/returns đầu phản
 * hồi 5.559 ms ở lượt đầu → 1.026 ms khi module đã ấm mà dữ liệu còn nguội → 285 ms khi ấm cả hai. Smoke của
 * deploy chạm tuyến này rất muộn (sau hàng chục trang), nên người dùng thật trong cửa sổ đó trả trọn giá.
 *
 * Danh sách = top lượt mở 30 ngày (`page_visit_daily`, Lead 23/10/2026), bỏ /tech và /platform* (vận hành nội bộ),
 * cộng /work. KHAI Ở ĐÂY, MỘT CHỖ: thêm trang nặng mới thì thêm vào đây. Không gõ lại danh sách ở script.
 */
export const DEPLOY_WARM_ROUTES = ["/reports/returns", "/orders", "/shipments", "/", "/payroll", "/work", "/products", "/chatbot"] as const;

/** Trần song song: VPS 2 nhân — mở nhiều trang nặng cùng lúc là tự tranh CPU với chính mình. */
export const DEPLOY_WARM_CONCURRENCY = 2;

/** Hạn chờ mỗi trang. Quá hạn ⇒ cảnh báo, KHÔNG đổ deploy (làm ấm là tối ưu, không phải cổng). */
export const DEPLOY_WARM_TIMEOUT_MS = 90_000;
