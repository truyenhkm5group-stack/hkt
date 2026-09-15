/**
 * ═══════════ ĐỒ THỊ PHỤ THUỘC CỦA MỘT CHÍNH SÁCH LƯƠNG ═══════════
 *
 * ─── HÔM NAY ĐỒ THỊ NÀY KHÔNG CÓ CẠNH NÀO, VÀ ĐÓ LÀ CHỦ Ý ───
 *
 * Một thành phần chỉ lấy đại lượng từ `PAYROLL_INPUTS` — một sổ ĐÓNG, và không mục nào trong sổ ấy
 * đọc từ kết quả của một thành phần khác. Nên `A → B → C → A` **không dựng được** bằng giao diện
 * hiện tại.
 *
 * Vậy vì sao vẫn viết tệp này?
 *
 * Vì "không dựng được" là một tính chất của HÔM NAY, không phải một ràng buộc. Ngày nào có người
 * thêm một đại lượng kiểu "kết quả của thành phần X" — và đó là thứ người ta sẽ muốn, vì "thưởng
 * 5% trên tổng hoa hồng" là một yêu cầu rất tự nhiên — thì vòng tròn xuất hiện ngay, và nó KHÔNG
 * nổ ra lỗi: máy sẽ đọc `undefined`, nhân ra `NaN`, và `NaN` in ra màn hình thành "—" như một chỗ
 * trống bình thường.
 *
 * Nên đồ thị được dựng SẴN, kiểm SẴN, và có bài kiểm khoá cả hai chiều: hôm nay không có cạnh nào,
 * và nếu có cạnh thì vòng phải bị bắt TRƯỚC khi tính.
 *
 * ─── PHÁT HIỆN BẰNG DFS BA MÀU, KHÔNG BẰNG ĐẾM ĐỘ SÂU ───
 *
 * Đếm độ sâu rồi dừng ở một ngưỡng là cách "phát hiện" vòng mà không biết vòng nằm ở đâu — và nó
 * cũng chặn nhầm một chuỗi phụ thuộc dài nhưng hợp lệ. DFS ba màu trả về ĐÚNG chuỗi tạo vòng, nên
 * câu báo lỗi chỉ được vào đúng chỗ người khai phải sửa.
 */
import { componentBasisKey, type PolicyComponent } from "@/lib/constants/payroll-components";

/** Một cạnh: thành phần `from` cần kết quả của thành phần `to`. */
export type ComponentEdge = { from: string; to: string };

export type CycleFinding = {
  /** Chuỗi tạo vòng, theo đúng thứ tự, phần tử đầu lặp lại ở cuối: `A → B → C → A`. */
  chain: string[];
  message: string;
};

/**
 * ĐẠI LƯỢNG NÀO TRỎ VÀO MỘT THÀNH PHẦN KHÁC.
 *
 * Quy ước khoá: `COMPONENT:<code>`. Chưa có đại lượng nào như thế trong `PAYROLL_INPUTS` — hàm này
 * là chỗ nhận diện chúng NẾU một ngày có, chứ không phải chỗ khai chúng.
 */
export const COMPONENT_REF_PREFIX = "COMPONENT:";

export function componentRef(basisKey: string | null): string | null {
  if (!basisKey || !basisKey.startsWith(COMPONENT_REF_PREFIX)) return null;
  return basisKey.slice(COMPONENT_REF_PREFIX.length);
}

/** Dựng đồ thị từ danh sách thành phần của MỘT phiên bản. */
export function buildDependencyGraph(components: readonly PolicyComponent[]): ComponentEdge[] {
  const edges: ComponentEdge[] = [];
  for (const c of components) {
    const ref = componentRef(componentBasisKey(c.calc));
    if (ref) edges.push({ from: c.code, to: ref });
  }
  return edges;
}

/**
 * TÌM MỌI VÒNG TRONG ĐỒ THỊ. Rỗng = không có vòng.
 *
 * DFS ba màu: trắng (chưa thăm) · xám (đang trên ngăn xếp) · đen (đã xong). Gặp một đỉnh XÁM nghĩa
 * là vừa quay lại một đỉnh còn đang mở — đó chính là vòng, và ngăn xếp hiện tại LÀ chuỗi tạo ra nó.
 */
export function findCycles(components: readonly PolicyComponent[]): CycleFinding[] {
  const edges = buildDependencyGraph(components);
  if (!edges.length) return [];
  const ke = new Map<string, string[]>();
  for (const e of edges) ke.set(e.from, [...(ke.get(e.from) ?? []), e.to]);

  const mau = new Map<string, "XAM" | "DEN">();
  const nganXep: string[] = [];
  const found: CycleFinding[] = [];
  const daBao = new Set<string>();

  const tenCua = (code: string) => components.find((c) => c.code === code)?.label ?? code;

  const di = (node: string) => {
    mau.set(node, "XAM");
    nganXep.push(node);
    for (const ke2 of ke.get(node) ?? []) {
      if (mau.get(ke2) === "XAM") {
        const batDau = nganXep.indexOf(ke2);
        const chain = [...nganXep.slice(batDau), ke2];
        // Một vòng có thể gặp lại từ nhiều đỉnh; báo MỘT lần cho mỗi tập đỉnh.
        const khoa = [...chain].sort().join("|");
        if (!daBao.has(khoa)) {
          daBao.add(khoa);
          found.push({
            chain,
            message: `Phụ thuộc vòng tròn giữa các thành phần: ${chain.map(tenCua).join(" → ")}. Không có giá trị nào thoả — mỗi khoản là đầu vào của chính nó. Cắt một mắt xích trước khi phát hành.`,
          });
        }
        continue;
      }
      if (mau.get(ke2) !== "DEN") di(ke2);
    }
    nganXep.pop();
    mau.set(node, "DEN");
  };

  for (const c of components) if (!mau.has(c.code)) di(c.code);
  return found;
}

/**
 * THÀNH PHẦN TRỎ TỚI MỘT KHOẢN KHÔNG TỒN TẠI.
 *
 * Khác vòng tròn, nhưng cùng một hậu quả: máy đọc `undefined`, nhân ra `NaN`, và `NaN` in ra màn
 * hình thành "—" như một chỗ trống bình thường. Người đọc sẽ tưởng là chưa nhập số liệu.
 */
export function danglingRefs(components: readonly PolicyComponent[]): string[] {
  const co = new Set(components.map((c) => c.code));
  const out: string[] = [];
  for (const c of components) {
    const ref = componentRef(componentBasisKey(c.calc));
    if (ref && !co.has(ref)) {
      out.push(`Thành phần “${c.label}” lấy đại lượng từ khoản “${ref}”, nhưng phiên bản này không có khoản nào mang khoá đó.`);
    }
  }
  return out;
}
