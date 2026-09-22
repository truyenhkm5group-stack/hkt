import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { KY_LOAT_TOI_DA, nhanLoatKy, xetLoatKy } from "@/lib/constants/tech-approval-bulk";

/**
 * ═══════════ KÝ NHIỀU VIỆC MỘT LƯỢT — NHANH HƠN, KHÔNG LỎNG HƠN ═══════════
 *
 * Đo 22/09/2026: chín việc `TECH-4…TECH-12` cùng sinh ra từ MỘT bản kế hoạch mà chủ shop đã đọc và
 * duyệt cả bản — rồi vẫn phải mở chín trang để ký chín chữ ký cho đúng quyết định vừa đưa ra.
 *
 * Bài này khoá hai tính chất, và tính chất thứ hai mới là thứ giữ cổng:
 *
 *  1. Bộ điều kiện KHÔNG đổi: việc không cần duyệt thì không được ký, việc đã ở đúng trạng thái đó
 *     thì không ghi lại lần hai.
 *  2. Phần BỊ BỎ QUA phải nói ra, kèm lý do, và hai lý do không được gộp. Chọn chín dòng rồi thấy
 *     "đã ký 7" mà không biết hai dòng kia đi đâu còn tệ hơn không có nút.
 */

const goc = path.resolve(__dirname, "..");

export function testKyLoat() {
  const ds = [
    { code: "T-1", approvalRequired: true, approvalStatus: "PENDING" },
    { code: "T-2", approvalRequired: true, approvalStatus: "PENDING" },
    /* Không cần duyệt — ký một thứ không ai hỏi là làm bẩn sổ chữ ký. */
    { code: "T-3", approvalRequired: false, approvalStatus: "NOT_REQUIRED" },
    /* Đã duyệt rồi — ghi lại lần hai là đẩy mốc ký về lúc bấm nhầm (cùng lý lẽ mục 61). */
    { code: "T-4", approvalRequired: true, approvalStatus: "APPROVED" },
    /* Đã từ chối, nay người đổi ý ⇒ VẪN ký APPROVED được. */
    { code: "T-5", approvalRequired: true, approvalStatus: "REJECTED" },
  ];

  const duyet = xetLoatKy(ds, "APPROVED");
  assert.deepEqual(duyet.ky, ["T-1", "T-2", "T-5"], "ký đúng ba việc — kể cả việc đang REJECTED vì người có quyền đổi ý");
  assert.deepEqual(
    duyet.boQua,
    [
      { code: "T-3", vi: "KHONG_CAN" },
      { code: "T-4", vi: "DA_QUYET_ROI" },
    ],
    "hai việc bị bỏ qua vì HAI lý do khác nhau, và chúng không được gộp (mục 55)",
  );

  /*
    "ĐÃ Ở TRẠNG THÁI NÀY RỒI" PHỤ THUỘC VÀO THỨ ĐANG ĐỊNH LÀM.
    Cùng một danh sách, bấm TỪ CHỐI thì T-4 (đang APPROVED) lại ký được còn T-5 thì không.
  */
  const tuChoi = xetLoatKy(ds, "REJECTED");
  assert.deepEqual(tuChoi.ky, ["T-1", "T-2", "T-4"], "đổi quyết định thì tập việc ký được cũng đổi theo");
  assert.ok(
    tuChoi.boQua.some((b) => b.code === "T-5" && b.vi === "DA_QUYET_ROI"),
    "việc đang REJECTED thì bấm từ chối lần nữa là không ghi gì thêm",
  );

  /* Danh sách rỗng là hợp lệ và không ném lỗi — người dùng bỏ chọn hết là chuyện thường. */
  assert.deepEqual(xetLoatKy([], "APPROVED"), { ky: [], boQua: [] });

  /* ───────── CÂU TỔNG KẾT PHẢI MANG PHẦN BỎ QUA ĐI CÙNG ───────── */
  const cau = nhanLoatKy({ daKy: duyet.ky.length, boQua: duyet.boQua }, "APPROVED");
  assert.match(cau, /Đã ký duyệt 3 việc/);
  assert.match(cau, /bỏ qua 2/, "số bỏ qua phải đứng NGAY trong câu, không nằm ở chỗ khác");
  assert.match(cau, /T-3 — không cần phê duyệt/, "…và nói rõ từng mã vì lý do gì");
  assert.match(cau, /T-4 — đã ở đúng trạng thái này rồi/);

  assert.equal(nhanLoatKy({ daKy: 3, boQua: [] }, "APPROVED"), "Đã ký duyệt 3 việc", "không bỏ qua gì thì câu gọn, không thêm chữ thừa");
  assert.match(nhanLoatKy({ daKy: 2, boQua: [] }, "REJECTED"), /Đã từ chối 2 việc/, "hai quyết định in ra hai câu khác nhau");

  /* Gom theo lý do: chín dòng cùng một lý do đọc thành MỘT câu, không phải chín câu. */
  const nhieu = nhanLoatKy({ daKy: 0, boQua: [{ code: "A", vi: "KHONG_CAN" }, { code: "B", vi: "KHONG_CAN" }] }, "APPROVED");
  assert.match(nhieu, /A, B — không cần phê duyệt/, "cùng lý do thì gom lại một câu");

  assert.ok(KY_LOAT_TOI_DA > 0 && KY_LOAT_TOI_DA <= 100, "trần mỗi lượt phải là một con số người đọc hết được trước khi bấm");

  console.log("✓ Ký loạt: bộ điều kiện không đổi · 'đã quyết rồi' phụ thuộc quyết định đang làm · phần bỏ qua luôn nói ra kèm lý do");
}

/* ═════════════ QUÉT MÃ NGUỒN ═════════════ */

export function testKyLoatGuards() {
  const bo = (m: string) => m.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const act = bo(readFileSync(path.join(goc, "lib/actions/tech.ts"), "utf8"));
  const cto = bo(readFileSync(path.join(goc, "app/(dashboard)/tech/cto/page.tsx"), "utf8"));

  const khoi = act.slice(act.indexOf("decideTechApprovalBulkAction"));
  assert.ok(khoi.length > 0, "phải có đường ký loạt");
  const than = khoi.slice(0, khoi.indexOf("const xacMinhSchema"));

  /*
    ═══ MỖI VIỆC MỘT CHỮ KÝ, KHÔNG PHẢI MỘT LỆNH CHO CẢ LOẠT ═══

    Một `update ... where id in (...)` ký chín việc bằng một câu và để lại ĐÚNG MỘT vết — rồi sáu
    tháng sau không ai trả lời được "ai ký TECH-7, lúc nào". Đường ký loạt phải gọi lại ĐÚNG
    `decideTechApproval()` mà đường ký-từng-việc dùng, để mỗi việc có một dòng `APPROVAL` riêng.
  */
  assert.match(than, /await decideTechApproval\(/, "ký loạt phải đi qua hàm ký từng việc, không tự ghi");
  assert.doesNotMatch(than, /\.update\(/, "KHÔNG được ghi thẳng: một lệnh cho cả loạt chỉ để lại một vết");
  assert.doesNotMatch(than, /\bset\(/, "…kể cả dưới dạng `.set(`");

  /* Quyền phải y hệt đường ký từng việc — nhanh hơn không được đi kèm dễ hơn. */
  assert.match(than, /nguoiQuanTri\(\)/, "ký loạt dùng ĐÚNG một quyền với ký từng việc");

  /*
    TỪ CHỐI BẮT BUỘC NÊU LÝ DO Ở **CẢ HAI** ĐƯỜNG KÝ.

    Chỉ buộc ở đường ký loạt thì hàng rào có cửa sau: đường ký từng việc vẫn từ chối được mà không
    nói gì. Một luật có hai bản thì bản LỎNG HƠN là bản thật — nên đếm, chứ không chỉ tìm thấy một
    lần rồi thôi.
  */
  const soRangBuoc = [...act.matchAll(/decision !== "REJECTED" \|\| \(v\.note \?\? ""\)\.length >= 5/g)].length;
  assert.equal(soRangBuoc, 2, "cả đường ký TỪNG VIỆC lẫn đường ký LOẠT đều phải buộc nêu lý do khi từ chối");

  /*
    CỔNG PHÊ DUYỆT Ở TRANG VIỆC PHẢI HIỆN CẢ KHI ĐÃ TỪ CHỐI.

    `decideTechApproval()` cho đổi ý (việc `REJECTED` vẫn ký `APPROVED` được), nhưng màn hình cũ
    chỉ mời khi `PENDING` — nên việc bị từ chối là kẹt vĩnh viễn, dù dịch vụ không hề cấm.
  */
  const trangViec = bo(readFileSync(path.join(goc, "app/(dashboard)/tech/tasks/[id]/task-actions.tsx"), "utf8"));
  assert.match(trangViec, /approvalRequired && approvalStatus !== "APPROVED"/, "cổng duyệt phải hiện cả khi việc đang bị từ chối — logic mở thì màn hình không được đóng");
  assert.doesNotMatch(trangViec, /approvalRequired && approvalStatus === "PENDING"/, "KHÔNG quay lại điều kiện chỉ-PENDING");

  /*
    NÚT "ÁP LẠI" PHẢI CÓ TRÊN BẢN ĐÃ DUYỆT.

    `approveProposal()` xưa nay chạy lại được trên bản `APPROVED`, nhưng màn hình chỉ hiện nút khi
    còn `READY_FOR_REVIEW` — nên lượt áp bắt-kịp (gán vai, phân loại) không có đường nào chạm tới.
    Đã cắn thật 22/09/2026: chủ shop mở màn hình ra và không thấy nút nào để bấm.
  */
  assert.match(cto, /p\.status === "APPROVED" \?[\s\S]{0,400}?apLai/, "bản đã duyệt phải có nút áp lại");

  /*
    ═══ CỔNG NGƯỜI CÓ QUYỀN KHÔNG MỞ ĐƯỢC LÀ CỔNG HỎNG ═══

    `canDispatchTask()` từ chối một việc R2 bằng câu "Cấp mức cho vai ở /tech/agents". Nhưng màn
    hình ấy chỉ IN cột rủi ro và không có đường ghi nào — sản phẩm chỉ người dùng tới một cái nút
    không tồn tại. Đo production 22/09/2026: chủ shop bật đủ 12 vai mà 0/12 vai đổi được mức.

    Khoá ở mức mã nguồn: câu từ chối trỏ đi đâu thì ở đó phải có đường ghi thật.
  */
  const disp = bo(readFileSync(path.join(goc, "lib/constants/agent-dispatch.ts"), "utf8"));
  const agents = bo(readFileSync(path.join(goc, "app/(dashboard)/tech/agents/page.tsx"), "utf8"));
  const svc = bo(readFileSync(path.join(goc, "lib/tech/service.ts"), "utf8"));

  assert.match(disp, /\/tech\/agents/, "tiền đề: cổng giao việc trỏ người dùng tới /tech/agents");
  /*
    TÌM THẺ JSX, KHÔNG TÌM CÁI TÊN.

    Bản đầu tìm chuỗi `AgentRiskPicker` — mà DÒNG IMPORT vẫn mang chuỗi ấy sau khi thẻ bị gỡ, nên
    một lượt đột biến bỏ hẳn ô tích khỏi màn hình vẫn xanh (đo 22/09/2026, ĐB8 sống sót). Cùng lớp
    bẫy với chú thích và import đã cắn nhiều lần ở kho này.

    Bản vá THỨ HAI cũng hỏng, theo một kiểu tệ hơn: một `\b` viết qua một tầng escape bị ghi thành
    BYTE 0x08 (backspace) chứ không phải hai ký tự. Biểu thức khi ấy KHÔNG BAO GIỜ khớp, nên khẳng
    định luôn ĐỎ — và một lượt đột biến "bị bắt" chỉ là bắt nhầm, vì nó đỏ vì lý do khác hẳn.
    `tests/test-hygiene.test.ts` bắt được đúng byte ấy. Nay dùng lớp ký tự tường minh.
  */
  assert.match(agents, /<AgentRiskPicker[\s/>]/, "…nên màn hình đó PHẢI DỰNG ô sửa mức, không chỉ import rồi in ra cột chữ");
  assert.match(act, /setTechAgentRisksAction/, "…và phải có server action thật đứng sau");

  /* Cấp R2 là quyết định riêng và phải nêu lý do — mức chạm tiền không được nới trong im lặng. */
  /*
    CẮT ĐÚNG THÂN HÀM, KHÔNG CẮT THEO SỐ KÝ TỰ.

    Bản đầu dùng `slice(0, 2000)` và cửa sổ ấy chạm sang `setTechAgentEnabled` ngay bên dưới — hàm
    đó cũng có dòng `actor.kind !== "HUMAN"`, nên khẳng định khớp vào dòng của HÀM KHÁC và một lượt
    đột biến xoá hàng rào thật vẫn xanh (đo 22/09/2026, ĐB7 sống sót). Bài kiểm đo nhầm chỗ còn tệ
    hơn không có bài kiểm: nó phát một chứng nhận cho thứ nó chưa từng nhìn.
  */
  const iMuc = svc.indexOf("export async function setTechAgentRisks");
  assert.ok(iMuc > 0, "phải có đường ghi mức rủi ro của vai");
  const sauDo = svc.indexOf("export async function", iMuc + 40);
  const khoiMuc = svc.slice(iMuc, sauDo > 0 ? sauDo : undefined);
  assert.ok(khoiMuc.length < 4000, "thân hàm phải được cắt gọn, không nuốt hàm kế tiếp");

  assert.match(khoiMuc, /themR2[\s\S]{0,200}?reason[\s\S]{0,200}?length < 10/, "cấp R2 phải buộc nêu lý do");
  assert.match(khoiMuc, /actor\.kind !== "HUMAN"/, "chỉ NGƯỜI mới đổi được mức của một vai — agent tự nới mức của chính nó là hết chuyện");

  /* Danh sách ĐÓNG: không ô gõ tự do cho mức rủi ro (mục 30). */
  assert.match(act, /allowedRisks: z\.array\(z\.enum\(\["R0", "R1", "R2"\]\)\)/, "mức rủi ro phải là danh sách đóng ở lược đồ đầu vào");

  /* Giao diện ký loạt phải ĐẾM bằng đúng hàm luật, không chép lại điều kiện. */
  const thanh = bo(readFileSync(path.join(goc, "app/(dashboard)/tech/tasks/bulk-approve.tsx"), "utf8"));
  assert.match(thanh, /xetLoatKy\(/, "thanh thao tác phải đếm bằng hàm luật chung");
  /*
    ═══ MỖI QUYẾT ĐỊNH MỘT TẬP RIÊNG ═══

    Bản đầu tính danh sách ĐÚNG MỘT LẦN với `"APPROVED"` rồi lấy nó chặn CẢ HAI nút. Chín việc đã
    ký duyệt hết ⇒ danh sách rỗng ⇒ cả thanh biến mất, kể cả nút Từ chối — trong khi
    `decideTechApproval()` vẫn cho đổi ý. Chủ shop tích chọn được chín dòng mà không thấy nút nào,
    và báo lại đúng như vậy (22/09/2026).

    Lượt đột biến ĐB14 SỐNG SÓT lần đầu vì chưa có khẳng định nào khoá tính chất này — tức bản vá
    có thể bị gỡ lại bất cứ lúc nào mà không ai biết.
  */
  assert.match(thanh, /nhom\("REJECTED"\)/, "nút Từ chối phải có tập riêng, tính bằng chính hàm luật với quyết định của nó");
  assert.match(thanh, /nhom\("APPROVED"\)/, "…và nút Duyệt cũng vậy");
  assert.doesNotMatch(thanh, /canTuChoi = canDuyet/, "KHÔNG được dùng chung một tập cho hai nút — đó đúng là lỗi làm cả thanh biến mất");
  assert.match(thanh, /Duyệt \{canDuyet\.length\}/, "mỗi nút mang SỐ CỦA CHÍNH NÓ");
  assert.match(thanh, /Từ chối \{canTuChoi\.length\}/, "…kể cả nút Từ chối");

  assert.doesNotMatch(thanh, /approvalStatus === "PENDING"/, "KHÔNG chép lại điều kiện: bản đầu lọc PENDING nên nút nói 3 mà máy chủ ký 4");

  /*
    ═══ LUẬT R2 CHỈ CÓ MỘT BẢN ═══

    `scripts/agent-fetch-task.ts` từng chặn CỨNG mọi việc R2 bằng một dòng riêng. Khi cổng giao
    việc đổi sang cửa hẹp, bản sao ấy không đổi theo — và vì nó CHẶT hơn nên nó thắng. Đo
    22/09/2026: TECH-12 đi qua đủ mọi cổng của ERP, lấy được việc từ production, rồi chết ở đúng
    dòng đó. Cả dây chuyền đứng lại vì một bản sao bị bỏ quên.

    Khoá ở mức mã nguồn: nơi nào quyết định "R2 có đi tiếp được không" thì phải hỏi `chiSinhRaChu()`,
    không được tự viết lại điều kiện.
  */
  const fetchTask = bo(readFileSync(path.join(goc, "scripts/agent-fetch-task.ts"), "utf8"));
  assert.match(fetchTask, /chiSinhRaChu\(/, "bước lấy việc phải hỏi hàm luật chung, không tự chặn R2");
  assert.doesNotMatch(
    fetchTask,
    /risk === "R2"\)\s*\{\s*console\.error\("✗ DỪNG: R2 không bao giờ/,
    "KHÔNG quay lại lệnh cấm cứng — nó là bản thứ hai của một luật đã có chỗ ở",
  );

  console.log("✓ Quét mã nguồn: ký loạt đi qua hàm ký từng việc (không ghi thẳng) · cùng một quyền · từ chối buộc nêu lý do · bản đã duyệt có nút áp lại · câu từ chối trỏ tới màn hình CÓ đường ghi thật · thanh đếm bằng hàm luật chung · bước lấy việc dùng CHUNG luật R2, không tự chặn");
}
