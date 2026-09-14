import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * ═══════════ SERVER ACTION KHAI RA MÀ KHÔNG NÚT NÀO GỌI ═══════════
 *
 * SỰ CỐ THẬT, LẶP LẠI BẢY LẦN trong ba ngày. Lần gần nhất là màn hình Ý tưởng marketing:
 * `deleteIdea`, `addIdeaImages`, `deleteIdeaImage` đều đã viết xong, có kiểm tra quyền đầy đủ, có
 * ghi nhật ký — và KHÔNG nút nào gọi tới. Trên thực tế marketer đăng nhầm một ảnh là chịu, quản lý
 * bảo "thêm ảnh góc khác" thì không thêm được. Tính năng có trong mã, không có trong tay người dùng.
 *
 * Sáu lần trước cùng một hình dạng: job không có lịch · phép nối không canh grain · lá chắn chi phí
 * canh sáu tệp · ranh giới ghi canh 15 tệp · khung xương canh 21 tuyến · lớp tăng tốc nối 2/25 tệp.
 *
 * Đây là loại lỗi KHÔNG bài kiểm nào bắt được bằng cách chạy: mã đúng, kiểm thử đơn vị xanh, không
 * ai lỗi. Nó chỉ lộ ra khi có người thật đi tìm một cái nút không tồn tại.
 *
 * Bài kiểm này đọc MÃ NGUỒN: mọi Server Action xuất khẩu phải có ít nhất một nơi gọi ngoài chính
 * tệp định nghĩa, hoặc được khai tường minh là chưa nối KÈM LÝ DO.
 *
 * Chạy riêng: npx tsx --tsconfig tsconfig.json tests/action-wiring.test.ts
 */

/**
 * Action CHƯA nối, và vì sao. Mỗi dòng là một món nợ được thừa nhận, không phải chỗ để giấu việc.
 *
 * Thêm một dòng vào đây là đang nói "người dùng chưa cần dùng nó, và tôi biết điều đó".
 */
const CHUA_NOI: Record<string, string> = {
  // Cổng phê duyệt hai bước: ba nhóm còn lại chưa có Server Action tương ứng để bọc.
  // Xem docs/second-approval-policy.md mục 6.
  // Cấu hình luật CSKH: đã có tầng hành động và hằng số mặc định, chưa có màn hình cấu hình. Shop
  // đang chạy với luật mặc định và chưa yêu cầu đổi, nên đây là nợ ĐƯỢC BIẾT chứ không phải bỏ sót.
  "lib/actions/cs.ts::saveCsRules": "chưa có màn hình cấu hình luật CSKH; shop đang dùng luật mặc định",
  // Ghi chú nội bộ cho đơn landing: cột đã có, tầng hành động đã có, chưa có ô nhập trên bảng.
  "lib/actions/landing.ts::setLandingNote": "chưa có ô ghi chú trên bảng đơn landing",
};

const goc = path.resolve(__dirname, "..");

/** Tên các Server Action xuất khẩu trong một tệp `lib/actions/*`. */
function actionsCua(tep: string): string[] {
  const src = readFileSync(path.join(goc, tep), "utf8");
  if (!src.includes('"use server"')) return [];
  return [...src.matchAll(/^export async function ([a-zA-Z0-9_]+)/gm)].map((m) => m[1]);
}

/** Mọi tệp có thể GỌI một action: giao diện, route, job, và các action khác. */
function nguonGoi(): string[] {
  const ket: string[] = [];
  const di = (thuMuc: string) => {
    for (const e of readdirSync(path.join(goc, thuMuc), { withFileTypes: true })) {
      const con = `${thuMuc}/${e.name}`;
      if (e.isDirectory()) di(con);
      else if (/\.(ts|tsx)$/.test(e.name)) ket.push(con);
    }
  };
  di("app");
  di("lib");
  di("components");
  return ket;
}

export function testActionWiring() {
  const tepAction = readdirSync(path.join(goc, "lib/actions"))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => `lib/actions/${f}`);
  assert.ok(tepAction.length > 10, `đọc hụt lib/actions (chỉ thấy ${tepAction.length} tệp)`);

  const tatCaNguon = nguonGoi();
  const noiDung = new Map(tatCaNguon.map((f) => [f, readFileSync(path.join(goc, f), "utf8")]));

  const treo: string[] = [];
  let tong = 0;

  for (const tep of tepAction) {
    for (const ten of actionsCua(tep)) {
      tong += 1;
      const khoa = `${tep}::${ten}`;
      if (khoa in CHUA_NOI) continue;
      // Gọi từ BẤT KỲ tệp nào khác tệp định nghĩa. Dùng biên từ để `deleteIdea` không khớp
      // `deleteIdeaImage`.
      const re = new RegExp(`\\b${ten}\\b`);
      const coNguoiGoi = tatCaNguon.some((f) => f !== tep && re.test(noiDung.get(f) ?? ""));
      if (!coNguoiGoi) treo.push(khoa);
    }
  }

  assert.deepEqual(
    treo.sort(),
    [],
    `Server Action khai ra mà KHÔNG NÚT NÀO GỌI:\n  ${treo.join("\n  ")}\n\n` +
      "Nối vào giao diện, hoặc khai vào CHUA_NOI kèm lý do. Tính năng có trong mã mà không có trong tay người dùng thì bằng không có.",
  );

  // Danh sách nợ phải sạch: khai cho action đã xoá là rác, và che mất ca thật.
  const thua = Object.keys(CHUA_NOI).filter((k) => {
    const [tep, ten] = k.split("::");
    return !tepAction.includes(tep) || !actionsCua(tep).includes(ten);
  });
  assert.deepEqual(thua, [], `CHUA_NOI còn khai action không còn tồn tại: ${thua.join(", ")}`);

  console.log(`✓ Nối Server Action: ${tong} action · ${Object.keys(CHUA_NOI).length} khai chưa nối có lý do · 0 action treo`);
}

// Chạy được độc lập, và cũng export để bộ kiểm thử chung dùng lại.
if (process.argv[1] && /action-wiring\.test\.ts$/.test(process.argv[1])) {
  try {
    testActionWiring();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
