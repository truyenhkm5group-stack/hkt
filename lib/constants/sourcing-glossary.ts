/**
 * ═══ TỪ ĐIỂN THỜI TRANG VIỆT → TRUNG CHO TÌM HÀNG NGUỒN (SRC-2 · docs/tech/ai-sourcing.md §3.2) — CLIENT-SAFE ═══
 *
 * Phần CỐ ĐỊNH của bộ sinh từ khoá: chạy trước, không tốn lượt AI, ra cùng một kết quả mọi lần. Mỗi mục khai:
 *  · `vi`   — các cách nói tiếng Việt (chữ thường, CÓ DẤU). Một cách nói chỉ thuộc ĐÚNG MỘT mục (bài kiểm chặn trùng).
 *  · `zh`   — từ khoá Trung, cái ĐẦU là từ chính; cái thứ hai (nếu có) dùng cho truy vấn «từ đồng nghĩa».
 *  · `role` — vai trong truy vấn: quyết thứ tự ghép và thứ tự BỎ BỚT khi nới truy vấn (xem `lib/sourcing/query.ts`).
 *  · `example` — một câu khách nói thật có chứa mục này; bài kiểm chạy bộ sinh trên CHÍNH câu đó và đòi nó nhận ra mục.
 *
 * Hướng tới khách 35–60 (đồ cho mẹ / bố, trung niên, size lớn, dáng suông, che bụng). Từ nào chưa có ở đây thì bộ sinh TRẢ RA
 * cho người dùng thấy (`unmatched`) — không nuốt im, không đoán. Thêm mục là sửa tệp này + bài kiểm, không phải sửa bộ sinh.
 */

export const GLOSSARY_ROLES = ["AUDIENCE", "SEASON", "STYLE", "MATERIAL", "FIT", "PART", "FEATURE", "SIZE", "PRODUCT"] as const;
export type GlossaryRole = (typeof GLOSSARY_ROLES)[number];

export const GLOSSARY_ROLE_LABEL: Record<GlossaryRole, string> = {
  AUDIENCE: "Người mặc",
  SEASON: "Mùa",
  STYLE: "Phong cách",
  MATERIAL: "Chất liệu",
  FIT: "Dáng",
  PART: "Chi tiết",
  FEATURE: "Công dụng",
  SIZE: "Cỡ",
  PRODUCT: "Loại hàng",
};

export type GlossaryEntry = {
  key: string;
  label: string;
  vi: readonly string[];
  zh: readonly string[];
  role: GlossaryRole;
  note?: string;
  example: string;
};

export const SOURCING_GLOSSARY: readonly GlossaryEntry[] = [
  // ── Loại hàng ──
  { key: "dress", label: "Đầm", vi: ["đầm", "váy liền", "váy đầm", "đầm liền"], zh: ["连衣裙"], role: "PRODUCT", example: "đầm suông che bụng cho mẹ" },
  { key: "skirt-or-dress", label: "Váy", vi: ["váy"], zh: ["裙子"], role: "PRODUCT", note: "«Váy» đứng một mình có thể là đầm hoặc chân váy — 裙子 phủ cả hai.", example: "váy hoa nhí đi chơi" },
  { key: "skirt", label: "Chân váy", vi: ["chân váy"], zh: ["半身裙"], role: "PRODUCT", example: "chân váy dáng chữ a công sở" },
  { key: "shirt", label: "Áo sơ mi", vi: ["áo sơ mi", "sơ mi"], zh: ["衬衫"], role: "PRODUCT", example: "áo sơ mi nam trung niên size lớn" },
  { key: "tshirt", label: "Áo thun", vi: ["áo thun", "áo phông"], zh: ["T恤"], role: "PRODUCT", example: "áo thun cotton tay ngắn" },
  { key: "polo", label: "Áo polo", vi: ["áo polo", "polo"], zh: ["POLO衫"], role: "PRODUCT", example: "áo polo cho bố" },
  { key: "blouse", label: "Áo kiểu", vi: ["áo kiểu"], zh: ["女士上衣"], role: "PRODUCT", example: "áo kiểu voan cho mẹ" },
  { key: "jacket", label: "Áo khoác", vi: ["áo khoác"], zh: ["外套"], role: "PRODUCT", example: "áo khoác mùa đông trung niên" },
  { key: "blazer", label: "Áo vest", vi: ["áo vest", "vest", "áo blazer"], zh: ["西装外套"], role: "PRODUCT", example: "áo vest nữ công sở" },
  { key: "knit", label: "Áo len", vi: ["áo len"], zh: ["毛衣", "针织衫"], role: "PRODUCT", example: "áo len cho mẹ mùa đông" },
  { key: "aodai", label: "Áo dài", vi: ["áo dài"], zh: ["奥黛"], role: "PRODUCT", note: "Xưởng Trung Quốc ít làm áo dài Việt — kết quả hay ra sườn xám (旗袍), cần xem kỹ ảnh.", example: "áo dài lụa cho mẹ" },
  { key: "top", label: "Áo", vi: ["áo"], zh: ["上衣"], role: "PRODUCT", example: "áo cho mẹ dáng suông" },
  { key: "pants", label: "Quần", vi: ["quần", "quần dài"], zh: ["裤子"], role: "PRODUCT", example: "quần lụa mát mùa hè" },
  { key: "trousers", label: "Quần tây", vi: ["quần tây", "quần âu"], zh: ["西裤"], role: "PRODUCT", example: "quần tây nam trung niên" },
  { key: "jeans", label: "Quần jean", vi: ["quần jean", "quần bò"], zh: ["牛仔裤"], role: "PRODUCT", example: "quần jean co giãn size lớn" },
  { key: "shorts", label: "Quần short", vi: ["quần short", "quần đùi", "quần sooc"], zh: ["短裤"], role: "PRODUCT", example: "quần short nam mùa hè" },
  { key: "wide-pants", label: "Quần ống rộng", vi: ["quần ống rộng", "quần suông"], zh: ["阔腿裤"], role: "PRODUCT", example: "quần ống rộng lụa cho mẹ" },
  { key: "set", label: "Đồ bộ", vi: ["đồ bộ", "bộ đồ", "set đồ"], zh: ["套装"], role: "PRODUCT", example: "đồ bộ trung niên mặc mùa hè" },
  { key: "homewear", label: "Đồ ngủ / mặc nhà", vi: ["đồ ngủ", "đồ mặc nhà", "đồ mặc ở nhà"], zh: ["家居服", "睡衣"], role: "PRODUCT", example: "đồ ngủ cotton cho mẹ" },
  { key: "clothes", label: "Quần áo", vi: ["quần áo"], zh: ["服装"], role: "PRODUCT", example: "quần áo trung niên size lớn" },

  // ── Người mặc ──
  { key: "for-mom", label: "Cho mẹ", vi: ["cho mẹ", "mẹ", "đồ mẹ", "nữ trung niên", "trung niên nữ", "u50"], zh: ["妈妈装", "中老年女装"], role: "AUDIENCE", example: "đầm suông che bụng cho mẹ" },
  { key: "for-dad", label: "Cho bố", vi: ["cho bố", "bố", "đồ bố"], zh: ["爸爸装", "中年男装"], role: "AUDIENCE", example: "áo polo cho bố" },
  { key: "men-middle-aged", label: "Nam trung niên", vi: ["nam trung niên", "trung niên nam"], zh: ["中年男士", "爸爸装"], role: "AUDIENCE", example: "áo sơ mi nam trung niên size lớn" },
  { key: "middle-aged", label: "Trung niên", vi: ["trung niên"], zh: ["中老年"], role: "AUDIENCE", note: "Khách 35–60.", example: "đồ bộ trung niên mặc mùa hè" },
  { key: "elderly", label: "Người già", vi: ["người già", "người cao tuổi", "ông bà"], zh: ["老年人"], role: "AUDIENCE", example: "áo khoác len cho người già" },
  { key: "women", label: "Nữ", vi: ["nữ"], zh: ["女"], role: "AUDIENCE", example: "áo vest nữ công sở" },
  { key: "men", label: "Nam", vi: ["nam"], zh: ["男"], role: "AUDIENCE", example: "quần short nam mùa hè" },

  // ── Mùa ──
  { key: "summer", label: "Mùa hè", vi: ["mùa hè", "hè", "mùa hạ", "mặc mùa hè"], zh: ["夏季", "夏装"], role: "SEASON", example: "quần lụa mát mùa hè" },
  { key: "winter", label: "Mùa đông", vi: ["mùa đông", "mặc mùa đông"], zh: ["冬季", "冬装"], role: "SEASON", example: "áo khoác mùa đông trung niên" },
  { key: "autumn-winter", label: "Thu đông", vi: ["thu đông"], zh: ["秋冬"], role: "SEASON", example: "áo len thu đông cho mẹ" },
  { key: "spring-summer", label: "Xuân hè", vi: ["xuân hè"], zh: ["春夏"], role: "SEASON", example: "đầm xuân hè dáng suông" },

  // ── Phong cách / hoạ tiết ──
  { key: "office", label: "Công sở", vi: ["công sở", "đi làm", "văn phòng"], zh: ["通勤", "职业"], role: "STYLE", example: "áo vest nữ công sở" },
  { key: "party", label: "Đi tiệc", vi: ["đi tiệc", "dự tiệc", "đám cưới"], zh: ["宴会"], role: "STYLE", example: "đầm đi tiệc cho mẹ" },
  { key: "casual", label: "Đi chơi", vi: ["đi chơi", "dạo phố"], zh: ["休闲"], role: "STYLE", example: "váy hoa nhí đi chơi" },
  { key: "elegant", label: "Sang trọng", vi: ["sang trọng", "sang", "quý phái", "thanh lịch"], zh: ["气质", "高贵"], role: "STYLE", example: "đầm lụa sang trọng cho mẹ" },
  { key: "youthful", label: "Trẻ trung", vi: ["trẻ trung", "trẻ"], zh: ["减龄", "洋气"], role: "STYLE", example: "đầm trẻ trung cho mẹ" },
  { key: "floral", label: "Hoa nhí", vi: ["hoa nhí", "hoạ tiết hoa", "họa tiết hoa", "in hoa"], zh: ["碎花"], role: "STYLE", example: "váy hoa nhí đi chơi" },
  { key: "plain", label: "Trơn", vi: ["trơn", "màu trơn"], zh: ["纯色"], role: "STYLE", example: "áo thun trơn cho bố" },
  { key: "stripe", label: "Kẻ sọc", vi: ["kẻ sọc", "sọc"], zh: ["条纹"], role: "STYLE", example: "áo sơ mi kẻ sọc nam" },

  // ── Chất liệu ──
  { key: "silk", label: "Lụa", vi: ["lụa", "lụa tơ tằm"], zh: ["真丝", "仿真丝"], role: "MATERIAL", note: "真丝 = lụa tơ tằm thật (đắt); hàng giá sỉ phần lớn là 仿真丝 (lụa nhân tạo) — đọc kỹ thành phần trên trang.", example: "quần lụa mát mùa hè" },
  { key: "ice-silk", label: "Lụa lạnh", vi: ["lụa lạnh", "lụa băng"], zh: ["冰丝"], role: "MATERIAL", example: "quần ống rộng lụa lạnh" },
  { key: "linen", label: "Vải lanh", vi: ["lanh", "vải lanh", "linen"], zh: ["亚麻", "棉麻"], role: "MATERIAL", example: "đầm lanh dáng suông" },
  { key: "cotton-linen", label: "Đũi", vi: ["đũi", "vải đũi"], zh: ["棉麻"], role: "MATERIAL", example: "đồ bộ đũi cho mẹ" },
  { key: "cotton", label: "Cotton", vi: ["cotton", "vải cotton", "cô tông"], zh: ["纯棉"], role: "MATERIAL", example: "áo thun cotton tay ngắn" },
  { key: "chiffon", label: "Voan", vi: ["voan", "vải voan", "chiffon"], zh: ["雪纺"], role: "MATERIAL", example: "áo kiểu voan cho mẹ" },
  { key: "denim", label: "Vải jean", vi: ["vải jean", "vải bò"], zh: ["牛仔"], role: "MATERIAL", example: "chân váy vải jean" },
  { key: "wool", label: "Len / dạ", vi: ["len", "vải len", "dạ"], zh: ["毛呢", "羊毛"], role: "MATERIAL", example: "áo khoác len cho người già" },
  { key: "lace", label: "Ren", vi: ["ren", "vải ren"], zh: ["蕾丝"], role: "MATERIAL", example: "đầm ren đi tiệc" },
  { key: "velvet", label: "Nhung", vi: ["nhung", "vải nhung"], zh: ["丝绒"], role: "MATERIAL", example: "đầm nhung mùa đông" },

  // ── Dáng ──
  { key: "loose", label: "Dáng suông", vi: ["suông", "dáng suông", "rộng", "dáng rộng", "form rộng"], zh: ["宽松"], role: "FIT", example: "đầm suông che bụng cho mẹ" },
  { key: "slim", label: "Dáng ôm", vi: ["ôm", "dáng ôm", "ôm body"], zh: ["修身"], role: "FIT", example: "đầm ôm đi tiệc" },
  { key: "a-line", label: "Dáng chữ A", vi: ["chữ a", "dáng chữ a", "xoè", "xòe"], zh: ["A字"], role: "FIT", example: "chân váy dáng chữ a công sở" },
  { key: "long", label: "Dáng dài", vi: ["dài", "dáng dài", "qua gối"], zh: ["长款"], role: "FIT", example: "đầm dài cho mẹ" },

  // ── Chi tiết ──
  { key: "long-sleeve", label: "Tay dài", vi: ["tay dài"], zh: ["长袖"], role: "PART", example: "áo sơ mi tay dài nam" },
  { key: "short-sleeve", label: "Tay ngắn", vi: ["tay ngắn", "cộc tay", "tay cộc"], zh: ["短袖"], role: "PART", example: "áo thun cotton tay ngắn" },
  { key: "mid-sleeve", label: "Tay lỡ", vi: ["tay lỡ"], zh: ["中袖"], role: "PART", example: "đầm tay lỡ cho mẹ" },
  { key: "v-neck", label: "Cổ V", vi: ["cổ v", "cổ tim"], zh: ["V领"], role: "PART", example: "đầm cổ v dáng suông" },
  { key: "round-neck", label: "Cổ tròn", vi: ["cổ tròn"], zh: ["圆领"], role: "PART", example: "áo thun cổ tròn nam" },

  // ── Công dụng ──
  { key: "belly-cover", label: "Che bụng", vi: ["che bụng", "giấu bụng", "che khuyết điểm"], zh: ["遮肚显瘦", "遮肚"], role: "FEATURE", example: "đầm suông che bụng cho mẹ" },
  { key: "slimming", label: "Tôn dáng", vi: ["tôn dáng", "gọn dáng", "thon gọn", "hack dáng"], zh: ["显瘦"], role: "FEATURE", example: "đầm tôn dáng cho mẹ" },
  { key: "cool", label: "Mát", vi: ["mát", "thoáng mát", "thoáng"], zh: ["凉爽", "透气"], role: "FEATURE", example: "quần lụa mát mùa hè" },
  { key: "no-iron", label: "Không nhăn", vi: ["không nhăn", "chống nhăn"], zh: ["免烫", "抗皱"], role: "FEATURE", example: "áo sơ mi không nhăn cho bố" },
  { key: "stretch", label: "Co giãn", vi: ["co giãn", "giãn"], zh: ["弹力"], role: "FEATURE", example: "quần jean co giãn size lớn" },

  // ── Cỡ ──
  { key: "plus-size", label: "Size lớn", vi: ["size lớn", "cỡ lớn", "size to", "big size", "bigsize", "ngoại cỡ", "người béo", "người mập"], zh: ["大码"], role: "SIZE", example: "áo sơ mi nam trung niên size lớn" },
  { key: "free-size", label: "Freesize", vi: ["freesize", "free size"], zh: ["均码"], role: "SIZE", example: "đầm suông freesize" },
];

/**
 * TỪ NỐI — không mang nghĩa tìm hàng. Bộ sinh BỎ QUA và nói ra là đã bỏ (`ignored`), không lẫn vào `unmatched`. «cho», «đồ»…
 * nằm ở đây vì cụm dài hơn («cho mẹ», «đồ bộ») được thử TRƯỚC — chỉ khi đứng một mình chúng mới là từ nối.
 */
export const SOURCING_FILLER_WORDS: readonly string[] = ["cho", "của", "và", "với", "loại", "kiểu", "mẫu", "hàng", "cái", "chiếc", "các", "những", "dành", "tìm", "mua", "đồ", "mặc", "để", "có", "màu", "dáng", "thích", "muốn", "cần"];
