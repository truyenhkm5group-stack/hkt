import { sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { rowsOf } from "@/lib/sql-rows";
import { EVAL_BUCKETS, EVAL_BATCH_MAX, type EvalBucket, type EvalBucketKey } from "@/lib/constants/sales-eval-buckets";

/**
 * CHỌN MẺ CHẤM PHÂN TẦNG — ĐỘ PHỦ CỦA MẪU, KHÔNG PHẢI MỘT PHÉP ĐO.
 *
 * ═══ ĐIỀU QUAN TRỌNG NHẤT PHẢI HIỂU VỀ TỆP NÀY ═══
 *
 * Những mệnh đề khớp chữ dưới đây CHỌN MẪU, chúng KHÔNG đo gì cả. Khác biệt ấy quyết định mức độ
 * chính xác cần có:
 *
 *   · Một mệnh đề đo sai một chút thì con số sai, và không ai biết.
 *   · Một mệnh đề chọn mẫu rộng một chút thì người chấm đọc phải một ca không thuộc nhóm — họ
 *     nhận ra ngay trong ba giây và chấm nó theo đúng thứ nó là.
 *
 * Nên ở đây ĐỘ PHỦ quan trọng hơn ĐỘ CHÍNH XÁC: thà kéo vào vài ca thừa còn hơn để một nhóm trống.
 * "giá" cũng khớp "gia đình" — chấp nhận được, vì con người đọc câu đó rồi mới chấm. Tuyệt đối
 * KHÔNG được lấy các con số ở đây làm số liệu báo cáo; chúng chỉ trả lời "còn nhóm nào chưa ai
 * chấm".
 *
 * ═══ VÌ SAO KHỚP CHỮ KHÁCH GÕ, KHÔNG DÙNG NHÃN Ý ĐỊNH CỦA MÁY ═══
 *
 * Lấy nhãn của máy ra làm rổ để chấm máy là một vòng tròn: lượt nào máy đọc nhầm ý định sẽ rơi
 * vào nhóm sai, và nhóm ĐÚNG sẽ trông như không có ca nào — đúng cái lỗi mà phép chấm sinh ra để
 * bắt. Ngoại lệ duy nhất là nhóm `HANDOFF`, nơi câu hỏi CHÍNH LÀ "quyết định chuyển người có đúng
 * không", nên hành động của máy mới là thứ định nghĩa rổ.
 *
 * ═══ KHỚP CẢ HAI CÁCH GÕ ═══
 *
 * Khách Việt gõ điện thoại thường không dấu. `unaccent` không có sẵn trên CSDL này, nên mỗi nhóm
 * liệt kê CẢ dạng có dấu LẪN dạng không dấu. Dài dòng, nhưng nó chạy đúng ở nơi cần chạy đúng, và
 * đọc ra được ngay là đã phủ những cách gõ nào.
 */

/** Chữ của KHÁCH đã kích hoạt lượt chạy này. */
const CAU_KHACH = sql`coalesce((select m.text from sales_messages m where m.id = ${schema.salesSuggestions.triggerMessageId}), '')`;

const khop = (mau: string): SQL => sql`${CAU_KHACH} ~* ${mau}`;

/**
 * Mệnh đề của từng nhóm. Server-only — sống cạnh truy vấn chứ không nằm trong `lib/constants/*`,
 * vì chúng là SQL, và một hằng số dùng chung mà client vô tình nhập vào sẽ kéo theo cả `@/db`.
 */
export function bucketCond(key: EvalBucketKey): SQL {
  switch (key) {
    case "PRICE":
      return khop("giá|gia |bao nhiêu|bao nhieu|nhiêu|nhieu|bn |mấy tiền|may tien|giá sỉ|gia si");
    case "COLOR_ASK":
      return khop("màu|mau |mấy màu|may mau|color");
    case "SIZE_ASK":
      return khop("size|sai |số đo|so do|cân nặng|can nang|[0-9]{2} ?kg|mặc size|mac size|eo |ngực|nguc|cao [0-9]");
    case "VARIANT_PICK":
      // Có CẢ màu LẪN size trong cùng một câu ⇒ khách đang chốt mẫu mã, không phải đang hỏi.
      return sql`(${khop("màu|mau |đỏ|do |đen|den|xanh|trắng|trang|vàng|vang|nâu|nau|kem|be |xám|xam|hồng|hong|tím|tim")}
              and ${khop("size|sai |\\m(s|m|l|xl|xxl|2xl|3xl)\\M|[0-9]{2}")})`;
    case "PURCHASE_INTENT":
      return khop("mua|đặt|dat |lấy|lay |chốt|chot|order|ship cho|gửi cho|gui cho");
    case "CONFIRM_VANG":
      // ĐÚNG CHÍNH TẢ CÓ DẤU. Không khớp dạng không dấu ở nhóm này — vì "vang" không dấu chính là
      // chỗ máy KHÔNG phân biệt được, và kéo nó vào đây là trộn hai nhóm đang cần tách.
      return khop("\\mvâng\\M|\\mdạ\\M|\\mừ\\M|\\mừa\\M|\\mờ\\M");
    case "COLOR_VANG":
      return khop("\\mvàng\\M|màu vàng|mau vang");
    case "CHANGE_CHOICE":
      return khop("đổi|doi |chuyển sang|chuyen sang|thay |lấy màu khác|lay mau khac|đổi lại|doi lai|cho mình màu|cho minh mau");
    case "CONTACT":
      return sql`(${khop("[0-9]{9,}|địa chỉ|dia chi|sdt|số điện thoại|so dien thoai|thôn |thon |xã |xa |phường|phuong|quận|quan |huyện|huyen")})`;
    case "COMPLAINT":
      return khop("lỗi|loi |rách|rach|hỏng|hong |lừa|lua dao|tệ|te |kém|kem |bẩn|ban |sai |không giống|khong giong|thất vọng|that vong");
    case "DELIVERY":
      return khop("giao|ship|bao giờ|bao gio|khi nào|khi nao|chưa nhận|chua nhan|bưu tá|buu ta|đơn của|don cua|vận đơn|van don");
    case "RETURN_EXCHANGE":
      return khop("trả|tra lai|trả lại|đổi hàng|doi hang|hoàn tiền|hoan tien|bảo hành|bao hanh|đổi trả|doi tra");
    case "UNKNOWN_PRODUCT":
      // Máy CHƯA nối được về một mã hàng nào. Đây là nhóm duy nhất đọc trạng thái thay vì đọc chữ,
      // vì "chưa rõ mẫu nào" là một tình trạng của MÁY chứ không phải một kiểu câu của khách.
      return sql`coalesce(${schema.aiRuns.stateAfter}->>'productId', '') = ''`;
    case "HANDOFF":
      return sql`${schema.salesSuggestions.action} = 'HANDOFF_HUMAN'`;
  }
}

export type EvalBucketCoverage = EvalBucket & {
  /** Số lượt khớp nhóm này trong cửa sổ đang xét. */
  available: number;
  /** Trong đó đã có người chấm. */
  reviewed: number;
  /** Còn thiếu bao nhiêu ca nữa mới đạt sàn của nhóm. 0 = đủ. */
  missing: number;
};

/**
 * ĐỘ PHỦ CỦA MẺ CHẤM, theo nhóm.
 *
 * KHÔNG in dòng tổng. Các nhóm CỐ Ý KHÔNG phân hoạch — "Lấy cho chị màu đỏ size XL" vừa là chọn
 * mẫu vừa là ý muốn mua — nên cộng các ô lại ra một con số lớn hơn số lượt thật và không có nghĩa.
 * Ép mỗi lượt vào đúng một nhóm thì phải chọn bừa, và nhóm còn lại mất một ca đáng chấm.
 */
export async function evalBatchCoverage(days = 30): Promise<EvalBucketCoverage[]> {
  const db = await getDb();
  const since = new Date(Date.now() - Math.min(Math.max(days, 1), 90) * 86_400_000);

  /*
    KHÔNG ĐẶT BÍ DANH BẢNG Ở ĐÂY, và đó là một ràng buộc thật chứ không phải sở thích.

    `bucketCond()` dựng mệnh đề từ chính các cột trong `schema`, nên drizzle in ra tên ĐẦY ĐỦ:
    `"sales_suggestions"."trigger_message_id"`. Nếu mệnh đề `from` đổi tên bảng thành `s` thì
    Postgres không còn phân giải được cái tên đầy đủ ấy và cả câu lệnh hỏng — đúng lỗi đã gặp ở
    bản đầu. Dùng tên thật ở mọi chỗ thì hai nửa luôn nói cùng một thứ tiếng.
  */
  const dong = EVAL_BUCKETS.map(
    (b) => sql`select ${b.key}::text as k,
                      count(*)::int as co,
                      count(*) filter (where sales_review_labels.reviewed_at is not null)::int as da_cham
                 from sales_suggestions
                 left join ai_runs on ai_runs.id = sales_suggestions.run_id
                 left join sales_review_labels on sales_review_labels.suggestion_id = sales_suggestions.id
                where sales_suggestions.created_at >= ${since} and (${bucketCond(b.key)})`,
  );
  const rows = rowsOf<{ k: string; co: number; da_cham: number }>(
    await db.execute(sql.join(dong, sql` union all `)),
  );
  const theoKhoa = new Map(rows.map((x) => [String(x.k), x]));

  return EVAL_BUCKETS.map((b) => {
    const hit = theoKhoa.get(b.key);
    const available = Number(hit?.co ?? 0);
    const reviewed = Number(hit?.da_cham ?? 0);
    return { ...b, available, reviewed, missing: Math.max(0, b.min - reviewed) };
  });
}

/** Tổng số ca ĐÃ CHẤM tính trên các nhóm — dùng để biết còn cách sàn bao xa, KHÔNG phải số liệu. */
export function batchProgress(cov: EvalBucketCoverage[]): { reviewedBuckets: number; bucketsAtFloor: number; stillMissing: number } {
  return {
    reviewedBuckets: cov.filter((b) => b.reviewed > 0).length,
    bucketsAtFloor: cov.filter((b) => b.missing === 0).length,
    stillMissing: cov.reduce((a, b) => a + b.missing, 0),
  };
}

export { EVAL_BATCH_MAX };
