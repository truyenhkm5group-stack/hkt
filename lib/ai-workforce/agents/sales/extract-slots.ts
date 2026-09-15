/**
 * BÓC SỐ ĐO · MÀU · SIZE TỪ CÂU KHÁCH — luật thuần, KHÔNG gọi mô hình.
 *
 * Bóc sai một con số ở đây thì hậu quả không dừng ở một câu trả lời lạc: nó đi thẳng vào máy gợi ý
 * size và thành một kiện hàng không vừa, hoặc thành một tín hiệu sai trong báo cáo R&D của mẫu
 * test. Mô hình ngôn ngữ bóc rất trôi chảy, và đó chính là điều làm nó nguy hiểm ở đây — nó không
 * nói cho ta biết lúc nào nó đang đoán.
 *
 * NGUYÊN TẮC: CHỈ NHẬN DẠNG VIẾT RÕ RÀNG. "1m58" là chiều cao, "50kg" là cân nặng. Một con số trơ
 * trọi ("50") KHÔNG được đoán là gì — nó có thể là tuổi, số nhà, hay giá. Không chắc thì trả về
 * rỗng và để tầng trên đi hỏi khách; hỏi lại một câu rẻ hơn nhiều so với gửi nhầm một kiện hàng.
 *
 * Khi bật mô hình thật, nó được phép ĐỀ XUẤT thêm số đo mà luật ở đây bỏ sót — nhưng qua đường
 * bóc thực thể có kiểm, không qua đường tự điền vào chỗ trống.
 */
import type { BodyMeasurements } from "@/lib/constants/size-engine";

function bo(t: string): string {
  return t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d");
}

/** Số đo khách nêu. Ô nào không chắc thì KHÔNG có mặt — thiếu là chưa biết, không phải 0. */
export function extractMeasurements(text: string): BodyMeasurements {
  const t = bo(text);
  const out: BodyMeasurements = {};

  // Chiều cao: "1m58" · "158cm" · "cao 158".
  const cao = t.match(/\b1\s*m\s*([0-9]{2})\b/) ?? t.match(/\b(1[3-9][0-9])\s*cm\b/) ?? t.match(/\bcao\s*(1[3-9][0-9])\b/);
  if (cao) {
    const v = /m/.test(cao[0]) && !/cm/.test(cao[0]) ? 100 + Number(cao[1]) : Number(cao[1]);
    if (v >= 130 && v <= 200) out.heightCm = v;
  }

  // Cân nặng: phải có đơn vị "kg" hoặc chữ "nặng" đứng trước.
  const nang = t.match(/\b([3-9][0-9]|1[0-4][0-9])\s*kg\b/) ?? t.match(/\bnang\s*([3-9][0-9]|1[0-4][0-9])\b/);
  if (nang) out.weightKg = Number(nang[1]);

  // Ba vòng: phải có chữ chỉ tên vòng đứng trước. "74" một mình không nói lên vòng nào.
  const vong = (nhan: RegExp): number | undefined => {
    const m = t.match(nhan);
    const v = m ? Number(m[1]) : NaN;
    return Number.isFinite(v) && v >= 40 && v <= 200 ? v : undefined;
  };
  const bust = vong(/\b(?:vong\s*)?(?:nguc|ngực|bust)\s*:?\s*([0-9]{2,3})\b/);
  const waist = vong(/\b(?:vong\s*)?(?:eo|waist)\s*:?\s*([0-9]{2,3})\b/);
  const hip = vong(/\b(?:vong\s*)?(?:mong|hip)\s*:?\s*([0-9]{2,3})\b/);
  if (bust !== undefined) out.bustCm = bust;
  if (waist !== undefined) out.waistCm = waist;
  if (hip !== undefined) out.hipCm = hip;

  return out;
}

/**
 * Màu khách nhắc tới — CHỈ trong danh sách màu ĐANG BÁN.
 *
 * Đối chiếu với danh sách thật chứ không nhận mọi từ trông như tên màu: khách viết "đỏ" mà mẫu
 * không có đỏ thì câu trả lời đúng là "bên em không có màu đó", không phải im lặng nhận bừa.
 * Chuỗi dài khớp trước, để "đỏ đô" không bị cắt thành "đỏ".
 */
export function extractColor(text: string, known: string[]): string {
  const raw = text.toLowerCase();
  const t = bo(text);
  return (
    [...known]
      .sort((a, b) => b.length - a.length)
      .find((m) => raw.includes(m.toLowerCase()) || t.includes(bo(m))) ?? ""
  );
}

/**
 * Size khách nhắc tới — CHỈ trong danh sách size đang bán, và phải có dấu hiệu đó là size.
 *
 * Chữ "l" hay "m" đứng một mình trong câu tiếng Việt là chuyện thường ("m" trong "1m58"), nên chỉ
 * nhận khi có chữ "size"/"sz" đứng cạnh hoặc size đó dài hơn một ký tự (XL, 2XL).
 */
export function extractSize(text: string, known: string[]): string {
  const t = bo(text);
  for (const z of [...known].sort((a, b) => b.length - a.length)) {
    const k = bo(z);
    if (!k) continue;
    if (new RegExp(`\\b(?:size|sz|cỡ|co)\\s*${k}\\b`).test(t)) return z;
    if (k.length > 1 && new RegExp(`\\b${k}\\b`).test(t)) return z;
  }
  return "";
}
