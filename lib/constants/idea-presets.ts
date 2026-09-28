/**
 * ═══════════ GỢI Ý CHỌN NHANH CHO Ô "Ý TƯỞNG / CÂU LỆNH" (Thư viện Media → Tạo ảnh) ═══════════
 *
 * Chủ shop 28/09/2026: "tạo các trường chọn sẵn các nội dung gợi ý về người mẫu, background, chất vải, màu sắc, kiểu dáng, kiểu
 * thiết kế, chi tiết điểm nhấn, mùa, thời tiết, trend… để chọn nhanh". Mỗi lựa chọn chỉ THÊM một cụm chữ vào ô ý tưởng — người
 * vẫn đọc và sửa được trước khi bấm Gen; không trường nào tự đi vào câu lệnh.
 *
 * `scope`: `ALL` = dùng cho cả ảnh mã có sẵn lẫn thiết kế mới; `DESIGN` = chỉ khi THIẾT KẾ MỚI — với ảnh của mã có sẵn, máy luôn
 * giữ đúng món hàng thật, nên chọn chất vải / màu / dáng khác là nói điều ảnh không thể có.
 */

export type IdeaPresetGroup = { key: string; label: string; scope: "ALL" | "DESIGN"; options: readonly string[] };

export const IDEA_PRESET_GROUPS: readonly IdeaPresetGroup[] = [
  {
    key: "model",
    label: "Người mẫu",
    scope: "ALL",
    options: ["người mẫu nữ Việt 25–30 tuổi", "nữ trung niên sang trọng 40–50 tuổi", "dáng người đầy đặn, tự tin", "dáng mảnh, cao", "tóc dài buông tự nhiên", "tóc búi gọn thanh lịch", "cười nhẹ, nhìn máy ảnh", "dáng đi tự nhiên", "ngồi thư thái", "xoay nhẹ khoe tà váy", "không người mẫu — trải phẳng"],
  },
  {
    key: "background",
    label: "Bối cảnh",
    scope: "ALL",
    options: ["phố cổ Hội An", "quán cà phê sáng sủa", "bãi biển buổi chiều", "vườn hoa", "studio nền trơn màu kem", "sảnh khách sạn sang trọng", "văn phòng hiện đại", "tiệc cưới ngoài trời", "phố Sài Gòn về đêm", "phòng khách tối giản", "cánh đồng lúa", "ban công đầy cây xanh"],
  },
  {
    key: "light",
    label: "Ánh sáng / thời tiết",
    scope: "ALL",
    options: ["nắng sớm dịu", "nắng chiều vàng", "trời râm mát", "sau mưa, mặt đường lấp lánh", "đèn studio mềm", "ánh đèn tiệc lung linh", "hoàng hôn", "gió nhẹ làm tà váy bay"],
  },
  {
    key: "season",
    label: "Mùa / dịp",
    scope: "ALL",
    options: ["mùa xuân", "mùa hè", "mùa thu", "mùa đông", "Tết Nguyên đán", "Valentine", "20/10", "Giáng sinh", "đi tiệc cưới", "đi làm công sở", "du lịch", "dạo phố cuối tuần"],
  },
  {
    key: "trend",
    label: "Phong cách / trend",
    scope: "ALL",
    options: ["phong cách Hàn Quốc nhẹ nhàng", "old money thanh lịch", "tối giản (minimalism)", "vintage retro", "boho du mục", "nữ tính bánh bèo", "quiet luxury", "Y2K trẻ trung", "thanh lịch Pháp", "năng động streetwear"],
  },
  {
    key: "fabric",
    label: "Chất vải",
    scope: "DESIGN",
    options: ["lụa mềm rủ", "linen tự nhiên", "đũi thô", "voan nhẹ", "cotton thoáng", "tweed dày dặn", "ren mỏng", "nhung", "thun co giãn", "tafta đứng form"],
  },
  {
    key: "color",
    label: "Màu sắc",
    scope: "DESIGN",
    options: ["trắng kem", "đen", "đỏ đô", "xanh navy", "xanh pastel", "hồng phấn", "be / nude", "vàng bơ", "xanh rêu", "nâu cà phê", "hoạ tiết hoa nhí", "kẻ sọc"],
  },
  {
    key: "silhouette",
    label: "Kiểu dáng",
    scope: "DESIGN",
    options: ["dáng suông", "dáng chữ A", "ôm body nhẹ", "xoè xếp ly", "dáng babydoll", "dáng sơ mi", "dáng wrap (vạt chéo)", "dáng maxi dài", "dáng midi qua gối", "dáng mini"],
  },
  {
    key: "design",
    label: "Kiểu thiết kế",
    scope: "DESIGN",
    options: ["cổ vuông", "cổ chữ V", "cổ sơ mi", "cổ yếm", "trễ vai", "tay phồng", "tay loe", "không tay", "cổ tàu", "tay lỡ"],
  },
  {
    key: "detail",
    label: "Chi tiết điểm nhấn",
    scope: "DESIGN",
    options: ["nơ eo", "đai eo", "hàng cúc bọc", "xẻ tà nhẹ", "bèo nhún", "thêu hoa", "đính ngọc trai", "túi hộp", "viền ren", "dây rút eo"],
  },
];

/** Thêm một cụm vào ô ý tưởng: "Nhóm: giá trị", nối bằng "; ", không trùng, không vượt trần ký tự. Hàm THUẦN. */
export function appendIdeaPreset(idea: string, groupLabel: string, option: string, maxChars: number): string {
  const piece = `${groupLabel}: ${option}`;
  if (idea.includes(piece)) return idea;
  const base = idea.trim().replace(/[;,.]\s*$/, "");
  const next = base ? `${base}; ${piece}` : piece;
  return next.length > maxChars ? idea : next;
}
