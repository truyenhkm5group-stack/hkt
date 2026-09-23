import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  AGENTS,
  AGENT_EVIDENCE_PATHS,
  AGENT_ZONES,
  AI_RUNGS,
  AI_STATUSES,
  DEPARTMENTS_WITHOUT_AGENT_ROW,
  RUNGS_WITHOUT_EVIDENCE,
  RUNGS_WITHOUT_MISSING,
  agentCoverage,
  nextRung,
} from "@/lib/constants/department-ai";
import { DEPARTMENTS_WITHOUT_MODULE, MODULE_GROUPS, MODULE_TITLES, NAV_MODULES, NO_MODULE_REASON, ZONE_ORDER, modulesOfZone } from "@/lib/constants/department-modules";
import { DEPARTMENT_CODES, DEPARTMENT_HINT, DEPARTMENT_LABEL, DEPARTMENT_ORDER, DEPARTMENT_TONE, TEAM_DEPARTMENT, TEAM_DEPARTMENT_DIVERGENCE } from "@/lib/constants/departments";
import { TEAM_ORDER } from "@/lib/constants/action-queue";

/**
 * ═══════════ BẢN ĐỒ PHÒNG BAN: MỘT CHỦ CHO MỖI MÀN HÌNH, VÀ KHÔNG KHAI KHỐNG MỘT AGENT NÀO ═══════════
 *
 * Bài kiểm này khoá ba thứ mà một lần "dọn dẹp" sau này rất dễ phá:
 *
 *  1. **Danh sách module sống ở ĐÚNG MỘT chỗ.** Trước 23/09/2026 nó nằm trong một client component và
 *     ba thứ khác đọc lại mã nguồn của nó bằng biểu thức chính quy. Nếu ai đó khai lại một mảng module
 *     thứ hai trong `components/app-sidebar.tsx` thì hai bảng sẽ trôi xa nhau, và cái sai sẽ là cái
 *     NÓI RẰNG có trang — người dùng bấm vào một mục menu không dẫn tới đâu.
 *
 *  2. **Mỗi phòng khai được nó sở hữu gì, hoặc khai vì sao không sở hữu gì.** Một ô rỗng trên bản đồ
 *     đọc như "phòng này không làm gì".
 *
 *  3. **Bảng AI agent không được tự khen.** Mọi nấc khai "đang chạy" phải trỏ tới TỆP CÓ THẬT, và mọi
 *     nấc chưa xong phải nói thiếu đúng cái gì. Đây là toàn bộ lý do bảng đó đáng đọc: nó là bản kiểm
 *     kê năng lực THẬT, không phải một lộ trình.
 */
export function testDepartmentMap() {
  /* ═══════════ 1 · SỔ PHÒNG BAN ═══════════ */
  assert.deepEqual(
    [...DEPARTMENT_ORDER].sort(),
    [...DEPARTMENT_CODES].sort(),
    "thứ tự hiển thị phải là một hoán vị ĐỦ của danh sách phòng ban — thiếu một phòng là phòng đó biến mất khỏi mọi màn hình xếp theo thứ tự này",
  );
  assert.equal(new Set(DEPARTMENT_ORDER).size, DEPARTMENT_ORDER.length, "thứ tự hiển thị không được lặp một phòng");
  for (const code of DEPARTMENT_CODES) {
    assert.ok(DEPARTMENT_LABEL[code]?.trim(), `phòng ${code} thiếu nhãn tiếng Việt`);
    assert.ok((DEPARTMENT_HINT[code] ?? "").trim().length > 20, `phòng ${code} phải nói một câu về việc của nó`);
    assert.ok(DEPARTMENT_TONE[code]?.includes("dark:"), `phòng ${code} phải có màu cho cả nền sáng và nền tối`);
  }

  /*
    CHỖ LỆCH GIỮA "SỞ HỮU MÀN HÌNH" VÀ "NHẬN VIỆC" PHẢI ĐƯỢC KHAI, KHÔNG ĐƯỢC ĐỂ TRÔNG NHƯ LỖI.

    Nhóm việc `PRODUCTION` trỏ về phòng `WAREHOUSE` trong khi phòng `PRODUCTION` đã tồn tại — đúng là
    hình dạng của một chỗ quên sửa, nên nếu không khai thì một ngày có người "sửa hộ" và việc tồn kho
    rơi vào một phòng chưa có ai. Luật: tên nhóm việc trùng một mã phòng ban mà lại route sang phòng
    khác thì BẮT BUỘC có một dòng trong `TEAM_DEPARTMENT_DIVERGENCE` kèm lý do.
  */
  for (const team of TEAM_ORDER) {
    const routed = TEAM_DEPARTMENT[team];
    const trungTen = (DEPARTMENT_CODES as readonly string[]).includes(team);
    if (!trungTen || routed === team) continue;
    const khai = TEAM_DEPARTMENT_DIVERGENCE.find((d) => d.team === team);
    assert.ok(khai, `nhóm việc ${team} trùng tên một phòng ban nhưng route sang ${routed} mà KHÔNG khai lý do — thêm một dòng vào TEAM_DEPARTMENT_DIVERGENCE`);
    assert.equal(khai!.routedTo, routed, `dòng khai của ${team} nói route tới ${khai!.routedTo} nhưng TEAM_DEPARTMENT nói ${routed} — bảng khai phải nói đúng thứ đang chạy`);
  }
  for (const d of TEAM_DEPARTMENT_DIVERGENCE) {
    assert.notEqual(d.routedTo, d.modulesOwnedBy, `dòng ${d.team} không còn là một chỗ lệch — xoá nó khỏi bảng khai`);
    assert.ok(d.why.trim().length > 60, `chỗ lệch ${d.team} phải nói VÌ SAO, đủ để người đọc sau hiểu mà không phải đi hỏi`);
  }

  /* ═══════════ 2 · SỔ MODULE ═══════════ */
  const hrefs = NAV_MODULES.map((m) => m.href as string);
  assert.equal(new Set(hrefs).size, hrefs.length, `sổ module có đường dẫn trùng: ${hrefs.filter((h, i) => hrefs.indexOf(h) !== i).join(", ")}`);
  for (const m of NAV_MODULES) {
    assert.ok(m.label.trim(), `module ${m.href} thiếu nhãn`);
    assert.ok(m.why.trim().length > 30, `module ${m.href} phải nói VÌ SAO phòng ${m.zone} sở hữu nó — không có câu này thì lần sắp xếp sau là một lượt đoán`);
    assert.ok(m.href.startsWith("/"), `module ${m.href} phải là một đường dẫn tuyệt đối`);
  }

  // Mọi vùng phải nằm trong thứ tự hiển thị, và mọi module phải thuộc đúng một nhóm được vẽ.
  for (const m of NAV_MODULES) assert.ok(ZONE_ORDER.includes(m.zone), `module ${m.href} khai vùng ${m.zone} không có trong ZONE_ORDER nên sẽ KHÔNG hiện trên menu`);
  assert.equal(
    MODULE_GROUPS.reduce((n, g) => n + g.items.length, 0),
    NAV_MODULES.length,
    "tổng số mục của các nhóm phải bằng số module trong sổ — lệch nghĩa là có module không thuộc nhóm nào và biến mất khỏi menu",
  );
  assert.ok(modulesOfZone("EVERYONE").length > 0, "nhóm 'Hôm nay' không được rỗng — đó là ba màn hình mọi người mở đầu ngày");
  assert.ok(modulesOfZone("SYSTEM").length > 0, "nhóm 'Hệ thống' không được rỗng");

  assert.deepEqual(DEPARTMENTS_WITHOUT_MODULE, [], "phòng không sở hữu màn hình nào phải khai lý do ở NO_MODULE_REASON — một ô rỗng đọc như 'phòng này không làm gì'");
  for (const [code, reason] of Object.entries(NO_MODULE_REASON)) {
    assert.ok((reason ?? "").trim().length > 80, `lý do phòng ${code} chưa có màn hình phải nói cả CHỖ VIỆC CỦA HỌ ĐANG NẰM, không chỉ nói "chưa có"`);
    assert.equal(modulesOfZone(code as (typeof DEPARTMENT_CODES)[number]).length, 0, `phòng ${code} đã có màn hình riêng — xoá dòng khai ở NO_MODULE_REASON, nếu không bản đồ vừa liệt kê màn hình vừa nói là chưa có`);
  }

  /*
    THANH BÊN KHÔNG ĐƯỢC GIỮ MỘT DANH SÁCH MODULE THỨ HAI.

    Quét mã nguồn ở mức thô nhất có thể để không phụ thuộc cách viết: một khai báo module luôn phải
    khai QUYỀN, nên `permission: "` xuất hiện trong `app-sidebar.tsx` là dấu hiệu danh sách đã bị chép
    lại vào đó. Tệp ấy chỉ được đọc `item.permission` của sổ khai.
  */
  const sidebar = readFileSync("components/app-sidebar.tsx", "utf8");
  assert.ok(!sidebar.includes('permission: "'), "components/app-sidebar.tsx đang khai quyền cho một module — danh sách module chỉ được sống ở lib/constants/department-modules.ts");
  assert.ok(sidebar.includes("MODULE_GROUPS"), "thanh bên phải đọc MODULE_GROUPS từ sổ khai, không tự dựng nhóm");
  // Mỗi module phải có icon: `Record<ModuleHref, …>` đã chặn ở mức biên dịch, kiểm lại ở mức chữ để
  // một lần đổi kiểu thành `Record<string, …>` không âm thầm mở lại cửa.
  for (const h of hrefs) assert.ok(sidebar.includes(`"${h}":`), `module ${h} chưa có icon trong MODULE_ICON của components/app-sidebar.tsx`);

  for (const h of hrefs) assert.ok(MODULE_TITLES[h], `module ${h} thiếu tiêu đề cho breadcrumb`);

  /* ═══════════ 3 · SỔ AI AGENT ═══════════ */
  assert.deepEqual(DEPARTMENTS_WITHOUT_AGENT_ROW, [], "mọi phòng phải có một dòng trong bảng AI — phòng thiếu dòng thì không ai biết nó đang ở nấc nào");
  assert.deepEqual(RUNGS_WITHOUT_MISSING, [], "nấc chưa xong phải khai THIẾU CÁI GÌ, cụ thể tới mức sửa được");
  assert.deepEqual(RUNGS_WITHOUT_EVIDENCE, [], "nấc khai 'đang chạy' mà không có tệp bằng chứng nào là một lời khai không kiểm được");

  /*
    LÁ CHẮN QUAN TRỌNG NHẤT CỦA BẢNG AI: MỌI Ô XANH PHẢI TRỎ TỚI TỆP CÓ THẬT.

    Không có phép kiểm này thì bảng năng lực trở thành bảng nguyện vọng trong đúng một lần sửa — và
    một bảng nguyện vọng làm chủ shop đầu tư sai chỗ, vì nó nói phòng kia đã xong trong khi chưa.
  */
  for (const p of AGENT_EVIDENCE_PATHS) {
    assert.ok(existsSync(p), `bảng AI khai bằng chứng "${p}" nhưng tệp đó KHÔNG TỒN TẠI — sửa đường dẫn, hoặc hạ trạng thái nấc đó xuống đúng sự thật`);
  }

  const VAGUE = ["hoàn thiện thêm", "cải thiện thêm", "TODO", "sẽ làm sau", "cần làm thêm"];
  for (const zone of AGENT_ZONES) {
    const spec = AGENTS[zone];
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(spec.measuredAt), `agent ${zone} phải ghi NGÀY ĐỌC MÃ NGUỒN dạng YYYY-MM-DD — một bảng năng lực không có ngày đo là một bảng không ai kiểm lại được`);
    assert.ok(spec.autonomyWhy.trim().length > 40, `agent ${zone} phải nói vì sao ở mức tự chủ đó`);
    if (spec.spec !== null) assert.ok(existsSync(spec.spec), `agent ${zone} trỏ tới đặc tả "${spec.spec}" không tồn tại`);
    if (spec.home !== null) assert.ok(MODULE_TITLES[spec.home], `agent ${zone} lấy "${spec.home}" làm lối vào nhưng đó không phải một module có mục menu`);

    /*
      MỨC `AUTO` LÀ MỘT QUYẾT ĐỊNH CỦA CHỦ SHOP, KHÔNG PHẢI MỘT GIÁ TRỊ AI CŨNG ĐẶT ĐƯỢC.

      Mở `AUTO` là cho một cỗ máy ghi ra ngoài mà không chờ người. Nên nó phải có đặc tả và phải nói
      được NGÀY chủ shop quyết. Hôm nay không phòng nào ở mức đó.
    */
    if (spec.autonomy === "AUTO") {
      assert.ok(spec.spec !== null, `agent ${zone} khai mức AUTO nhưng không có đặc tả — mức đó không được mở bằng một dòng hằng số`);
      assert.match(spec.autonomyWhy, /\d{2}\/\d{2}\/\d{4}/, `agent ${zone} khai mức AUTO thì phải nói NGÀY chủ shop quyết mở`);
    }

    for (const r of AI_RUNGS) {
      const st = spec.rungs[r];
      assert.ok((AI_STATUSES as readonly string[]).includes(st.status), `nấc ${zone}:${r} khai trạng thái lạ`);
      assert.ok(st.what.trim().length > 20, `nấc ${zone}:${r} phải nói máy đang làm gì (hoặc không làm gì) bằng một câu việc thật`);
      if (st.missing) {
        assert.ok(st.missing.trim().length > 40, `nấc ${zone}:${r} khai thiếu quá ngắn để làm được gì với nó`);
        for (const v of VAGUE) assert.ok(!st.missing.includes(v), `nấc ${zone}:${r} khai thiếu bằng một câu chung chung ("${v}") — nói ra tệp / bảng / cột / quyền còn thiếu`);
      }
    }

    /*
      KHÔNG NẤC NÀO ĐƯỢC "ĐANG CHẠY" KHI MỘT NẤC THẤP HƠN CÒN `NONE`.

      Thang bậc không đảo được: một nấc BÀN TAY đang chạy trên một nấc ĐỀ NGHỊ chưa có là một cỗ máy
      ghi ra ngoài mà không có lý lẽ nào đứng sau. Nếu một ngày bảng này khai như vậy thì hoặc bảng
      sai, hoặc hệ thống đang làm đúng thứ đáng sợ nhất — cả hai đều phải dừng lại mà đọc.
    */
    let thayNone: string | null = null;
    for (const r of AI_RUNGS) {
      if (spec.rungs[r].status === "NONE") thayNone = thayNone ?? r;
      else if (spec.rungs[r].status === "BUILT" && thayNone) {
        assert.fail(`agent ${zone}: nấc ${r} khai đang chạy trong khi nấc thấp hơn ${thayNone} còn 'chưa có' — thang tự động hoá không đảo được`);
      }
    }

    const cover = agentCoverage(spec);
    assert.equal(cover.total, AI_RUNGS.length);
    const next = nextRung(spec);
    if (next === null) assert.equal(cover.built, cover.total, "không còn nấc nào phải làm thì cả năm nấc phải đang chạy");
    else assert.notEqual(spec.rungs[next].status, "BUILT", "nấc đáng làm tiếp không được là một nấc đã chạy");
  }

  // Phòng Tech AI là cột mốc so sánh: nếu một ngày nó không còn đủ năm nấc thì bảng mất mốc, và mọi
  // phòng khác chỉ còn so với một hình dung.
  assert.equal(nextRung(AGENTS.SYSTEM), null, "Phòng Tech AI phải đủ năm nấc — nó là phòng AI đã chạy thật và là mốc so sánh của bảng này");

  const daChay = AGENT_ZONES.filter((z) => nextRung(AGENTS[z]) === null).length;
  console.log(
    `✓ Bản đồ phòng ban: ${NAV_MODULES.length} module / ${MODULE_GROUPS.length} nhóm, ${DEPARTMENT_CODES.length} phòng đều khai được sở hữu gì · ` +
      `bảng AI ${AGENT_ZONES.length} phòng với ${AGENT_EVIDENCE_PATHS.length} tệp bằng chứng đều tồn tại, ${daChay} phòng đủ năm nấc`,
  );
}
