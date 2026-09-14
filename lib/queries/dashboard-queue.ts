import { cache } from "react";
import { getActionQueue, type ActionQueue } from "@/lib/queries/action-queue";

/**
 * HÀNG ĐỢI VIỆC DÙNG CHUNG TRONG MỘT LẦN TẢI TRANG.
 *
 * Bảng điều khiển có hai khối cùng cần hàng đợi: "Việc cần làm hôm nay" và "Tóm tắt & rủi ro".
 * Hai khối render song song nên nếu mỗi khối tự gọi thì truy vấn chạy HAI LẦN cho cùng một dữ
 * liệu — và hàng đợi còn kéo theo cả kế hoạch tồn kho để tính "sắp cháy hàng".
 *
 * `cache` của React khử trùng lặp trong PHẠM VI MỘT LẦN RENDER, không phải theo thời gian. Cố ý
 * không dùng bộ nhớ đệm theo TTL ở đây: người vừa bấm "Tôi nhận" phải thấy trạng thái đổi ngay,
 * còn đệm 30 giây sẽ khiến giao diện trông như hỏng.
 */
export const getDashboardActionQueue = cache((): Promise<ActionQueue> => getActionQueue({ limit: 60 }));
