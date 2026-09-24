/*
  ops `cod-statement-audit` — VÌ SAO TAB "QUÁ HẠN" CỦA /cod ĐÔNG, ĐO BẰNG SỐ TỔNG HỢP.

  Câu hỏi của chủ shop (24/09/2026): "đối soát COD tại sao quá hạn chưa trả nhiều thế?". Trả lời
  được câu đó cần đặt năm thứ cạnh nhau — và cả năm đều là SỐ ĐẾM / TỔNG TIỀN / NGÀY:

    1. trang /cod đang nói gì (đếm theo tab, số quá hạn) — đọc qua ĐÚNG hàm của trang;
    2. đơn quá hạn dồn vào ngày giao nào — quá hạn trọn một ngày là dấu vân tay của THIẾU TỆP,
       rải rác nhiều ngày mới là Viettel Post chậm trả;
    3. sao kê ngân hàng: Viettel Post đã chuyển những đợt nào (số bảng kê nằm cuối nội dung chuyển
       khoản), và ERP có tệp của đợt đó chưa;
    4. các lần nhập tệp gần đây (tải tay lẫn script Gmail): loại tệp, số dòng, ghép được bao nhiêu,
       lỗi gì;
    5. sổ chứng từ theo từng bảng kê, và nhịp tim của script Gmail.

  Trước đây muốn biết những điều này phải `db-query`, mà kết quả `db-query` nay chỉ đi dạng bản mã
  (docs/security-2026-09-24-ops-log-leak.md) — agent không mở được, chủ shop phải tự giải mã mỗi
  lần. Script này in đúng phần TỔNG HỢP qua kênh `[ops:tom-tat] `, nên đọc được ngay trên log.

  KHÔNG IN tên, SĐT, địa chỉ khách, tên người tải tệp, nội dung chuyển khoản hay tên tệp gốc (tên
  tệp do người dùng đặt). Tệp chỉ được gọi bằng LOẠI + SỐ BẢNG KÊ trích ra từ tên; giao dịch ngân
  hàng chỉ bằng ngày + số tiền + số bảng kê. Nhánh ops vẫn bọc `ma_hoa_ket_qua` để phần in thêm
  (nếu có) nằm trong bản mã.

  CHỈ ĐỌC do Postgres ép: `ERP_READ_ONLY=1` được đặt TRƯỚC lần mở kết nối đầu tiên (`getDb` đọc
  biến lúc tạo kết nối), nên mọi phiên đều `default_transaction_read_only=on` — và `main` HỎI LẠI
  Postgres rồi dừng nếu không phải. Chỉ đặt khi chạy thẳng từ dòng lệnh: bài kiểm `import` tệp này
  mà đặt biến ở mức module thì cả bộ kiểm thử phía sau thành chỉ-đọc.

  arg: `--days=N` (mặc định 21, trần 120) — cửa sổ cho sao kê ngân hàng và các lần nhập tệp.
*/
const CHAY_THANG = Boolean(process.argv[1] && process.argv[1].endsWith("cod-statement-audit.ts"));
if (CHAY_THANG) process.env.ERP_READ_ONLY = "1";

import "dotenv/config";
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { codSettlementCounts, codSettlementSummary, listCodSettlement, missingStatementPeriods } from "@/lib/queries/cod-settlement";
import { rowsOf } from "@/lib/sql-rows";

const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s}`);

const ALL = { key: "all" as const, from: null, to: null, label: "Toàn bộ", fromKey: null, toKey: null };

/** Trần số dòng mỗi mục — cả lượt phải lọt 60 dòng mà kênh tóm tắt cho ra log. */
const TRAN = { ngay: 12, nganHang: 10, tep: 10, so: 8 } as const;

export type LoaiTep = "BANG_KE_EMAIL" | "BAO_CAO_CHI_TIET" | "DANH_SACH_VAN_DON" | "KHAC";

/**
 * Loại tệp suy từ tên — để nói "đã nhận MỘT bảng kê" hay "đã nhận một báo cáo cước" mà không in
 * tên gốc. `BangKeChiCOD_<số>_<mốc>.xlsx` là bảng kê Viettel Post gửi qua email; "Báo cáo chi tiết
 * bảng kê" là bản tải tay từ web, phần lớn dòng chỉ có cước.
 */
export function loaiTep(filename: string): LoaiTep {
  const t = filename.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (/bangkechicod/.test(t)) return "BANG_KE_EMAIL";
  if (/bao[\s_-]*cao[\s_-]*chi[\s_-]*tiet[\s_-]*bang[\s_-]*ke|chi[\s_-]*tiet[\s_-]*bang[\s_-]*ke/.test(t)) return "BAO_CAO_CHI_TIET";
  if (/danh[\s_-]*sach|van[\s_-]*don|order/.test(t)) return "DANH_SACH_VAN_DON";
  return "KHAC";
}

/**
 * SỐ BẢNG KÊ Viettel Post — định danh của một đợt chi trả, KHÔNG phải dữ liệu cá nhân.
 *  · tên tệp email:   `BangKeChiCOD_30873899_1789…xlsx`        → 30873899
 *  · sao kê ngân hàng: `… VTP GLMTQY18 180926 30873899 …`       → 30873899
 * Không tìm được thì `null` — không đoán từ một dãy số bất kỳ.
 */
export function soBangKe(text: string): string | null {
  const tep = /BangKeChiCOD_(\d{6,10})(?:_|\.|$)/i.exec(text);
  if (tep) return tep[1]!;
  const ck = /\bVTP\s+[A-Z0-9]+\s+\d{6}\s+(\d{6,10})\b/i.exec(text);
  return ck ? ck[1]! : null;
}

/** Tiền VND in bằng dấu chấm ngăn nghìn — không dùng Intl để kết quả giống nhau trên mọi máy. */
export function tien(n: number): string {
  const s = Math.round(n).toString();
  const am = s.startsWith("-");
  const so = am ? s.slice(1) : s;
  return `${am ? "-" : ""}${so.replace(/\B(?=(\d{3})+(?!\d))/g, ".")} ₫`;
}

/** Câu lỗi của lần nhập: che mọi thứ trong nháy và mọi dãy ≥ 4 chữ số, như workflow che lỗi psql. */
export function cheLoi(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .replace(/'[^']*'/g, "'…'")
    .replace(/"[^"]*"/g, '"…"')
    .replace(/[0-9]{4,}/g, "####")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, "•@•")
    .slice(0, 120);
}

function soNgay(argv: string[]): number {
  const m = argv.map((a) => /^--days=(\d{1,3})$/.exec(a)).find(Boolean);
  const n = m ? Number(m[1]) : 21;
  return Math.min(120, Math.max(1, n));
}

const n = (v: unknown) => Number(v ?? 0);

/** Mọi dòng tóm tắt của một lượt đo — tách khỏi `main` để bài kiểm chạy được trên CSDL mẫu. */
export async function codStatementAuditLines(days: number): Promise<string[]> {
  const db = await getDb();
  const out: string[] = [];

  // ── 1. Trang /cod đang nói gì — ĐÚNG các hàm của trang, kỳ "Toàn bộ" như mặc định của trang.
  const [dem, tong, thieu] = await Promise.all([codSettlementCounts(ALL), codSettlementSummary(ALL), missingStatementPeriods()]);
  out.push(
    `TRANG /cod: quá hạn ${dem.QUA_HAN} đơn · ${tien(tong.quaHan.amount)} | chờ trả ${dem.CHUA_TRA} · trả thiếu ${dem.TRA_THIEU} · đã trả đủ ${dem.DA_TRA_DU} · giao nhưng thu không đủ ${dem.GIAO_NHUNG_HOAN} · chưa giao xong ${dem.CHUA_GIAO}`,
  );
  out.push(
    `  phải trả ${tien(tong.phaiThu.amount)} (${tong.phaiThu.count} đơn) · đã trả theo bảng kê ${tien(tong.daTra.amount)} (${tong.daTra.count} đơn) · ngưỡng quá hạn ${tong.overdueDays} ngày`,
  );
  if (thieu.length) {
    for (const k of thieu.slice(0, 3)) out.push(`THIẾU BẢNG KÊ ngày phát ${k.from} → ${k.to}: ${k.shipments} đơn · ${tien(k.amount)}`);
  } else {
    out.push("THIẾU BẢNG KÊ: trang không báo khoảng nào");
  }

  // ── 2. Quá hạn dồn vào NGÀY GIAO nào. Đọc qua chính danh sách của tab "Quá hạn".
  type Ngay = { n: number; tien: number; coCuoc: number };
  const theoNgay = new Map<string, Ngay>();
  for (let page = 1; page <= 50; page++) {
    const { rows, pageCount } = await listCodSettlement({ period: ALL, status: "QUA_HAN", page, pageSize: 200 });
    for (const r of rows) {
      const k = r.deliveredAt ?? "không rõ ngày";
      const g = theoNgay.get(k) ?? { n: 0, tien: 0, coCuoc: 0 };
      g.n += 1;
      g.tien += r.codDeclared;
      // Có cước mà không có tiền: vận đơn ĐÃ nằm trên một bảng kê, nhưng chỉ ở phần cước.
      if (r.fee > 0) g.coCuoc += 1;
      theoNgay.set(k, g);
    }
    if (page >= pageCount) break;
  }
  const ngay = [...theoNgay.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  out.push(`QUÁ HẠN THEO NGÀY GIAO (${ngay.length} ngày, mới nhất trước) — "có cước" = đã lên bảng kê nhưng chỉ ở phần cước:`);
  for (const [k, g] of ngay.slice(0, TRAN.ngay)) out.push(`  ${k}: ${g.n} đơn · ${tien(g.tien)} · có cước ${g.coCuoc}`);
  if (ngay.length > TRAN.ngay) {
    const con = ngay.slice(TRAN.ngay);
    out.push(`  … ${con.length} ngày cũ hơn: ${con.reduce((a, [, g]) => a + g.n, 0)} đơn · ${tien(con.reduce((a, [, g]) => a + g.tien, 0))}`);
  }

  // ── 3. Viettel Post đã chuyển những đợt nào, và ERP có tệp của đợt đó chưa.
  const ck = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select to_char(txn_at at time zone 'Asia/Ho_Chi_Minh', 'DD/MM') ngay, amount, description, linked_type
      from bank_transactions
      where accounting_group = 'COD_SETTLEMENT' and amount > 0 and txn_at >= now() - (${days} || ' days')::interval
      order by txn_at desc`),
  );
  const tepDaNhan = rowsOf<Record<string, unknown>>(await db.execute(sql`select filename from vtp_statement_files`)).map((r) => String(r.filename ?? ""));
  const nguonSo = rowsOf<Record<string, unknown>>(await db.execute(sql`select distinct source_file from cod_statement_lines`)).map((r) => String(r.source_file ?? ""));
  const coTrong = (ds: string[], so: string) => ds.some((f) => soBangKe(f) === so);
  // Tệp "Báo cáo chi tiết bảng kê" tải tay KHÔNG in số bảng kê trong tên, nên khớp thêm bằng SỐ
  // TIỀN: tổng "thu về" của một bảng kê trong sổ bằng đúng khoản Viettel Post chuyển cho nó.
  const thuVe = new Set(
    rowsOf<Record<string, unknown>>(await db.execute(sql`select coalesce(sum(net), 0) net from cod_statement_lines group by statement_key`)).map((r) => n(r.net)),
  );
  out.push(`SAO KÊ: Viettel Post chuyển ${ck.length} đợt trong ${days} ngày · ${tien(ck.reduce((a, r) => a + n(r.amount), 0))}`);
  let thieuTep = 0;
  for (const [i, r] of ck.entries()) {
    const so = soBangKe(String(r.description ?? ""));
    const daNhan = so ? coTrong(tepDaNhan, so) : false;
    const theoSo = so ? coTrong(nguonSo, so) : false;
    const theoTien = thuVe.has(n(r.amount));
    const daVaoSo = theoSo || theoTien;
    if (!daVaoSo) thieuTep += 1;
    if (i < TRAN.nganHang) {
      out.push(
        `  ${r.ngay} ${tien(n(r.amount))} · bảng kê ${so ?? "không đọc được số"} · tệp: ${daNhan ? "đã nhận" : theoTien ? "tải tay (không mang số)" : "CHƯA NHẬN"} · sổ chứng từ: ${theoSo ? "có" : theoTien ? "có (khớp số tiền thu về)" : "KHÔNG"}${r.linked_type ? "" : " · chưa đối chiếu"}`,
      );
    }
  }
  out.push(`  ⇒ ${thieuTep}/${ck.length} đợt tiền ĐÃ VỀ mà sổ chứng từ không có bảng kê tương ứng`);

  // ── 4. Các lần nhập tệp gần đây — cả tải tay lẫn script Gmail đều ghi `vtp_import_batches`.
  const nhap = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select to_char(created_at at time zone 'Asia/Ho_Chi_Minh', 'DD/MM HH24:MI') luc, filename, kind, mode, rows, applied, error,
             summary->>'withCash' co_tien, summary->>'periodFrom' tu, summary->>'periodTo' den
      from vtp_import_batches
      where kind <> 'ORDER_LIST' and created_at >= now() - (${days} || ' days')::interval
      order by created_at desc limit ${TRAN.tep}`),
  );
  out.push(`TỆP BẢNG KÊ ĐÃ NHẬP (${days} ngày, mới nhất trước, tối đa ${TRAN.tep}): ${nhap.length ? "" : "không có lần nào"}`);
  for (const r of nhap) {
    const ten = String(r.filename ?? "");
    const loi = cheLoi(r.error as string | null);
    out.push(
      `  ${r.luc} ${loaiTep(ten)}${soBangKe(ten) ? ` ${soBangKe(ten)}` : ""} · ${r.kind}/${r.mode} · ${n(r.rows)} dòng · ghi ${n(r.applied)} · có tiền ${r.co_tien ?? "—"} · phát ${r.tu ?? "?"}→${r.den ?? "?"}${loi ? ` · lỗi: ${loi}` : ""}`,
    );
  }

  // ── 5. Sổ chứng từ theo bảng kê, và nhịp tim script Gmail.
  const so = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select statement_key, min(paid_date) tu, max(paid_date) den, count(*) dong,
             count(*) filter (where cod > 0) co_cod, count(*) filter (where shipment_id is null) chua_ghep,
             coalesce(sum(cod), 0) cod, to_char(max(created_at) at time zone 'Asia/Ho_Chi_Minh', 'DD/MM') nhap, max(source_file) tep
      from cod_statement_lines group by statement_key order by max(created_at) desc limit ${TRAN.so}`),
  );
  out.push(`SỔ CHỨNG TỪ (${TRAN.so} bảng kê nhập gần nhất):`);
  for (const r of so) {
    const ten = String(r.tep ?? "");
    out.push(
      `  ${r.statement_key} · ${loaiTep(ten)}${soBangKe(ten) ? ` ${soBangKe(ten)}` : ""} · phát ${r.tu ?? "?"}→${r.den ?? "?"} · ${n(r.dong)} dòng, ${n(r.co_cod)} có tiền, ${n(r.chua_ghep)} chưa ghép · ${tien(n(r.cod))} · nhập ${r.nhap}`,
    );
  }
  const tim = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select to_char(updated_at at time zone 'Asia/Ho_Chi_Minh', 'DD/MM HH24:MI') luc,
             round(extract(epoch from (now() - updated_at)) / 3600) gio, value->>'outcome' ket_qua
      from sync_state where key = 'viettelpost:statement-mail-heartbeat'`),
  )[0];
  out.push(tim ? `SCRIPT GMAIL: báo về lần cuối ${tim.luc} (${n(tim.gio)} giờ trước) · ${tim.ket_qua ?? "?"}` : "SCRIPT GMAIL: chưa từng báo về");

  return out;
}

async function main() {
  const db = await getDb();
  const [ro] = rowsOf<Record<string, unknown>>(await db.execute(sql`show default_transaction_read_only`));
  if (String(ro?.default_transaction_read_only ?? "") !== "on") {
    console.error("cod-statement-audit: phiên CSDL không ở chế độ chỉ đọc — KHÔNG chạy.");
    process.exit(1);
  }
  const days = soNgay(process.argv.slice(2));
  const lines = await codStatementAuditLines(days);
  for (const d of lines) tomTat(d);
  process.exit(0);
}

// Chỉ chạy khi được gọi THẲNG từ dòng lệnh — `import` từ bài kiểm không được kéo theo `process.exit`.
if (CHAY_THANG) {
  main().catch((e) => {
    console.error("cod-statement-audit lỗi:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
