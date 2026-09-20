import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { moTaLoiCsdl } from "@/lib/db/error-message";

/**
 * ═══════════ LỖI CSDL PHẢI NÓI ĐƯỢC NGUYÊN NHÂN ═══════════
 *
 * ─── ĐO THẬT TRÊN PRODUCTION (20/09/2026) ───
 *
 * Hai lượt đồng bộ `PARTIAL` lưu lại đúng câu này trong `sync_runs.error`:
 *
 *     Đơn 4686: Failed query: insert into "shipments" ("id", "order_id", "attempt_no",
 *     "direction", "carrier", … (còn hơn 30 cột nữa)
 *
 * Đọc xong vẫn không biết **vì sao**: trùng khoá? thiếu khoá ngoại? cột NOT NULL? quá độ dài? Bốn
 * nguyên nhân, bốn việc phải làm khác hẳn nhau — và câu trên chỉ chép lại câu lệnh mà ai cũng đọc
 * được trong mã nguồn.
 *
 * Nguyên nhân: drizzle BỌC lỗi của driver. Lời khai thật của Postgres nằm ở `error.cause`. 29 chỗ
 * trong kho viết `error.message`, nên 29 chỗ ấy vứt đúng phần có ích.
 *
 * Bài này gây lỗi Postgres THẬT trên PGlite rồi đọc lại — không mô phỏng bằng một đối tượng bịa.
 */

const goc = path.resolve(__dirname, "..");

export async function testMoTaLoiCsdl() {
  const db = await getDb();

  /* ───────── 1 · TRÙNG KHOÁ — lỗi hay gặp nhất ở đường đồng bộ ───────── */
  const [ag] = await db.insert(schema.techAgents).values({ key: "loi-a", name: "loi-a", role: "QA" }).returning({ id: schema.techAgents.id });
  await db.insert(schema.techAgentRuns).values({ agentId: ag.id, agentKey: "loi-a", externalRef: "github:999001:1", status: "SUCCEEDED", endedAt: new Date() });
  let trung: unknown = null;
  try {
    await db.insert(schema.techAgentRuns).values({ agentId: ag.id, agentKey: "loi-a", externalRef: "github:999001:1", status: "FAILED", endedAt: new Date() });
  } catch (e) {
    trung = e;
  }
  assert.ok(trung, "phải có lỗi trùng khoá");

  /*
    VẾ ĐẦU: ĐÚNG THỨ CÂU CŨ KHÔNG NÓI ĐƯỢC.
    Thiếu một trong ba (câu chữ · mã SQLSTATE · tên ràng buộc) là người đọc vẫn phải đi đoán.
  */
  const mo = moTaLoiCsdl(trung);
  assert.match(mo, /duplicate key|unique/i, "phải nói ra NGUYÊN NHÂN, không chỉ chép câu lệnh");
  assert.match(mo, /23505/, "phải kèm mã SQLSTATE — đó là lời khai không phụ thuộc câu chữ hay ngôn ngữ");
  assert.match(mo, /tech_agent_runs_external_ref_uq/, "phải nêu ĐÚNG ràng buộc nào bị vi phạm");

  /*
    VẾ THỨ HAI, QUAN TRỌNG NGANG: BỎ ĐƯỢC CÂU SQL DÀI.
    `sync_runs.error` bị cắt ở 2000 ký tự. Bốn mươi tên cột chiếm hết chỗ của phần có ích, nên
    "không mất chỗ" cũng là một tính chất chứ không phải chuyện thẩm mỹ.
  */
  assert.ok(!mo.includes("Failed query"), "KHÔNG được giữ lớp bọc của drizzle");
  assert.ok(!/"agent_key",\s*"task_id"/.test(mo), "KHÔNG được chép lại danh sách cột");
  assert.ok(mo.length < 400, `phải ngắn gọn, nhận ${mo.length} ký tự`);
  assert.match(mo, /^tech_agent_runs: /, "và phải nêu ĐÚNG bảng nào — thứ duy nhất trong câu lệnh mà người đọc cần");

  /* ───────── 2 · KHOÁ NGOẠI — nguyên nhân KHÁC, phải đọc ra KHÁC ───────── */
  let ngoai: unknown = null;
  try {
    await db.insert(schema.techAgentRuns).values({ agentId: "khong-ton-tai-bao-gio", agentKey: "loi-a", status: "SUCCEEDED", endedAt: new Date() });
  } catch (e) {
    ngoai = e;
  }
  if (ngoai) {
    const m2 = moTaLoiCsdl(ngoai);
    assert.match(m2, /foreign key|violates/i, "lỗi khoá ngoại phải đọc ra là khoá ngoại");
    assert.notEqual(m2, mo, "hai nguyên nhân khác nhau KHÔNG được ra cùng một câu — gộp lại là đẩy người đọc đi sửa nhầm chỗ");
  }

  /* ───────── 3 · KHÔNG PHẢI LỖI CSDL THÌ GIỮ NGUYÊN ───────── */
  assert.equal(moTaLoiCsdl(new Error("mất kết nối mạng")), "mất kết nối mạng", "lỗi thường phải giữ nguyên — thay error.message bằng hàm này không được làm mất thông tin");
  assert.equal(moTaLoiCsdl("một chuỗi"), "một chuỗi");
  /*
    Postgres không nói gì thì hàm KHÔNG được bịa. CHƯA BIẾT vẫn là chưa biết (mục 42).
  */
  assert.match(moTaLoiCsdl(new Error("Failed query: insert into \"x\" (a, b)")), /Failed query/, "không có lời khai của Postgres thì trả nguyên trạng, không đoán");

  await db.delete(schema.techAgentRuns).where(eq(schema.techAgentRuns.agentId, ag.id));
  await db.delete(schema.techAgents).where(eq(schema.techAgents.id, ag.id));
}

/* ═════════════ QUÉT MÃ NGUỒN ═════════════ */

export function testMoTaLoiSourceGuards() {
  const bo = (m: string) => m.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  /*
    MỌI VÒNG LẶP ĐỒNG BỘ PHẢI DÙNG HÀM NÀY.

    Những tệp dưới đây ghi lỗi vào chỗ NGƯỜI VẬN HÀNH đọc (`sync_runs.error`, nhật ký job). Viết
    `error.message` ở đó là chép lại lớp bọc của drizzle và vứt lời khai của Postgres — đúng thứ
    đã xảy ra trên production ngày 20/09.
  */
  const batBuoc = [
    "lib/integrations/pancake/sync.ts",
    "lib/integrations/facebook/sync.ts",
    "lib/integrations/facebook/mapping.ts",
    "lib/integrations/viettelpost/sync.ts",
    "lib/sync/runner.ts",
  ];
  for (const f of batBuoc) {
    const src = bo(readFileSync(path.join(goc, f), "utf8"));
    assert.ok(src.includes("moTaLoiCsdl("), `${f} phải mô tả lỗi bằng moTaLoiCsdl`);
    assert.ok(
      !src.includes("error instanceof Error ? error.message : String(error)"),
      `${f} còn chỗ ghi lỗi bằng error.message — với lỗi CSDL đó luôn là lớp bọc "Failed query: …" vô dụng`,
    );
  }

  /*
    HÀM PHẢI ĐI HẾT CHUỖI `cause`. Đọc mỗi tầng trên cùng thì nó chính là thứ nó sinh ra để thay.
  */
  const h = bo(readFileSync(path.join(goc, "lib/db/error-message.ts"), "utf8"));
  assert.ok(h.includes(".cause"), "phải đi theo chuỗi cause — lời khai của Postgres nằm ở đó");
  assert.ok(/for \(let i = 0; i < \d+/.test(h), "vòng đi theo cause phải có TRẦN, phòng một chuỗi tự trỏ vào chính nó");

  console.log("✓ Lỗi CSDL đọc được: nguyên nhân + mã SQLSTATE + tên ràng buộc thay cho 40 tên cột · trùng khoá và khoá ngoại ra hai câu khác nhau · lỗi thường giữ nguyên · 5 vòng lặp đồng bộ đều đã dùng");
}
