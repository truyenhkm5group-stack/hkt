/**
 * ═══════════ BẢN KHAI GẮN LẠI LƯỢT CHẠY AGENT — LUẬT THUẦN ═══════════
 *
 * Sổ `tech_agent_runs` có những dòng gắn sai việc (nguyên nhân đã vá ở mã nguồn). Sửa chúng là
 * một lượt ghi vào dữ liệu ĐÃ CÓ, nên câu hỏi quan trọng không phải "ghi thế nào" mà "lấy đâu ra
 * sự thật".
 *
 * AGENTS.md mục 35 cấm đoán người/việc cho dòng lịch sử. Nên luật ở đây KHÔNG suy diễn gì: nó chỉ
 * đọc một BẢN KHAI tường minh do người viết ra, mỗi mục là `<external_ref>=<mã việc|->`. Bản khai
 * đi vào lệnh chạy và vào commit — đọc lại được, cãi lại được.
 *
 * Dấu `-` nghĩa là KHÔNG THUỘC VIỆC NÀO: đúng với lượt tự kiểm, và cửa nhận vốn cho `task_id` để
 * trống. Một dạng SAI thì DỪNG, không đoán ý — `github:1:1` thiếu vế phải có thể là "gỡ liên kết"
 * hoặc "người gõ thiếu", và hai cách hiểu ấy cho hai kết quả khác hẳn nhau trên dữ liệu thật.
 */

/** Một mục trong bản khai: lượt chạy nào, về việc nào (`null` = không thuộc việc nào). */
export type BanKhai = { externalRef: string; taskCode: string | null };

export function docBanKhai(argv: readonly string[]): { muc: BanKhai[]; loi: string[] } {
  const muc: BanKhai[] = [];
  const loi: string[] = [];
  for (const a of argv) {
    if (a.startsWith("--")) continue;
    const i = a.indexOf("=");
    if (i <= 0) {
      loi.push(`Mục "${a}" không có dạng <external_ref>=<mã việc|->.`);
      continue;
    }
    const ref = a.slice(0, i).trim();
    const ma = a.slice(i + 1).trim();
    if (!ref) {
      loi.push(`Mục "${a}" thiếu external_ref.`);
      continue;
    }
    if (!ma) {
      loi.push(`Mục "${a}" thiếu vế phải — dùng "-" nếu muốn gỡ liên kết.`);
      continue;
    }
    muc.push({ externalRef: ref, taskCode: ma === "-" ? null : ma });
  }
  return { muc, loi };
}
