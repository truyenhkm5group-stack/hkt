/**
 * ═══════════ GẮN LẠI LƯỢT CHẠY AGENT VỀ ĐÚNG VIỆC ═══════════
 *
 * Sáu dòng đầu tiên của sổ `tech_agent_runs` đều nằm dưới việc `TECH-1` ("Đánh giá và đề xuất cải
 * thiện tốc độ trang vận đơn", R2) — một việc chúng phần lớn chưa bao giờ chạm tới.
 *
 * NGUYÊN NHÂN đã vá ở mã nguồn: CSDL tạm của máy CI rỗng nên bộ sinh mã cấp `TECH-1` cho việc gieo
 * lại, và cửa chép sổ gửi mã CỤC BỘ ấy đi; production tra thấy `TECH-1` CỦA MÌNH và gắn vào. Bản vá
 * làm CSDL tạm mang đúng mã production, và lượt TỰ KIỂM thì không gửi mã nào cả.
 *
 * Còn lại là những dòng ĐÃ GHI. Script này sửa chúng.
 *
 * ─── KHÔNG ĐOÁN, VÀ ĐÓ LÀ ĐIỂM KHÁC BIỆT ───
 *
 * AGENTS.md mục 35 cấm đoán người/việc cho dòng lịch sử. Nên script này KHÔNG suy diễn từ dữ liệu:
 * nó nhận một BẢN KHAI tường minh trên dòng lệnh, mỗi mục là `<external_ref>=<mã việc|->`. Người
 * khai phải có bằng chứng cho từng dòng (ô `task` của lượt dispatch trên GitHub), và bản khai ấy đi
 * vào commit — đọc lại được, cãi lại được.
 *
 * Dấu `-` nghĩa là **không thuộc việc nào**: đúng với lượt tự kiểm, và cửa nhận vốn đã cho phép
 * `task_id` để trống. Gỡ liên kết KHÔNG phải xoá dữ liệu — dòng sổ, cổng, tệp đã đổi vẫn nguyên.
 *
 * ─── CHẠY THỬ LÀ MẶC ĐỊNH ───
 *
 *   npm run agent:reattach -- github:123:1=TECH-2 github:456:1=-      # chỉ báo cáo
 *   npm run agent:reattach -- --apply github:123:1=TECH-2             # ghi thật
 *
 * Báo cáo in TRƯỚC và SAU cho từng dòng. Không có mục nào khớp thì nói ra và trả mã thoát khác 0 —
 * một lượt sửa không sửa được gì mà im lặng là một lượt sửa người ta tưởng đã chạy.
 */
import "dotenv/config";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { docBanKhai } from "@/lib/constants/agent-run-reattach";
import { ensureMigrated } from "@/db/migrate";

async function main() {
  const apply = process.argv.includes("--apply");
  const { muc, loi } = docBanKhai(process.argv.slice(2));
  for (const l of loi) console.error(`✗ ${l}`);
  if (loi.length) process.exit(1);
  if (!muc.length) {
    console.error("Không có mục nào. Dùng: npm run agent:reattach -- [--apply] <external_ref>=<mã việc|->");
    process.exit(1);
  }

  await ensureMigrated();
  const db = await getDb();
  console.log(apply ? "═══ GHI THẬT ═══" : "═══ CHẠY THỬ (thêm --apply để ghi) ═══");

  let doi = 0;
  let giuNguyen = 0;
  let khongThay = 0;
  for (const m of muc) {
    const run = await db.query.techAgentRuns.findFirst({
      where: eq(schema.techAgentRuns.externalRef, m.externalRef),
      columns: { id: true, taskId: true, agentKey: true, branch: true },
    });
    if (!run) {
      console.log(`✗ ${m.externalRef}: KHÔNG có trong sổ — bỏ qua.`);
      khongThay += 1;
      continue;
    }
    const truoc = run.taskId
      ? (await db.query.techTasks.findFirst({ where: eq(schema.techTasks.id, run.taskId), columns: { code: true } }))?.code ?? "(việc đã xoá)"
      : "(không gắn)";

    let taskIdMoi: string | null = null;
    if (m.taskCode) {
      const t = await db.query.techTasks.findFirst({ where: eq(schema.techTasks.code, m.taskCode), columns: { id: true } });
      if (!t) {
        console.log(`✗ ${m.externalRef}: không có việc "${m.taskCode}" trong sổ — bỏ qua, KHÔNG gỡ liên kết hiện có.`);
        khongThay += 1;
        continue;
      }
      taskIdMoi = t.id;
    }
    const sau = m.taskCode ?? "(không gắn)";
    if (run.taskId === taskIdMoi) {
      console.log(`· ${m.externalRef}: đã đúng (${sau}) — không đụng.`);
      giuNguyen += 1;
      continue;
    }
    console.log(`→ ${m.externalRef} [${run.agentKey} · ${run.branch}]: ${truoc}  ⇒  ${sau}`);
    if (apply) await db.update(schema.techAgentRuns).set({ taskId: taskIdMoi }).where(eq(schema.techAgentRuns.id, run.id));
    doi += 1;
  }

  console.log(`\n${apply ? "Đã ghi" : "Sẽ ghi"}: ${doi} · đã đúng sẵn: ${giuNguyen} · không tìm thấy: ${khongThay}`);
  /*
    KHÔNG TÌM THẤY DÒNG NÀO LÀ MỘT KẾT QUẢ, KHÔNG PHẢI MỘT KHOẢNG LẶNG.

    Một lượt sửa chạy xong, in vài dòng, và không sửa gì — người đọc sẽ tưởng nó đã sửa. Trả mã
    thoát khác 0 để lượt chạy ops đỏ lên và có người đi đọc lại bản khai.
  */
  if (khongThay) process.exit(1);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("✗ Hỏng:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
