import type { AgentStep } from "@/lib/agents/executor";

/**
 * ═══════════ VẾT BƯỚC CỦA MỘT LƯỢT CHẠY — THỨ DUY NHẤT TRẢ LỜI "NÓ ĐÃ LÀM GÌ" ═══════════
 *
 * Executor ghi lại từng bước (`AgentStep`), và trước 23/09/2026 danh sách ấy bị VỨT ĐI ở cuối mỗi
 * lượt chạy: nó chỉ được dùng một lần cho nhánh vá cổng đỏ, rồi không ai lưu.
 *
 * Cái giá đã đo được. Việc TECH-6, lượt chạy #45: **24 vòng · $0,7681 · 132.870 token đầu ra ·
 * KHÔNG commit**. Khối bằng chứng in ra đúng ba dòng dùng được — trạng thái `FAILED`, "chưa gọi
 * finish", và tên một tệp. Không dòng nào nói agent đã ĐỌC gì, GHI bao nhiêu lần, hay vấp vào
 * đâu. Tôi dựng được một giả thuyết hợp lý từ con số token, và **không chứng minh được nó** — mà
 * một giả thuyết không kiểm được thì không đáng để sửa mã theo.
 *
 * Nên lượt chạy phải để lại vết. Không phải nội dung — kho mã này PUBLIC và nội dung đã nằm ở PR
 * — mà là HÌNH DẠNG: đọc mấy lần, ghi mấy lần, vào tệp nào, bao nhiêu byte, bị chặn mấy lần.
 *
 * ─── VÌ SAO ĐẾM BYTE CHỨ KHÔNG CHỈ ĐẾM LƯỢT ───
 *
 * `write_file` GHI ĐÈ TOÀN BỘ tệp. Sửa một dòng trong tệp 660 dòng và viết lại cả tệp là hai
 * việc không phân biệt được nếu chỉ đếm "1 lượt ghi". Số byte phân biệt được, và nó là con số
 * duy nhất cho biết một lượt chạy có đang viết lại cùng một thứ nhiều lần hay không.
 */

export type VetBuoc = {
  doc: number;
  ghi: number;
  lenh: number;
  chan: number;
  /** Ghi chú của chính runner (nhắc gọi finish, vá cổng…) — KHÔNG phải hành động của agent. */
  ghiChu: number;
  /** Theo tệp: số lượt ghi và TỔNG byte đã ghi. Nhiều lượt × byte lớn = viết lại cả tệp. */
  theoTep: { path: string; luotGhi: number; tongByte: number }[];
};

/** Tối đa bao nhiêu tệp được kể tên. Vết là để đọc, không phải để xuất kho. */
export const VET_TOI_DA_TEP = 12;

/**
 * Hàm THUẦN: gom danh sách bước thành một vết đọc được.
 *
 * `detail` của bước GHI mang câu mô tả của workspace, không mang nội dung — nên số byte lấy từ
 * chính câu ấy khi nó có, và `0` khi không. `0` ở đây nghĩa là CHƯA ĐO ĐƯỢC, và cột tổng byte
 * bằng 0 phải đọc như vậy chứ không phải "ghi tệp rỗng".
 */
export function tomTatBuoc(steps: readonly AgentStep[]): VetBuoc {
  const theo = new Map<string, { luotGhi: number; tongByte: number }>();
  let doc = 0, ghi = 0, lenh = 0, chan = 0, ghiChu = 0;
  for (const s of steps) {
    if (s.kind === "READ") doc += 1;
    else if (s.kind === "COMMAND") lenh += 1;
    else if (s.kind === "BLOCKED") chan += 1;
    else if (s.kind === "NOTE") ghiChu += 1;
    else if (s.kind === "WRITE") {
      ghi += 1;
      const cu = theo.get(s.path) ?? { luotGhi: 0, tongByte: 0 };
      const m = /(\d+)\s*(?:byte|ký tự|ky tu)/i.exec(s.detail ?? "");
      theo.set(s.path, { luotGhi: cu.luotGhi + 1, tongByte: cu.tongByte + (m ? Number(m[1]) : 0) });
    }
  }
  const theoTep = [...theo.entries()]
    .map(([path, v]) => ({ path, ...v }))
    .sort((a, b) => b.tongByte - a.tongByte || b.luotGhi - a.luotGhi)
    .slice(0, VET_TOI_DA_TEP);
  return { doc, ghi, lenh, chan, ghiChu, theoTep };
}

/** Một dòng đọc được cho khối bằng chứng. Rỗng ⇒ nói thẳng là rỗng, không in một dòng trống. */
export function inVetBuoc(v: VetBuoc): string {
  const dau = `đọc ${v.doc} · ghi ${v.ghi} · lệnh ${v.lenh} · bị chặn ${v.chan}`;
  if (!v.theoTep.length) return `${dau} · không ghi tệp nào`;
  const tep = v.theoTep.map((t) => `${t.path} (${t.luotGhi}× · ${t.tongByte} byte)`).join(" · ");
  return `${dau} · ${tep}`;
}
