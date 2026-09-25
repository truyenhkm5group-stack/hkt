import assert from "node:assert/strict";
import { DEPARTMENT_CODES, DEPARTMENT_ORDER } from "@/lib/constants/departments";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * ═══════ ĐƯỜNG NÂNG CẤP TỪ TRẠNG THÁI PRODUCTION, KHÔNG CHỈ ĐƯỜNG DỰNG MỚI ═══════
 *
 * `npm test` chạy trên PGlite TRỐNG, nên nó chỉ chứng minh được đường 0000 → cuối. Máy chủ thật
 * KHÔNG bao giờ đi đường đó: nó đã có N migration chạy rồi và chỉ áp thêm cái cuối. Hai đường đó
 * hỏng theo hai kiểu khác nhau, và kiểu thứ hai là kiểu đã làm đỏ `main` bốn lần trong một buổi
 * chiều (AGENTS.md mục 9).
 *
 * SỰ CỐ THẬT 12/09/2026 mà bài này sinh ra để chặn: hai phiên song song cùng đánh số `0067`
 * (`0067_cs_workqueue` và `0067_bank_transaction_links`). Bản CSKH lên production trước. Nếu bản
 * tài chính được gộp nguyên trạng thì drizzle — vốn chạy theo `_journal.json` — sẽ thấy mục `0067`
 * đã áp và **BỎ QUA VĨNH VIỄN** migration còn lại. Không lỗi, không cảnh báo: bảng đơn giản là
 * không bao giờ tồn tại, và trang tài chính đổ ở lần truy vấn đầu tiên trên production.
 *
 * KHÔNG ĐỘNG VÀO KHO MÃ. Bài chép `drizzle/` sang thư mục tạm rồi cắt sổ Ở ĐÓ. Bản trước của bài
 * này ghi đè `drizzle/meta/_journal.json` thật rồi khôi phục trong `finally` — chỉ cần tiến trình
 * chết giữa chừng là sổ migration của kho mã hỏng, đúng thứ đang cố bảo vệ.
 */

type Entry = { idx: number; tag: string; when: number; version: string; breakpoints: boolean };

/**
 * Migration mới của bản phát hành này — phần mà production CHƯA có.
 *
 * Là một DANH SÁCH chứ không phải một chuỗi: một bản phát hành có thể mang nhiều migration, và
 * lúc đó đường nâng cấp thật là "áp cả nhóm lên trạng thái cũ", không phải "áp từng cái lên một
 * trạng thái đã có những cái kia". Ép về một chuỗi sẽ làm bài kiểm gieo dữ liệu thử SAU khi
 * migration cần kiểm đã áp — và phần backfill của nó không bao giờ được kiểm.
 */
const MOI = [
  "0087_return_reason_observations",
  "0088_payroll_periods",
  "0089_marketer_profit_carryover",
  "0090_fanpage_alias_access",
  "0091_landing_attribution",
  "0092_fb_adsets",
  "0093_landing_gap_reasons",
  "0094_order_promised_delivery",
  "0095_return_unidentified",
  "0096_payroll_policy_engine",
  "0097_payroll_run_lifecycle",
  "0098_payroll_input_approval",
  "0099_vtp_source_of_truth",
  "0100_vtp_webhook_gap",
  "0101_tech_control_plane",
  "0102_tech_github_runner",
  "0103_care_decisions",
  "0104_tech_cto_proposals",
  "0105_cto_repair_evidence",
  "0106_session_revocation",
  "0107_agent_run_external_ref",
  "0108_ads_decision_ledger",
  "0109_ads_budget_changes",
  "0110_ad_spends_ad_grain",
  "0111_ads_decision_basis",
  "0112_agent_run_blocked",
  "0113_production_department",
  "0114_department_sort_order",
  "0115_production_received_at",
  "0116_agent_run_review_verdict",
  "0117_creative_loop",
  "0118_creative_manual_variants",
  "0119_creative_own_ads",
  "0120_creative_design_concepts",
  "0121_creative_scale_drafts",
  "0122_suppliers",
  "0123_creative_design_moq",
  "0124_creative_manual_gen_campaign_per_post",
  "0125_cs_semantic_verdicts",
  "0126_payroll_autopilot",
  "0127_stock_wait_log",
  "0128_workshop_ledger",
  "0129_workshop_variants_mkt",
  "0130_marketer_prices",
  "0131_bank_link_supplier_payment",
  "0132_company_os_models",
  "0133_company_os_inventory",
] as const;

/*
  VÌ SAO 0087 CÒN Ở TRONG DANH SÁCH DÙ NÓ ĐÃ CHẠY THẬT (bản phát hành #286).

  Giữ lại là một phép kiểm CHẶT HƠN, không phải một lời khai sai: bước 1 dựng một production CŨ HƠN
  thực tế (chưa có 0087), rồi bước 2 áp CẢ HAI migration lên trạng thái ấy. Nếu đường nâng cấp chạy
  được từ mốc cũ hơn thì nó cũng chạy được từ mốc hôm nay. Bỏ 0087 ra thì phải viết lại toàn bộ khối
  khẳng định của nó theo chiều ngược (từ "chưa được có" sang "phải có sẵn") — công việc ấy thuộc về
  phiên đang giữ 0087, không phải phiên thêm 0088.
*/

export async function testMigrationUpgradePath() {
  const goc = path.join(process.cwd(), "drizzle");
  const so = JSON.parse(readFileSync(path.join(goc, "meta/_journal.json"), "utf8")) as { entries: Entry[] };
  const moi = so.entries.filter((e) => (MOI as readonly string[]).includes(e.tag));
  assert.equal(moi.length, MOI.length, `sổ phải có đúng ${MOI.length} mục mới — đổi tên migration thì đổi luôn danh sách MOI ở đây`);
  // Mốc phải MUỘN HƠN mọi mốc cũ, nếu không drizzle bỏ qua nó trên máy đã chạy các migration kia.
  const mocCu = Math.max(...so.entries.filter((e) => !(MOI as readonly string[]).includes(e.tag)).map((e) => e.when));
  for (const m of moi) assert.ok(m.when > mocCu, `mốc của ${m.tag} (${m.when}) phải muộn hơn mọi mốc đã có (${mocCu})`);

  const tmp = mkdtempSync(path.join(tmpdir(), "upgrade-"));
  const thuMucSo = path.join(tmp, "drizzle");
  const duLieu = path.join(tmp, "db");
  const soFile = path.join(thuMucSo, "meta/_journal.json");
  cpSync(goc, thuMucSo, { recursive: true });

  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const client = new PGlite(duLieu);
  const db = drizzle(client) as never;
  const dem = async (sql: string) => Number((await client.query<{ n: number }>(sql)).rows[0]?.n ?? 0);

  try {
    // ══ BƯỚC 1: dựng đúng trạng thái production hôm nay — sổ CẮT trước migration mới ══
    const cu = { ...so, entries: so.entries.filter((e) => !(MOI as readonly string[]).includes(e.tag)) };
    writeFileSync(soFile, JSON.stringify(cu, null, 2) + "\n");
    await migrate(db, { migrationsFolder: thuMucSo });

    const truoc = await dem("select count(*)::int as n from drizzle.__drizzle_migrations");
    assert.equal(truoc, cu.entries.length, "bước 1: số migration đã áp phải khớp sổ đã cắt");
    // 0075 đã áp: cột `active` có, và mặc định `true` cho cả dòng đã đóng — đúng trạng thái production
    // 13/09/2026 (7 RESOLVED + 6 CANCELLED vẫn active). Bài này dựng lại đúng tình huống đó.
    assert.equal(await dem("select count(*)::int as n from information_schema.columns where table_name = 'shipment_care' and column_name = 'active'"), 1, "bước 1: 0075 phải đã áp — cột active có sẵn");
    // 0081 và 0082 đã chạy thật trên máy chủ nên nay chúng thuộc "trạng thái production hôm nay",
    // không còn là migration mới.
    assert.equal(await dem("select count(*)::int as n from information_schema.columns where table_name = 'cs_cases' and column_name = 'semantic'"), 1, "bước 1: 0081 phải đã áp — cột semantic có sẵn");
    /*
      0082 VÀ 0083 đã chạy thật trên máy chủ (bản phát hành #267 và #276) nên nay cả hai thuộc
      "trạng thái production hôm nay", không còn là migration mới.
    */
    assert.equal(await dem("select count(*)::int as n from information_schema.tables where table_name = 'hmt_workbooks'"), 1, "bước 1: 0082 phải đã áp — bảng hmt_workbooks có sẵn");
    assert.equal(await dem("select count(*)::int as n from information_schema.columns where table_name = 'hmt_return_reconciliation' and column_name = 'resolution'"), 1, "bước 1: 0083 phải đã áp — cột resolution có sẵn");
    /*
      0084, 0085 VÀ 0086 đã chạy thật trên máy chủ (bản phát hành #278 và #279) nên nay cả ba thuộc
      "trạng thái production hôm nay". Kiểm sự CÓ MẶT của chúng ở bước 1 để bài không lặng lẽ thành
      vô nghĩa: nếu một ngày `MOI` bị cắt quá tay thì chính dòng này đỏ.
    */
    assert.ok(
      (await client.query<{ def: string }>("select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'metric_targets_scope_check'")).rows[0]?.def.includes("PRODUCT"),
      "bước 1: 0084 phải đã áp — ràng buộc phạm vi đã nhận tầng PRODUCT",
    );
    // Một đích ĐÃ ĐẶT TỪ TRƯỚC, để bước 2 kiểm được rằng migration mới không đụng tới dòng nào.
    await client.query(`insert into metric_targets (id, metric_key, scope, scope_ref, target, note, effective_from, set_by_email) values ('up-mt1', 'delivery_success_rate', 'COMPANY', null, 65, 'mức chung toàn shop', now(), 'a@shop.vn')`);
    assert.equal(await dem("select count(*)::int as n from information_schema.columns where table_name = 'shipment_return_reasons' and column_name = 'raw_reason'"), 1, "bước 1: 0085 phải đã áp — cột raw_reason có sẵn");
    assert.equal(await dem("select count(*)::int as n from information_schema.tables where table_name = 'fanpages'"), 1, "bước 1: 0086 phải đã áp — bảng fanpages có sẵn");
    /*
      Thứ CHƯA được có ở bước 1 là bảng quan sát của 0087. Nếu nó đã có sẵn thì "áp thêm migration"
      chẳng chứng minh được gì.
    */
    assert.equal(await dem("select count(*)::int as n from information_schema.tables where table_name = 'return_reason_observations'"), 0, "bước 1: bảng return_reason_observations CHƯA được có — đó là thứ 0087 thêm vào");
    assert.equal(await dem("select count(*)::int as n from information_schema.tables where table_name = 'payroll_periods'"), 0, "bước 1: bảng payroll_periods CHƯA được có — đó là thứ 0088 thêm vào");
    assert.equal(await dem("select count(*)::int as n from information_schema.tables where table_name = 'marketer_profit_carryover'"), 0, "bước 1: bảng marketer_profit_carryover CHƯA được có — đó là thứ 0089 thêm vào");
    assert.equal(await dem("select count(*)::int as n from information_schema.columns where table_name = 'fanpages' and column_name = 'alias'"), 0, "bước 1: cột fanpages.alias CHƯA được có — đó là thứ 0090 thêm vào");
    assert.equal(await dem("select count(*)::int as n from information_schema.tables where table_name = 'landing_attributions'"), 0, "bước 1: bảng landing_attributions CHƯA được có — đó là thứ 0091 thêm vào");
    assert.equal(await dem("select count(*)::int as n from information_schema.tables where table_name = 'fb_adsets'"), 0, "bước 1: bảng fb_adsets CHƯA được có — đó là thứ 0092 thêm vào");
    assert.equal(await dem("select count(*)::int as n from information_schema.tables where table_name = 'return_unidentified'"), 0, "bước 1: bảng return_unidentified CHƯA được có — đó là thứ 0095 thêm vào");
    assert.equal(await dem("select count(*)::int as n from information_schema.tables where table_name = 'salary_policies'"), 0, "bước 1: bảng salary_policies CHƯA được có — đó là thứ 0096 thêm vào");
    assert.equal(await dem("select count(*)::int as n from information_schema.columns where table_name = 'marketer_profit_carryover' and column_name = 'component_code'"), 0, "bước 1: cột component_code CHƯA được có — đó là thứ 0096 thêm vào");
    assert.equal(await dem("select count(*)::int as n from information_schema.columns where table_name = 'payroll_periods' and column_name = 'approved_by'"), 0, "bước 1: cột approved_by CHƯA được có — đó là thứ 0097 thêm vào");
    assert.equal(
      await dem("select count(*)::int as n from information_schema.columns where table_name = 'payroll_inputs' and column_name = 'status'"),
      0,
      "bước 1: cột trạng thái của đầu vào nhập tay CHƯA được có — đó là thứ 0098 thêm vào",
    );
    assert.equal(await dem("select count(*)::int as n from information_schema.tables where table_name = 'vtp_status_registry'"), 0, "bước 1: bảng vtp_status_registry CHƯA được có — đó là thứ 0099 thêm vào");
    assert.equal(await dem("select count(*)::int as n from information_schema.columns where table_name = 'shipments' and column_name = 'vtp_raw_status_name'"), 0, "bước 1: cột lời khai thô CHƯA được có — đó là thứ 0099 thêm vào");
    assert.equal(await dem("select count(*)::int as n from information_schema.tables where table_name = 'vtp_webhook_gaps'"), 0, "bước 1: sổ khoảng hụt webhook CHƯA được có — đó là thứ 0100 thêm vào");
    assert.equal(await dem("select count(*)::int as n from information_schema.tables where table_name = 'tech_tasks'"), 0, "bước 1: hàng đợi việc Tech CHƯA được có — đó là thứ 0101 thêm vào");
    assert.equal(await dem("select count(*)::int as n from information_schema.tables where table_name = 'tech_agents'"), 0, "bước 1: sổ agent CHƯA được có — đó là thứ 0101 thêm vào");
    assert.equal(await dem("select count(*)::int as n from information_schema.columns where table_name = 'tech_deployments' and column_name = 'external_run_id'"), 0, "bước 1: khoá lượt chạy GitHub CHƯA được có — đó là thứ 0102 thêm vào");
    assert.equal(await dem("select count(*)::int as n from information_schema.tables where table_name = 'tech_proposals'"), 0, "bước 1: sổ đề xuất AI CTO CHƯA được có — đó là thứ 0104 thêm vào");
    assert.equal(await dem("select count(*)::int as n from information_schema.columns where table_name = 'tech_proposals' and column_name = 'repair_outcome'"), 0, "bước 1: bằng chứng lượt sửa CHƯA được có — đó là thứ 0105 thêm vào");
    assert.equal(await dem("select count(*)::int as n from information_schema.columns where table_name = 'tech_tasks' and column_name = 'pr_number'"), 0, "bước 1: phép chiếu PR CHƯA được có — đó là thứ 0104 thêm vào");
    assert.equal(await dem("select count(*)::int as n from information_schema.columns where table_name = 'tech_agent_runs' and column_name = 'external_ref'"), 0, "bước 1: khoá lượt chạy đến từ máy ngoài CHƯA được có — đó là thứ 0107 thêm vào");
    assert.equal(await dem("select count(*)::int as n from information_schema.tables where table_name = 'ads_decision_ledger'"), 0, "bước 1: sổ quyết định quảng cáo CHƯA được có — đó là thứ 0108 thêm vào");
    assert.equal(await dem("select count(*)::int as n from information_schema.tables where table_name = 'ads_budget_changes'"), 0, "bước 1: sổ lượt ghi ngân sách CHƯA được có — đó là thứ 0109 thêm vào");
    assert.equal(await dem("select count(*)::int as n from information_schema.columns where table_name = 'ad_spends' and column_name = 'grain'"), 0, "bước 1: cột hạt chi tiêu CHƯA được có — đó là thứ 0110 thêm vào");
    assert.equal(await dem("select count(*)::int as n from information_schema.columns where table_name = 'ads_decision_ledger' and column_name = 'basis'"), 0, "bước 1: cột căn cứ CHƯA được có — đó là thứ 0111 thêm vào");
    /*
      DỮ LIỆU CHI TIÊU ĐANG CÓ TRÊN PRODUCTION, gieo TRƯỚC khi 0110 chạy.

      Một dòng đồng bộ (có `external_key`) và một dòng GÕ TAY (không có). Bước 2 kiểm rằng migration
      khai đúng hạt cho CẢ HAI mà không đụng một đồng nào — nếu nó lỡ đổi `spend`, mọi báo cáo lợi
      nhuận và lương đổi số cùng lúc.
    */
    await client.query(`insert into ad_spends (id, platform, campaign, spend, spend_date, external_key, account_id, campaign_id) values ('up-as1', 'Facebook', 'CD A', 1234567, now(), 'fb:acc:camp:2026-09-20', 'acc', 'camp')`);
    await client.query(`insert into ad_spends (id, platform, campaign, spend, spend_date) values ('up-as2', 'Facebook', 'Gõ tay', 500000, now())`);
    /*
      Một vận đơn ĐÃ CÓ TỪ TRƯỚC 0099, mang một trạng thái Viettel Post đã dịch được. Bước 2 kiểm
      rằng migration KHÔNG dựng hộ nó một "lời khai thô": suy ngược từ `vtp_status_name` là bịa ra
      một câu ĐVVC với một mốc không có thật (AGENTS.md mục 35).
    */
    await client.query(`insert into shipments (id, tracking_code, stage, vtp_status, vtp_status_name, vtp_status_date) values ('up-s99', 'UPS99', 'IN_TRANSIT', 300, 'Đóng tải - vận chuyển đi', now())`);
    await client.query(`insert into shipments (id, tracking_code, stage) values ('up-s9', 'UPS9', 'DELIVERY_FAILED')`);
    await client.query(`insert into shipments (id, tracking_code, stage) values ('up-s8', 'UPS8', 'DELIVERY_FAILED')`);
    await client.query(`insert into shipment_care (id, shipment_id, care_status, care_outcome, owner_at_resolution, opened_at, active, done_at) values ('up-care-1', 'up-s9', 'RESOLVED', null, null, now(), false, now())`);
    await client.query(`insert into shipment_care (id, shipment_id, care_status, care_outcome) values ('up-care-2', 'up-s8', 'NEW', 'PENDING')`);
    /*
      Một KẾT LUẬN lý do hoàn ghi TRƯỚC 0087 — để bước 2 kiểm được rằng bảng quan sát mới KHÔNG
      backfill nó. Dòng kết luận cũ là bằng chứng một người đã quyết; dựng hộ nó một "quan sát"
      là bịa ra một lần ai đó nói, với một mốc thời gian không có thật (AGENTS.md mục 35).
    */
    await client.query(`insert into shipment_return_reasons (id, shipment_id, reason, reason_group, note, raw_reason, actor_email) values ('up-rr1', 'up-s9', 'SIZE_TIGHT', 'SIZE', 'khách bảo chật', '', 'a@shop.vn')`);

    /*
      DỮ LIỆU ĐANG CÓ TRÊN PRODUCTION, không phải bảng trống.

      Work OS là lớp CHỈ CỘNG THÊM: nó không được đụng tới một dòng nghiệp vụ nào. Gieo sẵn một
      người dùng, một đơn và một case CSKH rồi kiểm lại sau khi áp migration — nếu một ngày nào đó
      có ai thêm `UPDATE`/`ALTER` vào 0069 thì bài này đỏ, chứ không phải production đỏ.
    */
    await client.query(`insert into users (id, email, name, password_hash, role) values ('up-u1', 'a@shop.vn', 'An', 'x', 'CS')`);
    await client.query(`insert into orders (id, stage, status, inserted_at, bill_full_name) values ('up-o1', 'CONFIRMED', 2, now(), 'Khách Cũ')`);
    await client.query(`insert into cs_cases (id, order_id, kind, status, title) values ('up-c1', 'up-o1', 'OTHER', 'OPEN', 'Case có từ trước')`);

    /*
      ═══ THỨ TỰ PHÒNG BAN CỦA PRODUCTION KHÔNG GIỐNG THỨ TỰ 0069 GIEO ═══

      ĐO THẬT 23/09/2026 (ops db-query, lượt chạy 35829607289): cả bảy phòng trên production mang
      `sort_order = 100` — **giá trị MẶC ĐỊNH CỦA CỘT**, không phải 10·20·30… mà 0069 gieo. Tức là
      bảy dòng ấy không do 0069 tạo ra: chúng có trước (0069 dùng `ON CONFLICT DO NOTHING`) hoặc
      được tạo qua màn hình cấu hình, nơi đường ghi không truyền `sort_order`.
 
      Hậu quả đã xảy ra thật: các lệnh UPDATE có hàng rào của 0113 không khớp dòng nào, nên phòng
      Sản xuất (`sort_order = 50` từ lệnh INSERT) nhảy lên ĐẦU mọi danh sách đọc thứ tự từ CSDL —
      một phòng chưa có ai đứng trên bảy phòng đang chạy việc.

      Nên bước 1 phải dựng ĐÚNG tình trạng ấy, không phải tình trạng lý tưởng của một CSDL mới. Bài
      kiểm dựng trên dữ liệu đẹp hơn thực tế thì nó đo một thế giới không tồn tại.
    */
    await client.query(`update departments set sort_order = 100`);

    // ══ BƯỚC 2: áp migration mới lên ĐÚNG trạng thái đó ══
    writeFileSync(soFile, JSON.stringify(so, null, 2) + "\n");
    await migrate(db, { migrationsFolder: thuMucSo });

    const sau = await dem("select count(*)::int as n from drizzle.__drizzle_migrations");
    assert.equal(sau - truoc, MOI.length, `bước 2: phải áp thêm ĐÚNG ${MOI.length} migration, thực tế ${sau - truoc}`);

    // 0131 (Company OS · Agent A): ba bảng mới, và migration KHÔNG gieo mẫu nào — sổ mẫu chỉ được lấp bằng
    // job `model-registry` do người bấm, trạng thái vòng đời không backfill (mục 8.8, 35).
    for (const bang of ["product_models", "product_model_state_history", "domain_events"]) {
      assert.equal(await dem(`select count(*)::int as n from information_schema.tables where table_name = '${bang}'`), 1, `bước 2: 0131 phải tạo bảng ${bang}`);
      assert.equal(await dem(`select count(*)::int as n from ${bang}`), 0, `bước 2: 0131 không được gieo dòng nào vào ${bang}`);
    }

    /*
      ═══ 0081 NAY NẰM TRONG TRẠNG THÁI PRODUCTION (bước 1) ═══

      Giữ lại phần kiểm quan trọng nhất của nó: case CŨ vẫn `NULL`. `NULL` nghĩa là CHƯA BIẾT (case
      sinh trước bản ấy), không phải "model đã xem và không nói gì" — và một backfill "hợp lý" thêm
      vào sau này sẽ làm bài này đỏ, đúng lúc cần đỏ.
    */
    assert.equal(await dem("select count(*)::int as n from cs_cases where id = 'up-c1' and semantic is null"), 1, "case cũ phải ở NULL — KHÔNG backfill, không mặc định");
    /*
      TRẠNG THÁI `NEEDS_REVIEW` KHÔNG CẦN MIGRATION, và bài này chứng minh điều đó thay vì tin lời.

      `cs_cases.status` là `text` không ràng buộc CHECK, nên mức tin cậy GIỮA chỉ là một giá trị
      mới của một cột đã có. Ngày nào có người thêm CHECK vào cột ấy thì bài này đỏ — đúng lúc cần
      đỏ, chứ không phải lúc job quét chạy trên production.
    */
    await client.query(`insert into cs_cases (id, kind, status, title) values ('up-c2', 'RETURN', 'NEEDS_REVIEW', 'Máy thấy nghi, người chưa xem')`);
    assert.equal(await dem("select count(*)::int as n from cs_cases where id = 'up-c2' and status = 'NEEDS_REVIEW'"), 1, "trạng thái 'chờ người xem lại' phải ghi được mà không cần migration");

    /*
      ═══ 0108: SỔ QUYẾT ĐỊNH QUẢNG CÁO — THUẦN BỔ SUNG, VÀ KHOÁ THEO NGÀY PHẢI THẬT ═══

      Ba điều, và điều thứ hai là điều duy nhất khiến bảng này dùng được cho một cỗ máy tự chủ:
      job ghi sổ chạy nhiều lượt mỗi ngày, nên "chạy lại không đẻ dòng thứ hai" phải là một BẢO ĐẢM
      ở tầng dữ liệu chứ không phải một mệnh đề trong mã.
    */
    assert.equal(await dem("select count(*)::int as n from information_schema.tables where table_name = 'ads_decision_ledger'"), 1, "0108: bảng sổ quyết định phải có mặt");
    await client.query(`insert into ads_decision_ledger (id, decision_day, dimension, entity_key, action, action_class, period_from, period_to, rule_version, rule_snapshot, spend_known) values ('up-dl1', '2026-09-22', 'campaign', 'c1', 'CUT', 'ACTIONABLE', '2026-09-08', '2026-09-21', 1, '{}'::jsonb, true)`);
    await assert.rejects(
      () => client.query(`insert into ads_decision_ledger (id, decision_day, dimension, entity_key, action, action_class, period_from, period_to, rule_version, rule_snapshot, spend_known) values ('up-dl2', '2026-09-22', 'campaign', 'c1', 'SCALE', 'ACTIONABLE', '2026-09-08', '2026-09-21', 1, '{}'::jsonb, true)`),
      () => true,
      "0108: một mục chỉ được MỘT dòng mỗi ngày — lượt chạy thứ hai phải là cập nhật, không phải dòng mới",
    );
    // Hạng lạ bị CSDL chặn: một dòng `undefined` lọt vào sẽ làm mọi phép lọc "việc cần làm" nói sai.
    await assert.rejects(
      () => client.query(`insert into ads_decision_ledger (id, decision_day, dimension, entity_key, action, action_class, period_from, period_to, rule_version, rule_snapshot, spend_known) values ('up-dl3', '2026-09-22', 'campaign', 'c2', 'CUT', 'MAYBE', '2026-09-08', '2026-09-21', 1, '{}'::jsonb, true)`),
      () => true,
      "0108: hạng hành động ngoài ba giá trị đã khai phải bị CSDL từ chối",
    );
    // Ngày phải là NGÀY. Chuỗi lạ làm mọi phép so chuỗi theo thứ tự nói sai mà không gì đỏ.
    await assert.rejects(
      () => client.query(`insert into ads_decision_ledger (id, decision_day, dimension, entity_key, action, action_class, period_from, period_to, rule_version, rule_snapshot, spend_known) values ('up-dl4', '22/09/2026', 'campaign', 'c3', 'CUT', 'ACTIONABLE', '2026-09-08', '2026-09-21', 1, '{}'::jsonb, true)`),
      () => true,
      "0108: `decision_day` sai định dạng phải bị CSDL từ chối",
    );
    // Sổ bắt đầu RỖNG ngoài dòng vừa gieo: KHÔNG backfill. Kết luận của quá khứ không dựng lại được
    // từ dữ liệu hôm nay — đơn hôm ấy còn treo nay đã ngã ngũ (AGENTS.md mục 8.8).
    assert.equal(await dem("select count(*)::int as n from ads_decision_ledger where id <> 'up-dl1'"), 0, "0108: migration KHÔNG được dựng hộ một dòng lịch sử nào");

    /*
      ═══ 0109: SỔ LƯỢT GHI NGÂN SÁCH — BA RÀNG BUỘC PHẢI CHẶN THẬT ═══

      Sổ này là thứ duy nhất cho phép QUAY LUI một lượt đổi ngân sách, nên hình dạng của nó phải
      đúng trước khi có đồng nào đi qua. Ràng buộc thứ ba đáng nói nhất: một dòng vừa APPLIED vừa
      mang mã chặn là một dòng không ai đọc được, và nó làm mọi phép đếm "máy đã định làm gì" nói sai.
    */
    assert.equal(await dem("select count(*)::int as n from information_schema.tables where table_name = 'ads_budget_changes'"), 1, "0109: bảng sổ lượt ghi phải có mặt");
    await client.query(`insert into ads_budget_changes (id, change_day, campaign_id, action, outcome, decision, mode) values ('up-bc1', '2026-09-22', 'c1', 'SET_DAILY_BUDGET', 'DENIED', 'SCALE', 'COPILOT')`);
    await assert.rejects(
      () => client.query(`insert into ads_budget_changes (id, change_day, campaign_id, action, outcome, decision, mode) values ('up-bc2', '2026-09-22', 'c1', 'SET_DAILY_BUDGET', 'MAYBE', 'SCALE', 'COPILOT')`),
      () => true,
      "0109: kết quả ngoài ba giá trị đã khai phải bị CSDL từ chối",
    );
    await assert.rejects(
      () => client.query(`insert into ads_budget_changes (id, change_day, campaign_id, action, outcome, decision, mode) values ('up-bc3', '2026-09-22', 'c1', 'CREATE_CAMPAIGN', 'APPLIED', 'SCALE', 'COPILOT')`),
      () => true,
      "0109: hành động ngoài hai hành động đã khai phải bị từ chối — không có hành động thứ ba",
    );
    await assert.rejects(
      () => client.query(`insert into ads_budget_changes (id, change_day, campaign_id, action, outcome, denial, decision, mode) values ('up-bc4', '2026-09-22', 'c1', 'SET_DAILY_BUDGET', 'APPLIED', 'DAILY_CAP', 'SCALE', 'COPILOT')`),
      () => true,
      "0109: một dòng vừa ĐÃ ÁP vừa mang mã chặn phải bị từ chối",
    );
    // Xoá dòng sổ quyết định KHÔNG được cuốn theo bằng chứng một lượt ghi đã xảy ra.
    await client.query(`update ads_budget_changes set ledger_id = 'up-dl1' where id = 'up-bc1'`);
    /*
      ─── 0111: CĂN CỨ CỦA KẾT LUẬN ───

      Dòng `up-dl1` được ghi ở BƯỚC 2 bằng câu lệnh KHÔNG nhắc tới `basis` — đúng như mọi dòng đã
      nằm sẵn trên production trước khi cột này tồn tại. Nó phải nhận `ACTUAL`, và đó không phải
      một phép đoán: luật cũ chỉ kết luận khi đã đủ độ chín, nên `ACTUAL` là lời khai ĐÚNG về cách
      những dòng ấy được sinh ra.
    */
    assert.equal(await dem("select count(*)::int as n from ads_decision_ledger where id = 'up-dl1' and basis = 'ACTUAL'"), 1, "0111: dòng cũ phải nhận căn cứ ACTUAL — luật cũ chỉ kết luận khi đã đủ độ chín");
    await assert.rejects(
      () => client.query(`insert into ads_decision_ledger (id, decision_day, dimension, entity_key, action, action_class, basis, period_from, period_to, rule_version, rule_snapshot, spend_known) values ('up-dl5', '2026-09-23', 'campaign', 'c5', 'CUT', 'ACTIONABLE', 'GUESS', '2026-09-08', '2026-09-21', 2, '{}'::jsonb, true)`),
      () => true,
      "0111: căn cứ lạ phải bị chặn — cổng ghi ngân sách so sánh theo đúng hai chuỗi này",
    );
    await client.query(`insert into ads_decision_ledger (id, decision_day, dimension, entity_key, action, action_class, basis, period_from, period_to, rule_version, rule_snapshot, spend_known) values ('up-dl6', '2026-09-23', 'campaign', 'c6', 'SCALE', 'ACTIONABLE', 'PROJECTED', '2026-08-25', '2026-09-07', 2, '{}'::jsonb, true)`);
    assert.equal(await dem("select count(*)::int as n from ads_decision_ledger where id = 'up-dl6' and basis = 'PROJECTED'"), 1, "0111: căn cứ tạm tính ghi được");
    await client.query(`delete from ads_decision_ledger where id in ('up-dl6')`);

    await client.query(`delete from ads_decision_ledger where id = 'up-dl1'`);
    assert.equal(await dem("select count(*)::int as n from ads_budget_changes where id = 'up-bc1' and ledger_id is null"), 1, "0109: xoá dòng sổ quyết định phải để lại lượt ghi, chỉ gỡ khoá");

    /*
      ═══ 0110: HẠT CHI TIÊU QUẢNG CÁO — KHAI ĐÚNG, VÀ KHÔNG ĐỤNG MỘT ĐỒNG NÀO ═══

      `ad_spends` là nguồn thẩm quyền của tiền quảng cáo ở mọi báo cáo lợi nhuận và lương. Migration
      này chỉ THÊM cột; điều phải chứng minh là nó không làm đổi `spend` của dòng nào, và nó khai
      đúng hạt cho cả dòng đồng bộ lẫn dòng gõ tay.
    */
    assert.equal(await dem("select count(*)::int as n from ad_spends where id = 'up-as1' and spend = 1234567 and grain = 'CAMPAIGN'"), 1, "0110: dòng đồng bộ giữ nguyên tiền và nhận hạt CAMPAIGN");
    assert.equal(await dem("select count(*)::int as n from ad_spends where id = 'up-as2' and spend = 500000 and grain = 'MANUAL'"), 1, "0110: dòng GÕ TAY (external_key rỗng) phải nhận hạt MANUAL — đường ghi không bao giờ được xoá nó");
    // Hạt lạ bị CSDL chặn: một giá trị ngoài ba hạt đã khai sẽ lọt qua mọi phép lọc và âm thầm cộng đúp.
    await assert.rejects(
      () => client.query(`insert into ad_spends (id, platform, campaign, spend, spend_date, grain) values ('up-as3', 'Facebook', 'X', 1, now(), 'ADSET')`),
      () => true,
      "0110: hạt ngoài ba giá trị đã khai phải bị CSDL từ chối",
    );
    // Hạt AD mà không có mã mẩu là dòng tự mâu thuẫn — rơi khỏi mọi phép gộp cấp mẩu nhưng vẫn vào tổng.
    await assert.rejects(
      () => client.query(`insert into ad_spends (id, platform, campaign, spend, spend_date, grain) values ('up-as4', 'Facebook', 'X', 1, now(), 'AD')`),
      () => true,
      "0110: hạt AD bắt buộc phải có ad_id",
    );
    await client.query(`insert into ad_spends (id, platform, campaign, spend, spend_date, grain, ad_id, adset_id) values ('up-as5', 'Facebook', 'X', 1, now(), 'AD', 'ad-1', 'set-1')`);
    assert.equal(await dem("select count(*)::int as n from ad_spends where id = 'up-as5' and grain = 'AD'"), 1, "0110: hạt AD kèm mã mẩu thì ghi được");

    /*
      ═══ 0082: SỔ HÀNG HOÀN ĐƯA VÀO BẰNG CHÍNH ERP — MỘT BẢNG MỚI, KHOÁ LÀ NỘI DUNG ═══

      Bảng này là đường thay cho `scp`. Hai điều phải đúng: bảng có mặt, và cùng NỘI DUNG thì chỉ
      một dòng — kể cả khi người dùng đổi tên tệp, mà họ luôn đổi ("Bản sao của…", "… (1).xlsx").
      Hai dòng cho một tệp nghĩa là hai lượt đối soát đọc hai thứ khác nhau.
    */
    assert.equal(await dem("select count(*)::int as n from information_schema.tables where table_name = 'hmt_workbooks'"), 1, "0082 (nay thuộc trạng thái production): bảng hmt_workbooks vẫn còn");
    await client.query(`insert into hmt_workbooks (id, filename, sha256, bytes, content, uploaded_by) values ('up-wb1', 'so.xlsx', 'abc123', 3, 'AAA', 'Chủ shop')`);
    await assert.rejects(
      () => client.query(`insert into hmt_workbooks (id, filename, sha256, bytes, content, uploaded_by) values ('up-wb2', 'so (1).xlsx', 'abc123', 3, 'AAA', 'Chủ shop')`),
      () => true,
      "0082 (nay đã ở production): cùng nội dung, khác tên vẫn phải là MỘT bản",
    );
    // Người tải lên bị xoá tài khoản ⇒ khoá về NULL, DÒNG Ở LẠI: xoá bằng chứng theo người là mất dấu một lượt đối soát.
    await client.query(`update hmt_workbooks set uploaded_by_user_id = 'up-u1' where id = 'up-wb1'`);
    await client.query(`delete from users where id = 'up-u1'`);
    assert.equal(await dem("select count(*)::int as n from hmt_workbooks where id = 'up-wb1' and uploaded_by_user_id is null"), 1, "0082: xoá tài khoản người tải KHÔNG được cuốn theo dòng bằng chứng");
    await client.query(`insert into users (id, email, name, password_hash, role) values ('up-u1', 'a@shop.vn', 'An', 'x', 'CS')`);

    /*
      ═══ 0085: CHỮ GỐC CỦA LÝ DO HOÀN ═══

      Cột thêm vào, KHÔNG backfill: dòng ghi TRƯỚC bản này phải ở chuỗi rỗng. Rỗng nghĩa là CHƯA
      CÓ CHỨNG TỪ — đoán hộ chữ gốc cho dòng cũ là bịa ra một chứng từ, và sau đó không ai phân
      biệt được "ĐVVC có nói" với "ta đoán hộ". Lý do và nhóm của dòng cũ cũng phải y nguyên: bản
      này không chạm vào một quan sát nào.
    */
    assert.equal(await dem("select count(*)::int as n from information_schema.columns where table_name = 'shipment_return_reasons' and column_name = 'raw_reason'"), 1, "0085 (nay thuộc trạng thái production): cột raw_reason vẫn còn");
    assert.equal(await dem("select count(*)::int as n from shipment_return_reasons where id = 'up-rr1' and raw_reason = '' and reason = 'SIZE_TIGHT' and reason_group = 'SIZE'"), 1, "dòng cũ giữ nguyên lý do và nhóm, chữ gốc RỖNG — không backfill, không mặc định");
    await client.query(`insert into shipment_return_reasons (id, shipment_id, reason, reason_group, raw_reason, actor_email) values ('up-rr2', 'up-s8', 'CUSTOMER_UNREACHABLE', 'SLOW', 'Tồn - Khách hàng nghỉ, không có nhà', 'a@shop.vn')`);

    /*
      ═══ 0087: BẢNG QUAN SÁT LÝ DO HOÀN — CHỈ THÊM, KHOÁ LÀ NỘI DUNG ═══

      Bốn điều phải đúng, mỗi điều chặn một cách hỏng khác nhau:
        1. bảng có mặt;
        2. KHÔNG backfill — dòng kết luận `up-rr1` có từ trước không được mọc ra một "quan sát" với
           mốc thời gian bịa (AGENTS.md mục 35);
        3. cùng NỘI DUNG chỉ một dòng — webhook Viettel Post gửi trùng (họ thử lại tối đa 5 lần) và
           lượt rút quan sát chạy lại đều không được nhân bản chứng cứ;
        4. một quan sát rỗng chữ, hoặc không gắn vào kiện lẫn đơn nào, bị chặn ở CSDL: một dòng như
           thế làm tăng mẫu số "đã có lý do" mà không có gì để đọc.
    */
    assert.equal(await dem("select count(*)::int as n from information_schema.tables where table_name = 'return_reason_observations'"), 1, "0087: bảng quan sát phải được tạo");
    assert.equal(await dem("select count(*)::int as n from return_reason_observations"), 0, "0087: KHÔNG gieo sẵn quan sát nào — dựng hộ một lần 'ai đó nói' là bịa ra chứng cứ");
    await client.query(`insert into return_reason_observations (id, shipment_id, source, raw_text, reason_at_write, occurred_at, dedupe_key) values ('up-ob1', 'up-s9', 'CARRIER_TEXT', 'Tồn - Khách từ chối nhận', 'UNKNOWN', now(), 'up|CARRIER_TEXT|1')`);
    await assert.rejects(
      () => client.query(`insert into return_reason_observations (id, shipment_id, source, raw_text, reason_at_write, occurred_at, dedupe_key) values ('up-ob2', 'up-s9', 'CARRIER_TEXT', 'Tồn - Khách từ chối nhận', 'UNKNOWN', now(), 'up|CARRIER_TEXT|1')`),
      (e: unknown) => /unique|duplicate/i.test(String((e as { message?: string })?.message ?? e)),
      "0087: cùng một quan sát ghi lần hai phải bị chặn — nếu không, chạy lại là nhân bản chứng cứ",
    );
    await assert.rejects(
      () => client.query(`insert into return_reason_observations (id, shipment_id, source, raw_text, reason_at_write, occurred_at, dedupe_key) values ('up-ob3', 'up-s9', 'CARRIER_TEXT', '   ', 'UNKNOWN', now(), 'up|CARRIER_TEXT|2')`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("return_reason_obs_raw_check"),
      "0087: quan sát KHÔNG có chữ nào là một mẫu số tăng lên mà không có gì để đọc",
    );
    await assert.rejects(
      () => client.query(`insert into return_reason_observations (id, source, raw_text, reason_at_write, occurred_at, dedupe_key) values ('up-ob4', 'CARRIER_TEXT', 'không gắn vào đâu cả', 'UNKNOWN', now(), 'up|CARRIER_TEXT|3')`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("return_reason_obs_link_check"),
      "0087: quan sát không gắn vào kiện lẫn đơn nào thì không ai tra ngược được",
    );
    // Xoá kiện thì quan sát đi theo; nhưng quan sát KHÔNG giữ kiện lại.
    await client.query(`insert into shipments (id, tracking_code, stage) values ('up-s5', 'UPS5', 'RETURNED')`);
    await client.query(`insert into return_reason_observations (id, shipment_id, source, raw_text, reason_at_write, occurred_at, dedupe_key) values ('up-ob5', 'up-s5', 'CARRIER_TEXT', 'Tồn - Khách hẹn giao lại', 'UNKNOWN', now(), 'up|CARRIER_TEXT|5')`);
    await client.query(`delete from shipments where id = 'up-s5'`);
    assert.equal(await dem("select count(*)::int as n from return_reason_observations where id = 'up-ob5'"), 0, "0087: xoá kiện thì quan sát của nó đi theo, không để lại dòng mồ côi");
    assert.equal(await dem(`select count(*)::int as n from shipment_return_reasons where id = 'up-rr2' and raw_reason like 'Tồn - %'`), 1, "0085: chữ gốc ghi được NGUYÊN VĂN, kể cả dấu tiếng Việt");

    /*
      ═══ 0088: KỲ LƯƠNG — CHỈ THÊM BẢNG, VÀ "CHỐT" PHẢI CÓ NGHĨA ═══

      Năm điều phải đúng, mỗi điều chặn một cách hỏng khác nhau:
        1. bảng có mặt và RỖNG — không kỳ nào tự nhiên thành "đã chốt" vì một lượt nâng cấp;
        2. chốt mà KHÔNG có ảnh chụp bị CSDL chặn: "chốt" như thế không có nghĩa gì, lần mở sau vẫn
           tính lại và số sẽ khác;
        3. một kỳ + một cơ sở = MỘT dòng — hai bản chốt cùng kỳ bằng hai cơ sở là hai câu trả lời
           khác nhau cho cùng một câu hỏi, và không ai biết cái nào đã dùng để trả tiền;
        4. cơ sở lạ bị chặn;
        5. và nó KHÔNG đụng tới một dòng nghiệp vụ nào đang có.
    */
    assert.equal(await dem("select count(*)::int as n from information_schema.tables where table_name = 'payroll_periods'"), 1, "0088: bảng kỳ lương phải được tạo");
    assert.equal(await dem("select count(*)::int as n from payroll_periods"), 0, "0088: KHÔNG gieo sẵn kỳ nào — một lượt nâng cấp không được biến kỳ nào thành 'đã chốt'");
    await assert.rejects(
      () => client.query(`insert into payroll_periods (id, period_key, period_start, period_end, basis, status) values ('up-pp-bad', '2026-09-01..2026-09-30', now(), now(), 'profit1', 'FINAL')`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("payroll_periods_final_check"),
      "0088: chốt mà không có ảnh chụp phải bị chặn — nếu không, lần mở sau vẫn tính lại và số sẽ khác",
    );
    await assert.rejects(
      () => client.query(`insert into payroll_periods (id, period_key, period_start, period_end, basis) values ('up-pp-bad2', '2026-09-01..2026-09-30', now(), now(), 'khong-ton-tai')`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("payroll_periods_basis_check"),
      "0088: cơ sở lợi nhuận lạ bị chặn ở CSDL",
    );
    await client.query(`insert into payroll_periods (id, period_key, period_start, period_end, basis, status, snapshot, finalized_at) values ('up-pp1', '2026-09-01..2026-09-30', '2026-09-01', '2026-09-30', 'profit1', 'FINAL', '{"totalSalary": 9000000}'::jsonb, now())`);
    await assert.rejects(
      () => client.query(`insert into payroll_periods (id, period_key, period_start, period_end, basis) values ('up-pp2', '2026-09-01..2026-09-30', '2026-09-01', '2026-09-30', 'profit1')`),
      (e: unknown) => /unique|duplicate/i.test(String((e as { message?: string })?.message ?? e)),
      "0088: một kỳ + một cơ sở chỉ được MỘT dòng",
    );
    // Cùng kỳ nhưng cơ sở KHÁC thì được — đó là hai câu trả lời cho hai câu hỏi khác nhau.
    await client.query(`insert into payroll_periods (id, period_key, period_start, period_end, basis) values ('up-pp3', '2026-09-01..2026-09-30', '2026-09-01', '2026-09-30', 'nominal')`);
    assert.equal(await dem("select count(*)::int as n from payroll_periods where period_key = '2026-09-01..2026-09-30'"), 2, "0088: cùng kỳ, khác cơ sở ⇒ hai dòng");

    /*
      ═══ 0089 · SỔ LỖ LŨY KẾ THEO TỪNG MKTer ═══

      Năm điều phải đúng sau một lượt nâng cấp:
        1. bảng được tạo;
        2. RỖNG — không backfill, không đặt số dư cho ai. Đặt 0 cho tất cả là KHẲNG ĐỊNH rằng không
           ai còn lỗ, và khẳng định không căn cứ ấy trả tiền thật ra ngoài (AGENTS.md mục 35);
        3. số dư dương bị chặn — "lãi mang sang" là trả hoa hồng hai lần;
        4. chốt mà thiếu ảnh chụp bị chặn;
        5. một người + một tháng = MỘT dòng, và khoá ấy không kèm calc_version.
    */
    assert.equal(await dem("select count(*)::int as n from information_schema.tables where table_name = 'marketer_profit_carryover'"), 1, "0089: bảng sổ lỗ lũy kế phải được tạo");
    assert.equal(await dem("select count(*)::int as n from marketer_profit_carryover"), 0, "0089: KHÔNG gieo số dư cho ai — nâng cấp không được tự khẳng định 'người này hết lỗ'");
    await assert.rejects(
      () => client.query(`insert into marketer_profit_carryover (id, employee_id, month_key, opening_balance, opening_source, real_profit, commission_base, commission_rate_bp, signed_commission, payable_commission, closing_balance) values ('up-co-bad', 'mkt-1', '2026-09', 5000000, 'OPENING_DECLARATION', 0, 0, 1000, 0, 0, 0)`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("marketer_carryover_opening_check"),
      "0089: số dư đầu DƯƠNG bị chặn — lãi đã được trả hoa hồng ở tháng nó phát sinh, mang sang là trả hai lần",
    );
    await assert.rejects(
      () => client.query(`insert into marketer_profit_carryover (id, employee_id, month_key, opening_balance, opening_source, real_profit, commission_base, commission_rate_bp, signed_commission, payable_commission, closing_balance, status) values ('up-co-bad2', 'mkt-1', '2026-09', 0, 'OPENING_DECLARATION', 0, 0, 1000, 0, 0, 0, 'FINAL')`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("marketer_carryover_final_check"),
      "0089: chốt mà thiếu ảnh chụp bị chặn",
    );
    await assert.rejects(
      () => client.query(`insert into marketer_profit_carryover (id, employee_id, month_key, opening_balance, opening_source, real_profit, commission_base, commission_rate_bp, signed_commission, payable_commission, closing_balance) values ('up-co-bad3', 'mkt-1', '2026-9', 0, 'OPENING_DECLARATION', 0, 0, 1000, 0, 0, 0)`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("marketer_carryover_month_format"),
      "0089: khoá tháng sai định dạng bị chặn ngay ở CSDL",
    );
    await client.query(`insert into marketer_profit_carryover (id, employee_id, month_key, opening_balance, opening_source, real_profit, loss_applied, commission_base, commission_rate_bp, signed_commission, payable_commission, closing_balance) values ('up-co1', 'mkt-1', '2026-09', -10000000, 'OPENING_DECLARATION', 6000000, 6000000, 0, 1000, -400000, 0, -4000000)`);
    await assert.rejects(
      () => client.query(`insert into marketer_profit_carryover (id, employee_id, month_key, opening_balance, opening_source, real_profit, commission_base, commission_rate_bp, signed_commission, payable_commission, closing_balance, calc_version) values ('up-co2', 'mkt-1', '2026-09', -10000000, 'OPENING_DECLARATION', 6000000, 0, 1000, -400000, 0, -4000000, 99)`),
      (e: unknown) => /unique|duplicate/i.test(String((e as { message?: string })?.message ?? e)),
      "0089: một người + một tháng = MỘT dòng — đổi calc_version KHÔNG được sinh dòng chính thức thứ hai cho cùng nghĩa vụ",
    );
    // Người KHÁC cùng tháng thì được — sổ đi theo từng người, không phải một dòng chung.
    await client.query(`insert into marketer_profit_carryover (id, employee_id, month_key, opening_balance, opening_source, real_profit, commission_base, commission_rate_bp, signed_commission, payable_commission, closing_balance) values ('up-co3', 'mkt-2', '2026-09', 0, 'OPENING_DECLARATION', 12000000, 12000000, 1000, 1200000, 1200000, 0)`);
    assert.equal(await dem("select count(*)::int as n from marketer_profit_carryover where month_key = '2026-09'"), 2, "0089: hai người, hai dòng — không bù chéo, không gộp");

    /*
      ═══ 0096 · CHÍNH SÁCH LƯƠNG CHUNG CHO TOÀN CÔNG TY ═══

      Điều QUAN TRỌNG NHẤT của bản này là thứ nó KHÔNG làm: không gán chính sách cho ai. Người chưa
      gán vẫn đi đúng đường tính cũ, nên ngay sau một lượt nâng cấp, mọi kỳ — kể cả kỳ đã chốt —
      vẫn ra y hệt con số hôm qua. Một migration lương mà tự gán chính sách cho người thật là một
      migration đổi tiền của người thật mà không ai bấm.
    */
    for (const bang of ["salary_policies", "salary_policy_versions", "salary_policy_components", "employment_assignments", "employee_policy_assignments", "payroll_inputs", "payroll_adjustments"]) {
      assert.equal(await dem(`select count(*)::int as n from information_schema.tables where table_name = '${bang}'`), 1, `0096: bảng ${bang} phải được tạo`);
      assert.equal(await dem(`select count(*)::int as n from ${bang}`), 0, `0096: ${bang} phải RỖNG — nâng cấp không được khai hộ ai một cơ chế trả tiền`);
    }

    await client.query(`insert into salary_policies (id, code, name) values ('up-pol1', 'WAREHOUSE_HOURLY', 'Kho — theo giờ')`);
    await client.query(`insert into salary_policy_versions (id, policy_id, version, effective_from, status) values ('up-pv1', 'up-pol1', 1, '2026-09-01', 'ACTIVE')`);

    /*
      BÙ LỖ CHỈ CÓ NGHĨA TRÊN ĐẠI LƯỢNG CÓ THỂ ÂM.

      Doanh thu, số đơn, giờ công, sản phẩm không bao giờ âm — bật bù lỗ ở đó tạo ra một dòng sổ
      không bao giờ khác 0, và nó sẽ đứng trên màn hình như một nghĩa vụ có thật. Khoá ở CSDL chứ
      không chỉ ở zod: một script chạy tay cũng phải đi qua luật này.
    */
    await assert.rejects(
      () => client.query(`insert into salary_policy_components (id, version_id, code, label, kind, calc_type, basis_key, calc, carry_forward) values ('up-pc-bad', 'up-pv1', 'C', 'Hoa hồng doanh thu', 'COMMISSION', 'RATE_OF_BASIS', 'REVENUE_PERSONAL', '{}'::jsonb, true)`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("salary_policy_components_carry_check"),
      "0096: bật bù lỗ trên doanh thu bị chặn — doanh thu không bao giờ âm",
    );
    await assert.rejects(
      () => client.query(`insert into salary_policy_components (id, version_id, code, label, kind, calc_type, calc, min_amount, max_amount) values ('up-pc-bad2', 'up-pv1', 'C2', 'Trần dưới sàn', 'BONUS', 'FIXED_AMOUNT', '{}'::jsonb, 5000000, 1000000)`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("salary_policy_components_bound_check"),
      "0096: trần thấp hơn sàn bị chặn — cặp ấy không có giá trị nào thoả",
    );
    await client.query(`insert into salary_policy_components (id, version_id, code, label, kind, calc_type, basis_key, calc) values ('up-pc1', 'up-pv1', 'HOURLY', 'Lương giờ', 'TIME_BASED', 'PER_UNIT', 'WORK_HOURS', '{"type":"PER_UNIT","basisKey":"WORK_HOURS","unitRate":35000}'::jsonb)`);
    await assert.rejects(
      () => client.query(`insert into salary_policy_components (id, version_id, code, label, kind, calc_type, calc) values ('up-pc2', 'up-pv1', 'HOURLY', 'Trùng khoá', 'BONUS', 'FIXED_AMOUNT', '{}'::jsonb)`),
      (e: unknown) => /unique|duplicate/i.test(String((e as { message?: string })?.message ?? e)),
      "0096: hai thành phần cùng khoá trong một phiên bản bị chặn — máy tính gộp theo khoá nên chúng sẽ cộng thành một dòng không ai đối chiếu lại được",
    );

    /*
      XOÁ MỘT CHÍNH SÁCH ĐANG GÁN CHO NGƯỜI LÀ LÀM MỒ CÔI MỌI KỲ ĐÃ TÍNH BẰNG NÓ.
      Muốn ngừng dùng thì TẮT, không xoá — nên khoá ngoại để `RESTRICT`.
    */
    await client.query(`insert into employee_policy_assignments (id, employee_id, policy_id, effective_from) values ('up-epa1', 'nv-1', 'up-pol1', '2026-09-01')`);
    await assert.rejects(
      () => client.query(`delete from salary_policies where id = 'up-pol1'`),
      (e: unknown) => /foreign key|violates/i.test(String((e as { message?: string })?.message ?? e)),
      "0096: xoá chính sách đang gán cho người bị chặn — lịch sử lương tính bằng nó sẽ mồ côi",
    );

    // Mốc hiệu lực phải xuôi chiều: `effective_to` trước `effective_from` là một đoạn rỗng đội lốt.
    await assert.rejects(
      () => client.query(`insert into employment_assignments (id, employee_id, effective_from, effective_to) values ('up-ea-bad', 'nv-1', '2026-09-30', '2026-09-01')`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("employment_assignments_range_check"),
      "0096: mốc kết thúc trước mốc bắt đầu bị chặn",
    );
    await assert.rejects(
      () => client.query(`insert into employment_assignments (id, employee_id, work_mode, effective_from) values ('up-ea-bad2', 'nv-1', 'TU_XA', '2026-09-01')`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("employment_assignments_mode_check"),
      "0096: nơi làm việc lạ bị chặn ở CSDL — danh sách ĐÓNG, không có ô gõ tự do",
    );
    await client.query(`insert into employment_assignments (id, employee_id, employment_type, work_mode, effective_from) values ('up-ea1', 'nv-1', 'PART_TIME', 'REMOTE', '2026-09-01')`);

    /*
      NHẬP LẠI MỘT ĐẠI LƯỢNG LÀ SỬA, KHÔNG PHẢI THÊM DÒNG THỨ HAI.
      Không có khoá này thì mỗi lượt tính lại cộng dồn giờ công, và lương tăng mỗi lần ai đó mở
      trang (yêu cầu mục 28 — tính lại phải bất biến).
    */
    await client.query(`insert into payroll_inputs (id, employee_id, period_key, input_key, value, entered_by_name) values ('up-pi1', 'nv-1', '2026-09-01..2026-09-30', 'WORK_HOURS', 96, 'Chủ shop')`);
    await assert.rejects(
      () => client.query(`insert into payroll_inputs (id, employee_id, period_key, input_key, value, entered_by_name) values ('up-pi2', 'nv-1', '2026-09-01..2026-09-30', 'WORK_HOURS', 96, 'Chủ shop')`),
      (e: unknown) => /unique|duplicate/i.test(String((e as { message?: string })?.message ?? e)),
      "0096: nhập lại cùng đại lượng cho cùng kỳ phải là SỬA — dòng thứ hai làm mỗi lượt tính lại cộng dồn",
    );

    /*
      SỐ TIỀN ĐIỀU CHỈNH LUÔN DƯƠNG; DẤU DO `kind` QUYẾT ĐỊNH.
      Cho gõ số âm là để một dấu trừ nhầm biến khoản khấu trừ thành khoản thưởng.
    */
    await assert.rejects(
      () => client.query(`insert into payroll_adjustments (id, employee_id, period_key, kind, label, amount, reason) values ('up-adj-bad', 'nv-1', '2026-09-01..2026-09-30', 'ADVANCE', 'Ứng', -3000000, 'x')`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("payroll_adjustments_amount_check"),
      "0096: số tiền điều chỉnh âm bị chặn — dấu do loại khoản quyết định, không do người gõ",
    );
    await assert.rejects(
      () => client.query(`insert into payroll_adjustments (id, employee_id, period_key, kind, label, amount, reason) values ('up-adj-bad2', 'nv-1', '2026-09-01..2026-09-30', 'PHAT', 'Phạt', 100000, 'x')`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("payroll_adjustments_kind_check"),
      "0096: loại khoản lạ bị chặn — danh sách ĐÓNG",
    );
    await assert.rejects(
      () => client.query(`insert into payroll_adjustments (id, employee_id, period_key, kind, label, amount) values ('up-adj-bad3', 'nv-1', '2026-09-01..2026-09-30', 'ADVANCE', 'Ứng', 3000000)`),
      (e: unknown) => /null value|not-null/i.test(String((e as { message?: string })?.message ?? e)),
      "0096: khoản tiền không có LÝ DO bị chặn — một khoản không ai duyệt lại được",
    );

    /*
      ═══ SỔ LỖ NỚI KHOÁ THEO THÀNH PHẦN — DÒNG CŨ KHÔNG ĐỔI NGHĨA ═══

      Cột có MẶC ĐỊNH, nên hai dòng gieo ở khối 0089 (ghi TRƯỚC khi có cột) phải mang đúng khoá của
      đường tính cũ. Nếu chúng rơi vào một khoá khác thì chuỗi số dư đang chạy đứt, và tháng sau sẽ
      đọc "chưa có dòng nào" rồi coi số dư là CHƯA BIẾT — một kỳ lương không chốt được vì một lượt
      nâng cấp.
    */
    assert.equal(await dem("select count(*)::int as n from marketer_profit_carryover where component_code = 'MARKETING_PROFIT'"), 2, "0096: dòng sổ lỗ có từ trước phải mang khoá thành phần của đường tính cũ");
    // Và nay MỘT người, MỘT tháng có thể mang HAI chuỗi số dư riêng cho hai khoản khác nhau.
    await client.query(`insert into marketer_profit_carryover (id, employee_id, month_key, component_code, opening_balance, opening_source, real_profit, commission_base, commission_rate_bp, signed_commission, payable_commission, closing_balance) values ('up-co4', 'mkt-1', '2026-09', 'TEAM_PROFIT', 0, 'OPENING_DECLARATION', 3000000, 3000000, 500, 150000, 150000, 0)`);
    assert.equal(await dem("select count(*)::int as n from marketer_profit_carryover where employee_id = 'mkt-1' and month_key = '2026-09'"), 2, "0096: hai khoản bù lỗ của cùng một người là hai chuỗi số dư RIÊNG");
    await assert.rejects(
      () => client.query(`insert into marketer_profit_carryover (id, employee_id, month_key, component_code, opening_balance, opening_source, real_profit, commission_base, commission_rate_bp, signed_commission, payable_commission, closing_balance) values ('up-co5', 'mkt-1', '2026-09', 'TEAM_PROFIT', 0, 'OPENING_DECLARATION', 1, 1, 500, 0, 0, 0)`),
      (e: unknown) => /unique|duplicate/i.test(String((e as { message?: string })?.message ?? e)),
      "0096: nới khoá KHÔNG phải nới lỏng — một người + một tháng + một thành phần vẫn chỉ MỘT dòng",
    );

    /*
      ═══ 0097 · VÒNG ĐỜI KỲ LƯƠNG: SÁU TRẠNG THÁI, VÀ `FINAL` CŨ KHÔNG BỊ VIẾT LẠI ═══

      Điều quan trọng nhất là điều migration này KHÔNG làm: nó không đụng vào dòng `FINAL` nào.
      Đó là các kỳ ĐÃ TRẢ TIỀN; viết đè trạng thái của chúng thành 'LOCKED' "cho sạch bảng" là sửa
      dữ liệu của một kỳ bất biến. `FINAL` ở lại trong CHECK và được ĐỌC như `LOCKED`.
    */
    assert.equal(await dem("select count(*)::int as n from information_schema.columns where table_name = 'payroll_periods' and column_name = 'approved_by'"), 1, "0097: cột người duyệt phải được thêm");
    assert.equal(await dem("select count(*)::int as n from payroll_periods where status = 'FINAL'"), 1, "0097: dòng FINAL có từ trước KHÔNG bị viết lại — đó là một kỳ đã trả tiền");

    // Bốn trạng thái mới ghi được.
    await client.query(`insert into payroll_periods (id, period_key, period_start, period_end, basis, status, snapshot, finalized_at) values ('up-pp4', '2026-10-01..2026-10-31', '2026-10-01', '2026-10-31', 'profit1', 'CALCULATED', '{"totalSalary": 1}'::jsonb, now())`);
    assert.equal(await dem("select count(*)::int as n from payroll_periods where status = 'CALCULATED'"), 1, "0097: trạng thái CALCULATED ghi được");

    /*
      MỘT CHỮ KÝ KHÔNG CÓ TÊN LÀ MỘT CHỮ KÝ TRỐNG.

      Ba ràng buộc dưới đây chặn đúng chuyện đó: đánh dấu "đã duyệt" / "đã khoá" / "đã trả" mà
      không có mốc thời gian nào. Sáu tháng sau không ai trả lời được "ai đồng ý con số này".
    */
    await assert.rejects(
      () => client.query(`update payroll_periods set status = 'APPROVED' where id = 'up-pp4'`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("payroll_periods_approved_check"),
      "0097: duyệt mà không có mốc duyệt bị chặn",
    );
    await client.query(`update payroll_periods set status = 'APPROVED', approved_at = now() where id = 'up-pp4'`);
    await assert.rejects(
      () => client.query(`update payroll_periods set status = 'LOCKED' where id = 'up-pp4'`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("payroll_periods_locked_check"),
      "0097: khoá mà không có mốc khoá bị chặn",
    );
    await client.query(`update payroll_periods set status = 'LOCKED', locked_at = now() where id = 'up-pp4'`);
    await assert.rejects(
      () => client.query(`update payroll_periods set status = 'PAID' where id = 'up-pp4'`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("payroll_periods_paid_check"),
      "0097: đánh dấu đã trả mà không có mốc trả bị chặn",
    );
    await assert.rejects(
      () => client.query(`update payroll_periods set status = 'XONG' where id = 'up-pp4'`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("payroll_periods_status_check"),
      "0097: trạng thái lạ bị chặn — danh sách ĐÓNG",
    );

    /*
      ═══ 0098 · ĐẦU VÀO NHẬP TAY: ĐƠN VỊ · TRẠNG THÁI · NGƯỜI DUYỆT ═══

      Điều quan trọng nhất ở đây cũng là điều migration KHÔNG làm: nó KHÔNG backfill đơn vị cho
      những dòng đã nhập. Đoán đơn vị của một con số người khác đã gõ là đoán ý họ — và nếu đoán
      sai thì phép nhân ra một số tiền sai mà trông hoàn toàn bình thường. Dòng cũ để đơn vị RỖNG,
      màn hình in "—", ai cần thì nhập lại.
    */
    await client.query(
      `insert into payroll_inputs (id, employee_id, period_key, input_key, value, evidence) values ('up-pi3', 'mkt-1', '2026-09-01..2026-09-30', 'WORK_DAYS', 24, 'bảng công T9')`,
    );
    assert.equal(await dem("select count(*)::int as n from payroll_inputs where id = 'up-pi3' and status = 'ENTERED'"), 1, "0098: dòng mới mặc định CHỜ DUYỆT — không tự coi một con số vừa gõ là đã có người soát");
    assert.equal(await dem("select count(*)::int as n from payroll_inputs where id = 'up-pi3' and unit = ''"), 1, "0098: KHÔNG backfill đơn vị — đoán đơn vị của một con số đã nhập là đoán ý người nhập");

    await assert.rejects(
      () => client.query(`update payroll_inputs set status = 'APPROVED' where id = 'up-pi3'`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("payroll_inputs_approved_check"),
      "0098: đánh dấu đã duyệt mà không có mốc duyệt bị chặn — một chữ ký không có ngày là một chữ ký trống",
    );
    await assert.rejects(
      () => client.query(`update payroll_inputs set status = 'DA_XEM' where id = 'up-pi3'`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("payroll_inputs_status_check"),
      "0098: trạng thái lạ bị chặn — danh sách ĐÓNG",
    );
    await client.query(`update payroll_inputs set status = 'APPROVED', approved_at = now(), approved_by_name = 'Chị Lan' where id = 'up-pi3'`);
    assert.equal(await dem("select count(*)::int as n from payroll_inputs where id = 'up-pi3' and status = 'APPROVED' and approved_at is not null"), 1, "0098: duyệt kèm mốc thời gian thì ghi được");

    /*
      ═══ 0080 NAY NẰM TRONG TRẠNG THÁI PRODUCTION (bước 1) ═══

      Giữ lại phần kiểm ràng buộc của nó: chúng là ranh giới giữa "đã đối chiếu" và "đã đổi dữ
      liệu", và một ngày nào đó có người sửa bảng ấy thì bài này phải đỏ — dù migration sinh ra
      chúng đã cũ.
    */
    assert.equal(await dem("select count(*)::int as n from information_schema.tables where table_name = 'hmt_return_reconciliation'"), 1, "0080: bảng chứng cứ phải được tạo");
    assert.equal(await dem("select count(*)::int as n from hmt_return_reconciliation"), 0, "0080: KHÔNG gieo sẵn dòng nào — đối soát là một lượt chạy tay, không phải một backfill");

    /*
      ═══ 0083: KẾT LUẬN CỦA NGƯỜI TRÊN MỘT DÒNG KHÔNG KHỚP ═══

      Ràng buộc quan trọng nhất: dòng ĐÃ GHI (`written`) là chứng cứ nhận hàng của 672 kiện — không
      gắn kết luận của người lên nó được. Muốn sửa thì đi đường huỷ nhận, để lại dấu vết.
    */
    assert.equal(await dem("select count(*)::int as n from information_schema.columns where table_name = 'hmt_return_reconciliation' and column_name = 'resolution'"), 1, "0083: cột resolution phải được thêm");
    await client.query(`insert into shipments (id, tracking_code, stage) values ('up-s6', 'UPS6', 'RETURNED')`);
    await client.query(`insert into hmt_return_reconciliation (id, workbook, sheet, sheet_role, tracking_key, match_status, idempotency_key, shipment_id, written) values ('up-h9', 'wb', 's', 'FULL_RETURN_ITEMS', 'UPS6', 'MATCHED', 'k9', 'up-s6', true)`);
    await assert.rejects(
      () => client.query(`update hmt_return_reconciliation set resolution = 'DISMISSED', resolved_by = 'Kho', resolution_note = 'sửa cho đúng', resolved_at = now() where id = 'up-h9'`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("hmt_return_rec_resolution_written_check"),
      "0083: dòng đã ghi là bằng chứng — không viết đè kết luận của người lên nó",
    );
    // Gỡ rồi thì phải biết AI gỡ, LÚC NÀO, và VÌ SAO — ba vế, không thiếu vế nào.
    await client.query(`insert into hmt_return_reconciliation (id, workbook, sheet, sheet_role, tracking_key, match_status, idempotency_key) values ('up-h10', 'wb', 's', 'FULL_RETURN_ITEMS', 'UPS7X', 'SKU_MISMATCH', 'k10')`);
    await assert.rejects(
      () => client.query(`update hmt_return_reconciliation set resolution = 'DISMISSED' where id = 'up-h10'`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("hmt_return_rec_resolution_actor_check"),
      "0083: gỡ mà không ghi người/mốc/lý do phải bị chặn",
    );


    /*
      ═══ 0086: QUY KẾT FANPAGE → MARKETER — BA BẢNG MỚI, KHÔNG ĐỤNG MỘT DÒNG NGHIỆP VỤ NÀO ═══

      Ba điều phải đúng, và mỗi điều chặn một cách hỏng khác nhau:
        1. ba bảng có mặt;
        2. đơn ĐANG CÓ trên production (`up-o1`) KHÔNG được tự mọc ra một dòng quy kết — migration
           không backfill, không đặt mặc định (AGENTS.md mục 35). Quy kết là kết quả của một lượt
           đối soát có người bấm, không phải một lời khẳng định do lược đồ sinh ra;
        3. ràng buộc chặn được đúng thứ nguy hiểm nhất: một dòng "trùng đơn" mang tên một người —
           nếu lọt thì doanh thu bị đếm hai lần trong khi báo cáo trông vẫn hoàn toàn bình thường.
    */
    /*
      ═══ 0090: FANPAGE LỊCH SỬ QUẢN LÝ ĐƯỢC KHI API KHÔNG CÒN ĐỌC ĐƯỢC TÊN ═══

      Hai cột CHỈ CỘNG THÊM. Ba điều phải đúng:
        1. `alias` mặc định RỖNG và `last_seen_in_api_at` mặc định NULL — migration KHÔNG đoán hộ
           tên page nào, cũng không khẳng định page nào còn quyền (AGENTS.md mục 35);
        2. page ĐANG CÓ không bị đụng tới;
        3. `alias` tách hẳn `name`: ghi cái này không đổi cái kia.
    */
    assert.equal(await dem("select count(*)::int as n from information_schema.columns where table_name = 'fanpages' and column_name = 'alias'"), 1, "0090: cột alias phải được thêm");
    assert.equal(await dem("select count(*)::int as n from information_schema.columns where table_name = 'fanpages' and column_name = 'last_seen_in_api_at'"), 1, "0090: cột last_seen_in_api_at phải được thêm");
    await client.query(`insert into fanpages (id, external_page_id, name) values ('up-fp89', 'PAGE-UP-89', 'Tên từ API')`);
    assert.equal(await dem("select count(*)::int as n from fanpages where id = 'up-fp89' and alias = '' and last_seen_in_api_at is null"), 1, "0090: page mới mặc định KHÔNG có alias và CHƯA từng thấy trong API — không đoán hộ");
    await client.query(`update fanpages set alias = 'Tên người đặt' where id = 'up-fp89'`);
    assert.equal(
      await dem("select count(*)::int as n from fanpages where id = 'up-fp89' and alias = 'Tên người đặt' and name = 'Tên từ API' and external_page_id = 'PAGE-UP-89'"),
      1,
      "0090: đặt alias KHÔNG được đụng tới tên API lẫn page_id — page_id là danh tính mà mọi đơn đã quy kết trỏ tới",
    );
    await client.query(`delete from fanpages where id = 'up-fp89'`);

    /*
      ═══ 0091: QUY KẾT ĐƠN LANDING BẰNG TRACKING QUẢNG CÁO ═══

      Chỉ CỘNG THÊM: hai cột trên `order_attributions` và một bảng bằng chứng. Bốn điều phải đúng:
        1. đơn đã quy kết TRƯỚC bản này mặc nhiên mang nguồn `PANCAKE_PAGE` — migration KHÔNG
           backfill, không đoán hộ đơn nào đi đường landing (AGENTS.md mục 35);
        2. "fanpage suy ra" chỉ được đặt trên đơn đi đường landing — đặt nhầm lên một đơn Messenger
           là biến một suy luận thành một chứng từ;
        3. kết luận phải đi cùng căn cứ: có người thì phải có bậc bằng chứng VÀ câu giải thích;
        4. một đơn MỘT dòng bằng chứng — đó là thứ làm phép đối soát idempotent.
    */
    assert.equal(await dem("select count(*)::int as n from information_schema.tables where table_name = 'landing_attributions'"), 1, "0091: bảng landing_attributions phải được tạo");
    assert.equal(await dem("select count(*)::int as n from information_schema.columns where table_name = 'order_attributions' and column_name = 'attribution_source'"), 1, "0091: cột attribution_source phải được thêm");
    assert.equal(await dem("select count(*)::int as n from landing_attributions"), 0, "0091: KHÔNG gieo sẵn dòng bằng chứng nào — không backfill im lặng");

    await client.query(`insert into fanpages (id, external_page_id, name) values ('up-fp91', 'PAGE-UP-91', 'Page 91')`);
    await client.query(`insert into fanpage_marketer_assignments (id, fanpage_id, marketer_id, effective_from) values ('up-fa91', 'up-fp91', 'mkt-91', now() - interval '30 days')`);
    await client.query(`insert into order_attributions (id, order_id, source_page_id, fanpage_id, marketer_id, assignment_id, status, source_order_at, rule_version) values ('up-oa91', 'up-o1', 'PAGE-UP-91', 'up-fp91', 'mkt-91', 'up-fa91', 'ATTRIBUTED', now(), 1)`);
    assert.equal(
      await dem("select count(*)::int as n from order_attributions where id = 'up-oa91' and attribution_source = 'PANCAKE_PAGE' and attributed_page_id is null"),
      1,
      "0091: dòng quy kết cũ mặc nhiên là đường Pancake — migration không đoán hộ đơn nào đi đường landing",
    );
    await assert.rejects(
      () => client.query(`update order_attributions set attributed_page_id = 'PAGE-UP-91' where id = 'up-oa91'`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("order_attribution_inferred_page_check"),
      "0091: 'fanpage suy ra' KHÔNG được đặt trên đơn đi đường Pancake — hai ô ấy nói hai loại sự thật khác nhau",
    );
    await assert.rejects(
      () => client.query(`update order_attributions set attribution_source = 'DOAN_BUA' where id = 'up-oa91'`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("order_attribution_source_check"),
      "0091: nguồn quy kết là DANH SÁCH ĐÓNG",
    );

    await assert.rejects(
      () => client.query(`insert into landing_attributions (id, order_id, tier, marketer_id) values ('up-la-x', 'up-o1', 'CAMPAIGN_NAME', 'mkt-91')`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("landing_attribution_evidence_check"),
      "0091: quy kết mà KHÔNG có câu căn cứ phải bị chặn — sáu tháng sau không ai kiểm chứng nổi một dòng như thế",
    );
    await assert.rejects(
      () => client.query(`insert into landing_attributions (id, order_id, tier) values ('up-la-y', 'up-o1', 'CAMPAIGN_NAME')`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("landing_attribution_evidence_check"),
      "0091: chưa có người thì PHẢI nói được vì sao — không dòng nào được vừa trống người vừa trống lý do",
    );
    await client.query(`insert into landing_attributions (id, order_id, tier, marketer_id, ad_account_id, campaign_id, evidence) values ('up-la1', 'up-o1', 'CAMPAIGN_NAME', 'mkt-91', 'act-1', 'camp-1', 'tên chiến dịch khớp tuyệt đối')`);
    await assert.rejects(
      () => client.query(`insert into landing_attributions (id, order_id, gap) values ('up-la2', 'up-o1', 'NO_MATCH')`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("landing_attribution_order_uq"),
      "0091: MỘT đơn MỘT dòng — đó là thứ làm phép đối soát idempotent, không có đường nào cộng doanh thu hai lần",
    );
    /*
      ═══ 0092: SỔ NHÓM QUẢNG CÁO — MẮT XÍCH ADSET → CHIẾN DỊCH ═══

      Chỉ CỘNG THÊM một bảng tra. Không đụng `fb_ads`, `ad_spends`, chi tiêu hay thanh toán —
      những thứ mà một lỗi ở đây sẽ biến thành tiền sai.
    */
    assert.equal(await dem("select count(*)::int as n from information_schema.tables where table_name = 'fb_adsets'"), 1, "0092: bảng fb_adsets phải được tạo");
    assert.equal(await dem("select count(*)::int as n from fb_adsets"), 0, "0092: KHÔNG gieo sẵn dòng nào — chưa hỏi Meta thì chưa biết gì");
    await client.query(`insert into fb_adsets (id, name, campaign_id, account_id, status) values ('120248121229960618', 'Nhóm QC', '120248121229780618', '968797992379957', 'PAUSED')`);
    assert.equal(
      await dem("select count(*)::int as n from fb_adsets where id = '120248121229960618' and campaign_id = '120248121229780618' and missing = false"),
      1,
      "0092: nhóm đã TẮT vẫn phải lưu được — Meta vẫn trả metadata cho PAUSED, và 29 đơn treo đều thuộc nhóm đã tắt",
    );
    await client.query(`delete from fb_adsets where id = '120248121229960618'`);

    /*
      ═══ 0093: LÝ DO TREO — DANH SÁCH Ở CSDL ĐI CÙNG DANH SÁCH Ở MÃ NGUỒN ═══

      0091 chốt cứng bốn lý do; mã nguồn sau đó mở rộng mà ràng buộc thì không, nên lượt đối soát
      trên production hỏng NGUYÊN LƯỢT GHI. Bài này kiểm cả hai chiều: lý do MỚI phải vào được, và
      chuỗi bịa vẫn phải bị chặn — nới ràng buộc không được biến nó thành ô gõ tự do.
    */
    // Dùng ĐƠN KHÁC: khối 0091 ở trên đã dựng/dọn dòng cho `up-o1`, và khoá "một đơn một dòng"
    // là thứ không được nới — nên bài này mượn một đơn riêng thay vì nới khoá.
    await client.query(`insert into orders (id, stage, inserted_at, total_price_after_discount) values ('up-o93', 'CONFIRMED', now(), 100000) on conflict (id) do nothing`);
    await client.query(`insert into landing_attributions (id, order_id, gap) values ('up-la93', 'up-o93', 'META_ADSET_NOT_SYNCED')`);
    await client.query(`update landing_attributions set gap = 'CAMPAIGN_NOT_SYNCED' where id = 'up-la93'`);
    await client.query(`update landing_attributions set gap = 'NO_AD_SOURCE' where id = 'up-la93'`);
    await assert.rejects(
      () => client.query(`update landing_attributions set gap = 'LY_DO_BIA' where id = 'up-la93'`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("landing_attribution_gap_check"),
      "0093: nới danh sách KHÔNG được biến nó thành ô gõ tự do",
    );
    await client.query(`update landing_attributions set gap = null, tier = 'CAMPAIGN_ID', marketer_id = 'mkt-93', evidence = 'thử' where id = 'up-la93'`);
    await assert.rejects(
      () => client.query(`update landing_attributions set tier = 'BAC_BIA' where id = 'up-la93'`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("landing_attribution_tier_check"),
      "0093: bậc bằng chứng cũng là danh sách ĐÓNG",
    );
    await client.query(`delete from landing_attributions where id = 'up-la93'`);
    await client.query(`delete from orders where id = 'up-o93'`);

    /*
      ═══ 0095: HÀNG HOÀN KHÔNG CÓ MÃ VẬN ĐƠN — GIỮ TẠM, KHÔNG PHẢI TỒN KHO ═══

      Bảng này là chỗ DUY NHẤT trong ERP có thể đưa hàng vào tồn mà không có chứng từ đơn nào. Nên
      những gì nó chặn phải chặn được Ở CSDL, không chỉ ở tầng dịch vụ: một lượt ghi bằng ops
      `db-query` hay một đoạn mã tương lai đều đi qua đúng những ràng buộc này.

      Bốn điều, mỗi điều chặn một cách làm hỏng sổ tồn:
        1. bảng chỉ CỘNG THÊM — không đụng `stock_receipts` hay một dòng nghiệp vụ nào;
        2. "đã vào tồn" phải đủ người + mốc + CĂN CỨ + mẫu mã;
        3. căn cứ `IDENTIFIED` không đứng được khi chưa nối đơn (nếu không, lượt tái nhập không
           chứng từ đội lốt lượt có chứng từ và biến mất khỏi mọi báo cáo);
        4. một phiếu kho chỉ phục vụ MỘT món giữ tạm.
    */
    assert.equal(await dem("select count(*)::int as n from information_schema.tables where table_name = 'return_unidentified'"), 1, "0095: bảng return_unidentified phải được tạo");
    assert.equal(await dem("select count(*)::int as n from return_unidentified"), 0, "0095: KHÔNG gieo sẵn dòng nào — kiện mất nhãn chỉ sinh ra khi có người ghi nhận");

    await client.query(`insert into return_unidentified (id, code, received_at, quantity, condition) values ('up-ur1', 'UR-20260915-00001', now(), 1, 'OK')`);
    await assert.rejects(
      () => client.query(`insert into return_unidentified (id, code, received_at, quantity, condition) values ('up-ur2', 'UR-20260915-00001', now(), 1, 'OK')`),
      () => true,
      "0095: mã nội bộ phải DUY NHẤT — hai kiện cùng một nhãn viết tay là hai kiện không phân biệt được",
    );
    await assert.rejects(
      () => client.query(`insert into return_unidentified (id, code, received_at, quantity, condition) values ('up-ur3', 'UR-20260915-00003', now(), 0, 'OK')`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("return_unidentified_qty_check"),
      "0095: số lượng 0 là một dòng rác vĩnh viễn",
    );
    await assert.rejects(
      () => client.query(`update return_unidentified set status = 'IDENTIFIED' where id = 'up-ur1'`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("return_unidentified_identified_check"),
      "0095: “đã xác định đơn” mà không chỉ được đích danh vận đơn/đơn nào là một lời khẳng định không kiểm chứng được",
    );
    await client.query(`insert into stock_receipts (id, kind, received_at, reference) values ('up-sr94', 'RETURN', now(), 'UR-20260915-00001')`);
    await assert.rejects(
      () => client.query(`update return_unidentified set stock_receipt_id = 'up-sr94' where id = 'up-ur1'`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("return_unidentified_restock_check"),
      "0095: “đã vào tồn” phải đủ ai · lúc nào · căn cứ · mẫu mã",
    );
    await assert.rejects(
      () => client.query(`update return_unidentified set stock_receipt_id = 'up-sr94', restocked_at = now(), restocked_by = 'Kho', restock_authority = 'IDENTIFIED', variant_id = null where id = 'up-ur1'`),
      () => true,
      "0095: căn cứ IDENTIFIED không đứng được khi dòng chưa nối được đơn",
    );
    await assert.rejects(
      () => client.query(`update return_unidentified set stock_receipt_id = 'up-sr94', restocked_at = now(), restocked_by = 'Kho', restock_authority = 'MANAGER_OVERRIDE', restock_reason = '' where id = 'up-ur1'`),
      () => true,
      "0095: vào tồn không có chứng từ đơn thì BẮT BUỘC có lý do viết ra được",
    );
    await client.query(`delete from stock_receipts where id = 'up-sr94'`);
    await client.query(`delete from return_unidentified where id = 'up-ur1'`);
    assert.equal(await dem("select count(*)::int as n from orders where id = 'up-o1'"), 1, "0095: bảng mới KHÔNG đụng tới một dòng nghiệp vụ nào");

    await client.query(`delete from landing_attributions where order_id = 'up-o1'`);
    await client.query(`delete from order_attributions where id = 'up-oa91'`);
    await client.query(`delete from fanpage_marketer_assignments where id = 'up-fa91'`);
    await client.query(`delete from fanpages where id = 'up-fp91'`);

    for (const bang of ["fanpages", "fanpage_marketer_assignments", "order_attributions"]) {
      assert.equal(await dem(`select count(*)::int as n from information_schema.tables where table_name = '${bang}'`), 1, `0086: bảng ${bang} phải được tạo`);
    }
    assert.equal(await dem("select count(*)::int as n from order_attributions"), 0, "0086: KHÔNG gieo sẵn dòng quy kết nào — đơn cũ vẫn chưa quy kết, và đó là sự thật đúng");
    assert.equal(await dem("select count(*)::int as n from orders where id = 'up-o1'"), 1, "0086: đơn đang có trên production không bị đụng tới");
    await client.query(`insert into fanpages (id, external_page_id, name) values ('up-fp1', 'PAGE-UP-1', 'Page thử')`);
    await client.query(`insert into fanpage_marketer_assignments (id, fanpage_id, marketer_id, effective_from) values ('up-fa1', 'up-fp1', 'mkt-1', now() - interval '30 days')`);
    // Một fanpage chỉ có MỘT khoảng đang mở — chặn ở CSDL vì hai lượt ghi song song cùng lọt qua
    // phép kiểm ở tầng ứng dụng là ca duy nhất mà tầng ứng dụng không chặn được.
    await assert.rejects(
      () => client.query(`insert into fanpage_marketer_assignments (id, fanpage_id, marketer_id, effective_from) values ('up-fa2', 'up-fp1', 'mkt-2', now())`),
      () => true,
      "0086: hai phân công cùng mở trên một fanpage phải bị chặn",
    );
    await assert.rejects(
      () => client.query(`insert into order_attributions (id, order_id, status, marketer_id, duplicate_of_order_id, source_order_at) values ('up-oa1', 'up-o1', 'DUPLICATE', 'mkt-1', 'up-o1', now())`),
      () => true,
      "0086: một dòng trùng đơn KHÔNG được mang tên một người",
    );
    await client.query(`insert into order_attributions (id, order_id, status, source_page_id, source_order_at) values ('up-oa2', 'up-o1', 'NO_ASSIGNMENT', 'PAGE-UP-1', now())`);
    await assert.rejects(
      () => client.query(`insert into order_attributions (id, order_id, status, source_order_at) values ('up-oa3', 'up-o1', 'NO_PAGE', now())`),
      () => true,
      "0086: mỗi đơn ĐÚNG MỘT dòng quy kết — khoá duy nhất là thứ chặn cộng đúp ở gốc",
    );
    await client.query(`delete from order_attributions where id = 'up-oa2'`);

    await client.query(`insert into shipments (id, tracking_code, stage) values ('up-s7', 'UPS7', 'RETURNED')`);
    await client.query(`insert into hmt_return_reconciliation (id, workbook, sheet, sheet_role, tracking_key, match_status, idempotency_key, shipment_id, written) values ('up-h1', 'wb', 'Chi tiết đơn hoàn', 'FULL_RETURN_ITEMS', 'UPS7', 'MATCHED', 'wb|FULL|UPS7|x|#1', 'up-s7', true)`);

    // Khoá chống trùng: chạy lại lượt đối soát KHÔNG được sinh thêm dòng nào.
    await assert.rejects(
      () => client.query(`insert into hmt_return_reconciliation (id, workbook, sheet, sheet_role, tracking_key, match_status, idempotency_key) values ('up-h2', 'wb', 'Chi tiết đơn hoàn', 'FULL_RETURN_ITEMS', 'UPS7', 'MATCHED', 'wb|FULL|UPS7|x|#1')`),
      (e: unknown) => /idempotency|unique|duplicate/i.test(String((e as { message?: string })?.message ?? e)),
      "0080: cùng một dòng nguồn ghi lần hai phải bị chặn — nếu không, chạy lại là nhân đôi chứng cứ",
    );
    // Trạng thái lạ bị chặn: danh sách PHẢI khớp `HMT_MATCH_STATUSES` ở mã nguồn.
    await assert.rejects(
      () => client.query(`insert into hmt_return_reconciliation (id, workbook, sheet, sheet_role, match_status, idempotency_key) values ('up-h3', 'wb', 's', 'FULL_RETURN_ITEMS', 'GAN_KHOP', 'k3')`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("hmt_return_rec_status_check"),
      "0080: 'gần khớp' không tồn tại — một dòng hoặc khớp đủ hai định danh hoặc không",
    );
    /*
      RÀNG BUỘC QUAN TRỌNG NHẤT CỦA 0080: chỉ dòng KHỚP mới được đánh dấu đã ghi.

      Chặn ở CSDL chứ không tin vào kỷ luật của mã nguồn — đây là ranh giới giữa "đã đối chiếu" và
      "đã đổi dữ liệu", và một dòng `written = true` mang trạng thái khác là một lượt ghi không ai
      giải thích được.
    */
    await assert.rejects(
      () => client.query(`insert into hmt_return_reconciliation (id, workbook, sheet, sheet_role, match_status, idempotency_key, written) values ('up-h4', 'wb', 's', 'FULL_RETURN_ITEMS', 'AMBIGUOUS_SKU', 'k4', true)`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("hmt_return_rec_written_check"),
      "0080: dòng KHÔNG khớp mà đánh dấu đã ghi là một lượt ghi không có căn cứ",
    );
    // Ô mã vận đơn trống mà khai một cách kế thừa không tồn tại thì bị chặn: ba giá trị, danh sách đóng.
    await assert.rejects(
      () => client.query(`insert into hmt_return_reconciliation (id, workbook, sheet, sheet_role, match_status, idempotency_key, inheritance) values ('up-h5', 'wb', 's', 'FULL_RETURN_ITEMS', 'MATCHED', 'k5', 'DOAN_TU_DONG_TREN')`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("hmt_return_rec_inheritance_check"),
      "0080: 'đoán từ dòng trên' không phải một cách kế thừa hợp lệ",
    );
    // Xoá kiện thì chứng cứ đi theo; nhưng chứng cứ KHÔNG giữ kiện lại.
    await client.query(`delete from shipments where id = 'up-s7'`);
    assert.equal(await dem("select count(*)::int as n from hmt_return_reconciliation where id = 'up-h1'"), 0, "0080: xoá kiện thì dòng chứng cứ của nó đi theo, không để lại dòng mồ côi");

    // Kiện đã có đợt đóng nay mở được đợt mới — điều mà cờ sai đã chặn ở chỉ mục duy nhất từng phần.
    await client.query(`insert into shipment_care (id, shipment_id, care_status, care_outcome, episode_no) values ('up-care-3', 'up-s9', 'NEW', 'PENDING', 2)`);

    /*
      TÁM phòng ban mặc định phải có mặt, nếu không hàng đợi mở lên lần đầu sẽ rỗng.

      0110 thêm phòng Sản xuất và đổi `sort_order` để hai phòng đầu phễu đứng cạnh nhau. Bài kiểm so
      với `DEPARTMENT_ORDER` chứ không gõ lại danh sách: gõ lại là mở đường cho CSDL và mã nguồn nói
      hai thứ tự khác nhau, và không màn hình nào báo.
    */
    const phong = await client.query<{ code: string }>("select code from departments order by sort_order");
    assert.deepEqual(
      phong.rows.map((r) => r.code),
      DEPARTMENT_ORDER,
      "tám phòng ban phải có mặt và đúng thứ tự của mã nguồn — bước 1 vừa đặt cả bảng về 100 (đúng production), nên khẳng định này CHỈ xanh khi hàng rào của 0114 nhận ra 'chưa ai đặt thứ tự' và sắp lại",
    );

    /*
      ═══ VÀ VẾ NGƯỢC LẠI: SHOP ĐÃ TỰ SẮP THÌ MIGRATION KHÔNG ĐƯỢC ĐỤNG VÀO ═══

      Một hàng rào chỉ được kiểm ở vế "có chạy" là một hàng rào chưa ai biết nó CHẶN được gì. Ở đây
      chạy lại CHÍNH TỆP SQL của 0114 (đọc từ đĩa, không chép luật sang TypeScript) trên một bảng đã
      có thứ tự do người đặt — nó phải là no-op tuyệt đối.

      Drizzle sẽ không bao giờ tự chạy lại 0114 vì nó đã vào sổ, nên đây là cách duy nhất kiểm được
      nhánh ấy; và nó cũng chính là phép kiểm tính idempotent thật của câu lệnh.
    */
    await client.query(`update departments set sort_order = case code when 'HR' then 5 when 'SALES' then 7 else 99 end`);
    const sqlSapXep = readFileSync(path.join(goc, "0114_department_sort_order.sql"), "utf8");
    await client.query(sqlSapXep);
    const tuSap = await client.query<{ code: string; sort_order: number }>("select code, sort_order from departments order by sort_order, code");
    assert.deepEqual(
      tuSap.rows.map((r) => `${r.code}:${r.sort_order}`),
      ["HR:5", "SALES:7", "FINANCE:99", "LOGISTICS:99", "MANAGEMENT:99", "MARKETING:99", "PRODUCTION:99", "WAREHOUSE:99"],
      "thứ tự do NGƯỜI đặt phải còn nguyên — migration sắp xếp chỉ được chạy khi cả bảng còn ở đúng một giá trị mặc định",
    );
    // Trả lại thứ tự chuẩn cho các khẳng định sau của bài kiểm.
    await client.query(`update departments set sort_order = 100`);
    await client.query(sqlSapXep);

    // CHỈ CỘNG THÊM: dữ liệu nghiệp vụ có từ trước phải nguyên vẹn.
    assert.equal(await dem("select count(*)::int as n from cs_cases where id = 'up-c1' and status = 'OPEN'"), 1, "case CSKH có từ trước không được đụng tới");
    assert.equal(await dem("select count(*)::int as n from orders where id = 'up-o1'"), 1, "đơn có từ trước không được đụng tới");
    assert.equal(await dem("select count(*)::int as n from work_items"), 0, "migration KHÔNG được chép việc sẵn có vào work_items — hàng đợi là PHÉP CHIẾU, không phải bản sao");

    /*
      RÀNG BUỘC QUAN TRỌNG NHẤT CỦA BẢN NÀY, kiểm ở mức CSDL chứ không tin vào kỷ luật:
      dòng CHIẾU không được giữ trạng thái, và việc TAY bắt buộc phải giữ.
    */
    const deptId = (await client.query<{ id: string }>("select id from departments where code = 'SALES'")).rows[0].id;
    await client.query(`insert into work_items (id, source_type, source_key, authority, department_id) values ('up-w1', 'CS_CASE', 'up-c1', 'SOURCE', '${deptId}')`);
    await assert.rejects(
      () => client.query(`update work_items set status = 'DONE' where id = 'up-w1'`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("work_items_authority_check"),
      "dòng CHIẾU mà ghi được trạng thái nghĩa là hai nơi cùng giữ một sự thật — ràng buộc phải chặn",
    );
    await assert.rejects(
      () => client.query(`insert into work_items (id, source_type, source_key, authority, title) values ('up-w2', 'MANUAL_TASK', 'up-w2', 'WORK', 'Việc tay không trạng thái')`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("work_items_authority_check"),
      "việc TAY mà thiếu trạng thái thì không nơi nào giữ trạng thái của nó — ràng buộc phải chặn",
    );
    await assert.rejects(
      () => client.query(`insert into work_items (id, source_type, source_key, authority, status, title, blocked_reason) values ('up-w3', 'MANUAL_TASK', 'up-w3', 'WORK', 'BLOCKED', 'Bị chặn', '')`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("work_items_blocked_reason_check"),
      "chặn mà không nói vì sao là xoá bằng chứng lặng lẽ — ràng buộc phải chặn",
    );

    /*
      ═══ NHÓM LÝ DO HOÀN (0074) ═══

      Điều kiện tiên quyết không đổi qua mọi migration: tài khoản có TRƯỚC bản này không mất gì.
    */
    const cu1 = (await client.query<{ data_scope: string }>("select data_scope from users where id = 'up-u1'")).rows[0];
    assert.equal(cu1.data_scope, "ALL", "tài khoản có từ trước phải giữ phạm vi ALL qua mọi migration sau đó");

    /*
      KHÔNG BACKFILL, KHÔNG MẶC ĐỊNH.

      Case có TRƯỚC bản này phải ở `NULL` — không phải `''`, không phải một khoá đoán ra từ tên.
      Đây là ràng buộc quan trọng nhất của migration này: một backfill "hợp lý" sẽ biến một lỗ
      hổng dữ liệu thành một lời khẳng định sai về việc ai đã làm việc gì, và sau đó không ai
      phân biệt được nữa.
    */
    const sauNang = (await client.query<{ assignee_user_id: string | null }>("select assignee_user_id from cs_cases where id = 'up-c1'")).rows[0];
    assert.equal(sauNang.assignee_user_id, null, "migration KHÔNG được đoán người phụ trách cho case cũ");

    /*
      Bảng đích KHÔNG có dòng nào do migration sinh ra: ERP không đặt sẵn đích cho ai. Trừ đúng
      những dòng chính bài này gieo ở bước 1 (`up-mt…`) — chúng đóng vai "dữ liệu đang có trên
      production", giống `up-o1` / `up-c1` phía trên.
    */
    assert.equal(await dem("select count(*)::int as n from metric_targets where id not like 'up-mt%'"), 0, "migration không được đặt sẵn đích — đích là quyết định kinh doanh của chủ shop");

    /*
      ═══ 0084: ĐÍCH CHỈ SỐ CÓ THÊM TẦNG MÃ HÀNG ═══

      Ba điều phải đúng sau khi nới ràng buộc:

       1. Tầng `PRODUCT` GHI ĐƯỢC — trước bước 2 thì không (đã kiểm ở bước 1).
       2. Danh sách vẫn ĐÓNG: một chuỗi lạ vẫn bị chặn. Nới không có nghĩa là mở ô gõ tự do —
          một `scope` lạ buộc `resolveTarget` phải chọn giữa bỏ sót đích và áp nhầm đích.
       3. Đích đã đặt TRƯỚC bản này không suy suyển. Migration chỉ nới ràng buộc, không `UPDATE`
          một dòng nào; nếu một ngày ai đó thêm phần backfill vào đây thì bài này đỏ.
    */
    await client.query(`insert into metric_targets (id, metric_key, scope, scope_ref, target, note, effective_from, set_by_email) values ('up-mt2', 'delivery_success_rate', 'PRODUCT', 'Q004', 55, 'mã mới ra mắt, chấp nhận thấp hơn', now(), 'a@shop.vn')`);
    assert.equal(await dem("select count(*)::int as n from metric_targets where scope = 'PRODUCT' and scope_ref = 'Q004'"), 1, "0084: đích riêng cho một mã hàng phải ghi được");
    await assert.rejects(
      () => client.query(`insert into metric_targets (id, metric_key, scope, scope_ref, target, note, effective_from, set_by_email) values ('up-mt3', 'delivery_success_rate', 'SKU', 'Q004-DEN-2XL', 55, 'phạm vi bịa', now(), 'a@shop.vn')`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("metric_targets_scope_check"),
      "0084: danh sách phạm vi vẫn ĐÓNG — nới thêm một giá trị không phải mở ô gõ tự do",
    );
    assert.equal(await dem("select count(*)::int as n from metric_targets where id = 'up-mt1' and target = 65 and scope = 'COMPANY' and scope_ref is null"), 1, "0084: đích đặt TRƯỚC bản này giữ nguyên tầng và con số — migration KHÔNG backfill");

    /*
      ═══ 0077: ĐÍCH CÓ KỲ, CÓ DẢI, CÓ HẠN — VÀ VẪN KHÔNG CÓ ĐÍCH NÀO ═══

      Bảng rỗng trên production (0 dòng, đo 13/09/2026), nên các cột thêm vào có mặc định mà không
      phải đoán gì về dữ liệu cũ. `period_kind = 'ANY'` nghĩa là CHƯA KHAI KỲ, không phải "mỗi
      tháng": một đích 500 đơn mà máy tự gán cho một tháng sẽ chấm sai gấp bốn khi người ta xem
      theo tuần, và màn hình trông hoàn toàn bình thường.
    */
    for (const cot of ["target_max", "warning_at", "critical_at", "period_kind", "effective_to", "version", "owner_department"]) {
      assert.equal(await dem(`select count(*)::int as n from information_schema.columns where table_name = 'metric_targets' and column_name = '${cot}'`), 1, `0077: thiếu cột ${cot}`);
    }

    await client.query(`insert into metric_targets (id, metric_key, scope, scope_ref, target, note, effective_from, set_by_email) values ('up-t1', 'care_sla', 'USER', 'up-u1', 85, 'thử', now(), 'a@shop.vn')`);
    const t1 = (await client.query<{ period_kind: string; version: number; target_max: number | null }>("select period_kind, version, target_max from metric_targets where id = 'up-t1'")).rows[0];
    assert.equal(t1.period_kind, "ANY", "0077: mặc định là CHƯA KHAI KỲ, không phải một kỳ do máy chọn hộ");
    assert.equal(t1.version, 1, "0077: đích mới là phiên bản 1");
    assert.equal(t1.target_max, null, "0077: không có cận trên ⇒ đích một chiều, không phải dải");

    /*
      Phạm vi CÁ NHÂN nay hợp lệ ở mức CSDL — nhưng vẫn là DANH SÁCH ĐÓNG, không phải ô gõ tự do.
      Ví dụ ở đây từng là `PRODUCT`; 0083 đã nới ràng buộc để nhận nó, nên bài kiểm đổi sang một
      giá trị NGHE RẤT HỢP LÝ mà vẫn không tồn tại — đó mới là thứ danh sách đóng phải chặn.
    */
    await assert.rejects(
      () => client.query(`insert into metric_targets (id, metric_key, scope, scope_ref, target, note, effective_from, set_by_email) values ('up-t2', 'care_sla', 'TEAM', 'p1', 5, 'x', now(), 'a@shop.vn')`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("metric_targets_scope_check"),
      "0077: phạm vi lạ phải bị CSDL chặn — chuỗi tự do buộc mã nguồn chọn giữa khoá nhầm người và lộ dữ liệu",
    );
    await assert.rejects(
      () => client.query(`insert into metric_targets (id, metric_key, scope, target, note, effective_from, period_kind, set_by_email) values ('up-t3', 'care_sla', 'COMPANY', 5, 'x', now(), 'MOI_NGAY', 'a@shop.vn')`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("metric_targets_period_check"),
      "0077: hình dạng kỳ lạ phải bị chặn",
    );
    await assert.rejects(
      () => client.query(`insert into metric_targets (id, metric_key, scope, target, target_max, note, effective_from, set_by_email) values ('up-t4', 'care_sla', 'COMPANY', 50, 20, 'x', now(), 'a@shop.vn')`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("metric_targets_range_check"),
      "0077: dải có cận trên NHỎ HƠN cận dưới thì không đích nào áp được — chặn ngay ở CSDL",
    );
    await assert.rejects(
      () => client.query(`insert into metric_targets (id, metric_key, scope, target, note, effective_from, effective_to, set_by_email) values ('up-t5', 'care_sla', 'COMPANY', 50, 'x', now(), now() - interval '1 day', 'a@shop.vn')`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("metric_targets_window_check"),
      "0077: khoảng hiệu lực rỗng thì đích không bao giờ áp cho kỳ nào, và người đặt sẽ đi tìm xem vì sao",
    );
    /*
      ĐÍCH THEO TUẦN VÀ ĐÍCH THEO THÁNG PHẢI CÙNG TỒN TẠI ĐƯỢC.

      `resolveTarget` lọc theo `period_kind`, tức nó giả định hai đích khác hình dạng kỳ sống song
      song. Nếu `period_kind` không nằm trong khoá duy nhất thì dòng thứ hai bị chặn — và tệ hơn,
      lượt ghi thứ hai tra dòng cũ không theo kỳ nên nó SỬA ĐÈ đích tuần thành đích tháng. Chủ shop
      mất một đích đã đặt, không một dòng cảnh báo nào.
    */
    await client.query(`insert into metric_targets (id, metric_key, scope, target, note, effective_from, period_kind, set_by_email) values ('up-tw', 'delivered_orders', 'COMPANY', 500, 'tuần', '2026-01-01', 'WEEK', 'a@shop.vn')`);
    await client.query(`insert into metric_targets (id, metric_key, scope, target, note, effective_from, period_kind, set_by_email) values ('up-tm', 'delivered_orders', 'COMPANY', 2000, 'tháng', '2026-01-01', 'MONTH', 'a@shop.vn')`);
    assert.equal(await dem("select count(*)::int as n from metric_targets where metric_key = 'delivered_orders'"), 2, "0077: đích theo TUẦN và theo THÁNG của cùng một chỉ số phải cùng tồn tại");
    // Nhưng TRÙNG HOÀN TOÀN (cùng kỳ, cùng mốc) thì vẫn phải bị chặn — nếu không, không ai biết
    // màn hình đang chấm theo dòng nào.
    await assert.rejects(
      () => client.query(`insert into metric_targets (id, metric_key, scope, target, note, effective_from, period_kind, set_by_email) values ('up-tm2', 'delivered_orders', 'COMPANY', 2500, 'trùng', '2026-01-01', 'MONTH', 'a@shop.vn')`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("metric_targets_uq"),
      "0077: hai đích cùng chỉ số, cùng tầng, CÙNG kỳ, cùng mốc thì phải bị chặn",
    );
    await client.query(`delete from metric_targets where id in ('up-tw','up-tm')`);
    await client.query(`delete from metric_targets where id = 'up-t1'`);

    /*
      ═══ 0078: GHI CHÚ VẬN HÀNH — BẢNG MỚI, KHÔNG ĐỤNG GÌ TỚI DỮ LIỆU CŨ ═══

      Cột `products.note` (đồng bộ từ Pancake) phải còn nguyên: bản này KHÔNG chuyển nó sang bảng
      mới. Chuyển là hai cái sai cùng lúc — lần đồng bộ Pancake sau ghi đè lại cột đó, và một ghi
      chú của Pancake bỗng mang tên một người trong shop.
    */
    assert.equal(await dem("select count(*)::int as n from information_schema.tables where table_name = 'product_notes'"), 1, "0078: bảng ghi chú phải được tạo");
    assert.equal(await dem("select count(*)::int as n from product_notes"), 0, "0078: KHÔNG chuyển ghi chú Pancake sang bảng mới — cột cũ giữ nguyên vai của nó");
    await client.query(`insert into products (id, name, note) values ('up-p1', 'Đầm cũ', 'ghi chú của Pancake')`);
    const spCu = (await client.query<{ note: string }>("select note from products where id = 'up-p1'")).rows[0];
    assert.equal(spCu.note, "ghi chú của Pancake", "0078: cột note cũ không bị đụng tới");

    await assert.rejects(
      () => client.query(`insert into product_notes (id, product_id, body) values ('up-n1', 'up-p1', '   ')`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("product_notes_body_check"),
      "0078: ghi chú rỗng chiếm chỗ 'ghi chú mới nhất' và đẩy ghi chú thật xuống — chặn ở CSDL",
    );
    await assert.rejects(
      () => client.query(`insert into product_notes (id, product_id, body, category) values ('up-n2', 'up-p1', 'x y z', 'LUNG_TUNG')`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("product_notes_category_check"),
      "0078: nhóm lạ phải bị chặn — ô gõ tự do sinh ra ba cách viết cho cùng một nhóm",
    );
    /*
      Người viết bị gỡ tài khoản thì ghi chú KHÔNG biến mất — chỉ mất khoá, ảnh chụp tên còn lại.

      Dùng một tài khoản RIÊNG (`up-u9`) chứ không mượn `up-u1`: khối kiểm đích phía dưới còn cần
      `up-u1` sống để chứng minh xoá người đặt không cuốn theo đích. Xoá sớm ở đây thì bài kiểm kia
      đỏ vì khoá ngoại, và nguyên nhân thật nằm cách đó hai trăm dòng.
    */
    await client.query(`insert into users (id, email, name, password_hash, role) values ('up-u9', 'kho@shop.vn', 'An Kho', 'x', 'WAREHOUSE')`);
    await client.query(`insert into product_notes (id, product_id, body, actor_user_id, actor_name) values ('up-n3', 'up-p1', 'Lô này vải mỏng', 'up-u9', 'An Kho')`);
    await client.query(`delete from users where id = 'up-u9'`);
    const conLai = (await client.query<{ actor_user_id: string | null; actor_name: string }>("select actor_user_id, actor_name from product_notes where id = 'up-n3'")).rows[0];
    assert.equal(conLai.actor_user_id, null, "0078: gỡ tài khoản thì khoá về null");
    assert.equal(conLai.actor_name, "An Kho", "0078: nhưng ảnh chụp tên còn lại — ghi chú vẫn đọc được, chỉ là không quy kết được nữa");

    /*
      ═══ 0079: CHỨNG TỪ CỦA MỘT LƯỢT GỬI ═══

      Bốn cột NULLABLE, không mặc định — dòng cũ KHÔNG được đoán. Một dòng đã gửi từ trước mà điền
      đại `attempt_count = 1` là bịa ra một con số chưa ai đo.
    */
    for (const cot of ["provider_message_id", "accepted_at", "error_kind", "attempt_count"]) {
      assert.equal(await dem(`select count(*)::int as n from information_schema.columns where table_name = 'outreach_targets' and column_name = '${cot}'`), 1, `0079: thiếu cột ${cot}`);
    }
    await client.query(`insert into outreach_targets (id, segment, status, message, dedupe_key) values ('up-ot1', 'CROSS_SELL', 'SENDING', 'x', 'up-ot1')`);
    const ot = (await client.query<{ attempt_count: number; provider_message_id: string | null }>("select attempt_count, provider_message_id from outreach_targets where id = 'up-ot1'")).rows[0];
    assert.equal(ot.attempt_count, 0, "0079: chưa thử lần nào là 0, không phải 1");
    assert.equal(ot.provider_message_id, null, "0079: chưa có mã tin của nhà cung cấp ⇒ NULL, không phải chuỗi rỗng");
    // `SENDING` phải là trạng thái HỢP LỆ — không có nó thì cơ chế giành chỗ không ghi được.
    await assert.rejects(
      () => client.query(`insert into outreach_targets (id, segment, status, message, dedupe_key) values ('up-ot2', 'CROSS_SELL', 'LUNG_TUNG', 'x', 'up-ot2')`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("outreach_targets_status_check"),
      "0079: trạng thái lạ phải bị chặn — danh sách đóng",
    );
    await client.query(`delete from outreach_targets where id = 'up-ot1'`);

    /*
      BA CỘT MỚI CỦA 0074 CÓ MẶC ĐỊNH — và đó KHÔNG phải một phép đoán về dữ liệu cũ.

      `shipment_return_reasons` rỗng trên production (0 dòng, đo 13/09/2026), nên mặc định không
      gán nhãn sai cho bất kỳ dòng nào đang có. Nếu bảng đã có dữ liệu thì mặc định `UNKNOWN` cho
      `reason_group` mới là lựa chọn đúng: chưa xếp nhóm, không phải xếp nhầm nhóm.
    */
    for (const cot of ["reason_group", "source", "confidence"]) {
      assert.equal(await dem(`select count(*)::int as n from information_schema.columns where table_name = 'shipment_return_reasons' and column_name = '${cot}' and column_default is not null`), 1, `cột ${cot} phải có mặc định`);
    }
    // Trừ những dòng chính bài này gieo (`up-rr…`) đóng vai "dữ liệu đang có trên production".
    assert.equal(await dem("select count(*)::int as n from shipment_return_reasons where id not like 'up-rr%'"), 0, "migration KHÔNG được tự sinh lý do hoàn nào — lý do chi tiết chỉ có khi NGƯỜI ghi");

    // Nguồn lạ bị CSDL chặn: chỉ ba giá trị có nghĩa, và mỗi cái nói một mức thẩm quyền khác nhau.
    await client.query(`insert into shipments (id, tracking_code, stage) values ('up-s2', 'UPS2', 'RETURNED')`);
    await assert.rejects(
      () => client.query(`insert into shipment_return_reasons (id, shipment_id, reason, source) values ('rr-x', 'up-s2', 'QUALITY_FABRIC_BAD', 'GUESS')`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("shipment_return_reasons_source_check"),
      "nguồn lạ phải bị chặn ở CSDL — 'đoán' không phải một nguồn",
    );
    await client.query(`delete from shipments where id = 'up-s2'`);

    // Ảnh chụp cũ nhận phiên bản nguồn mặc định 1, không phải NULL: kỳ cũ vẫn so sánh được.
    assert.equal(await dem("select count(*)::int as n from information_schema.columns where table_name = 'performance_snapshots' and column_name = 'source_version' and column_default is not null"), 1, "ảnh chụp cũ phải có phiên bản nguồn mặc định, không để NULL");

    // Tầng công ty KHÔNG được gắn tham chiếu; hai tầng kia BẮT BUỘC có — chặn ở CSDL, không ở giao diện.
    await assert.rejects(
      () => client.query(`insert into metric_targets (id, metric_key, scope, scope_ref, target, effective_from) values ('mt-x', 'care_sla', 'COMPANY', 'LOGISTICS', 80, now())`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("metric_targets_ref_check"),
      "đích toàn công ty mà gắn một phòng thì không ai biết nó áp cho ai — ràng buộc phải chặn",
    );
    await assert.rejects(
      () => client.query(`insert into metric_targets (id, metric_key, scope, target, effective_from) values ('mt-y', 'care_sla', 'DEPARTMENT', 80, now())`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("metric_targets_ref_check"),
      "đích cấp phòng mà không nói phòng nào — ràng buộc phải chặn",
    );

    /*
      ═══ CA CHĂM SÓC THEO ĐỢT (0075 + 0076) ═══

      Ba điều phải đúng cùng lúc, và cả ba đều kiểm ở mức CSDL chứ không tin vào kỷ luật mã nguồn.
    */
    // 1. Dòng care CÓ TỪ TRƯỚC không mất gì: đợt thứ nhất, có mốc mở đợt (0075 chép từ mốc tạo),
    //    kết quả vẫn NULL. Đây KHÔNG phải suy đoán kết quả — chỉ là chép một mốc đã có sang đúng cột.
    const careCu = (await client.query<{ active: boolean; episode_no: number; opened_at: string | null; care_outcome: string | null }>(
      "select active, episode_no, opened_at, care_outcome from shipment_care where id = 'up-care-1'",
    )).rows[0];
    assert.equal(careCu.active, false, "dòng care đã RESOLVED không còn là đợt đang mở (0076)");
    assert.equal(careCu.episode_no, 1, "dòng care cũ là đợt thứ nhất");
    assert.ok(careCu.opened_at, "dòng care cũ phải có mốc mở đợt");
    assert.equal(careCu.care_outcome, null, "KHÔNG backfill kết quả logistics cho ca cũ — NULL là CHƯA BIẾT");

    // 2. Đợt THỨ HAI đã mở được ở trên (up-care-3) vì đợt trước đã đóng; đợt THỨ BA cùng mở thì bị chặn.
    await assert.rejects(
      () => client.query(`insert into shipment_care (id, shipment_id, episode_no) values ('up-care-4', 'up-s9', 3)`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("shipment_care_active_uidx"),
      "hai đợt CÙNG MỞ trên một kiện thì webhook phát lại sinh ra ca trùng — chỉ mục phải chặn",
    );
    assert.equal(await dem("select count(*)::int as n from shipment_care where shipment_id = 'up-s9'"), 2, "kiện hỏng lần hai phải có đợt thứ hai, KHÔNG ghi đè đợt một");

    // 3. Kết quả lạ bị chặn: năm giá trị, mỗi cái dẫn tới một kết luận khác nhau về đội chăm sóc.
    await assert.rejects(
      () => client.query(`update shipment_care set care_outcome = 'RESCUED' where id = 'up-care-3'`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("shipment_care_outcome_check"),
      "kết quả ngoài danh mục phải bị CSDL chặn",
    );
    // Thao tác nghiệp vụ ngoài bốn quyết định cũng bị chặn — "đã gọi khách" không phải một quyết định.
    await assert.rejects(
      () => client.query(`insert into care_business_actions (id, care_case_id, shipment_id, action_type) values ('ba-x', 'up-care-3', 'up-s9', 'CALL')`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("care_business_actions_type_check"),
      "chỉ bốn quyết định nghiệp vụ được ghi vào sổ này",
    );
    assert.equal(await dem("select count(*)::int as n from care_business_actions"), 0, "migration KHÔNG được tự sinh thao tác nào");

    await client.query(`delete from shipment_care where shipment_id in ('up-s9', 'up-s8')`);
    await client.query(`delete from shipments where id in ('up-s9', 'up-s8')`);

    // Một tầng · một chỉ số · một mốc hiệu lực = MỘT đích. Hai dòng trùng thì không ai biết cái nào thắng.
    await client.query(`insert into metric_targets (id, metric_key, scope, target, effective_from) values ('mt-1', 'care_sla', 'COMPANY', 80, '2026-01-01')`);
    await assert.rejects(
      () => client.query(`insert into metric_targets (id, metric_key, scope, target, effective_from) values ('mt-2', 'care_sla', 'COMPANY', 90, '2026-01-01')`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("metric_targets_uq"),
      "hai đích cùng tầng cùng mốc thì màn hình chấm theo cái nào cũng sai — ràng buộc phải chặn",
    );

    // Người đặt đích nghỉ việc thì ĐÍCH VẪN CÒN, chỉ mất phần nối về tài khoản.
    await client.query(`update metric_targets set set_by = 'up-u1' where id = 'mt-1'`);
    await client.query(`delete from users where id = 'up-u1'`);
    assert.equal(await dem("select count(*)::int as n from metric_targets where id = 'mt-1' and set_by is null"), 1, "xoá người đặt KHÔNG được cuốn theo đích — đó là quyết định của shop, không phải tài sản của một tài khoản");
    await client.query(`delete from metric_targets where id = 'mt-1'`);

    /*
      ═══ 0099: LỜI KHAI THÔ CỦA ĐVVC — CỘNG THÊM, KHÔNG BACKFILL ═══

      Ba điều phải đúng, và điều thứ hai là điều dễ làm sai nhất:

       1. bốn cột mới + hai bảng mới có mặt;
       2. dòng CŨ giữ `vtp_raw_*` là NULL — CHƯA BIẾT ĐVVC nói gì lần cuối, khác hẳn "đã dịch
          được". Suy ngược từ `vtp_status_name` sẽ đẻ ra một lời khai với mốc thời gian bịa;
       3. `vtp_raw_mapped` mặc định TRUE — dòng cũ KHÔNG được hiện lên màn hình thành "ĐVVC vừa
          nói một câu lạ", vì chúng chưa bao giờ nói câu nào cả.
    */
    assert.equal(await dem("select count(*)::int as n from information_schema.tables where table_name = 'vtp_status_registry'"), 1, "0099: sổ đăng ký trạng thái phải có mặt");
    assert.equal(await dem("select count(*)::int as n from information_schema.tables where table_name = 'vtp_import_batches'"), 1, "0099: sổ lần nhập tệp phải có mặt");
    assert.equal(await dem("select count(*)::int as n from vtp_status_registry"), 0, "0099: migration KHÔNG được gieo một trạng thái nào — sổ chỉ ghi thứ ĐVVC thật sự đã gửi");
    assert.equal(
      await dem("select count(*)::int as n from shipments where id = 'up-s99' and vtp_raw_status_name is null and vtp_raw_status_code is null and vtp_raw_status_at is null"),
      1,
      "0099: KHÔNG backfill lời khai thô cho vận đơn cũ — suy ngược từ tên trạng thái là bịa ra một câu ĐVVC chưa từng nói",
    );
    assert.equal(await dem("select count(*)::int as n from shipments where id = 'up-s99' and vtp_raw_mapped = true"), 1, "0099: dòng cũ mặc định 'đã dịch được' để không hiện thành cảnh báo giả");
    assert.equal(await dem("select count(*)::int as n from shipments where id = 'up-s99' and vtp_sync_attempts = 0 and vtp_next_sync_at is null and vtp_sync_source is null"), 1, "0099: sổ đối chiếu của dòng cũ bắt đầu từ trống — lịch hỏi lại do lượt nạp đầu tiên đặt");
    // Sổ lần nhập chỉ nhận hai chế độ: CHẠY THỬ và ĐÃ GHI. Một chuỗi lạ ở đây là một lần nhập
    // không ai đọc được là đã ghi hay chưa.
    await assert.rejects(
      () => client.query(`insert into vtp_import_batches (id, filename, checksum, kind, mode) values ('up-ib1', 'x.csv', 'abc', 'ORDER_LIST', 'MAYBE')`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("vtp_import_batches_mode_check"),
      "0099: chế độ nhập ngoài PREVIEW/APPLY phải bị CSDL chặn",
    );

    /*
      ═══ 0100: SỔ KHOẢNG HỤT WEBHOOK — SỔ ĐO, KHÔNG PHẢI SỔ ĐOÁN ═══

      ERP KHÔNG tự phát hiện được một gói tin webhook chưa bao giờ tới: sự vắng mặt không để lại
      dấu vết nào trong chính hệ thống đã không nhận được nó. Chỉ một nguồn ĐỘC LẬP (tệp Viettel
      Post) mới lộ ra khoảng hụt. Nên sổ này BẮT ĐẦU RỖNG và chỉ lớn lên khi có tệp đối chiếu —
      migration backfill một dòng nào ở đây là bịa ra một phép đo chưa ai thực hiện.
    */
    assert.equal(await dem("select count(*)::int as n from information_schema.tables where table_name = 'vtp_webhook_gaps'"), 1, "0100: sổ khoảng hụt webhook phải có mặt");
    assert.equal(await dem("select count(*)::int as n from vtp_webhook_gaps"), 0, "0100: migration KHÔNG được gieo một khoảng hụt nào — chưa có tệp đối chiếu nào chạy thì chưa có phép đo nào");
    assert.equal(
      await dem("select count(*)::int as n from vtp_import_batches where checked = 0 and webhook_ok = 0 and webhook_gaps = 0"),
      await dem("select count(*)::int as n from vtp_import_batches"),
      "0100: lần nhập CŨ giữ ba con số đo ở 0 — chúng chạy trước khi phép đo tồn tại, không được gán một tỷ lệ khớp bịa",
    );
    // Mức nặng nhẹ là danh sách ĐÓNG: một chuỗi lạ buộc màn hình phải chọn giữa giấu đi và tô sai màu.
    await assert.rejects(
      () => client.query(`insert into vtp_webhook_gaps (id, shipment_id, tracking_code, carrier_event_at, gap_minutes, severity) values ('up-g1', 'up-s99', 'UPG1', now(), 200, 'HUGE')`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("vtp_webhook_gaps_severity_check"),
      "0100: mức nặng nhẹ ngoài MINOR/MAJOR/CRITICAL phải bị CSDL chặn",
    );
    /*
      ═══ 0101: MẶT PHẲNG ĐIỀU KHIỂN PHÒNG TECH AI — CHỈ CỘNG THÊM, SỔ AGENT BẮT ĐẦU TRỐNG ═══

      Sổ agent KHÔNG được migration gieo sẵn: mẫu chỉ chạy khi có NGƯỜI bấm (AGENTS.md mục 23).
      Một sổ tự đầy lúc migration chạy là một sổ không ai từng quyết định — và cái không ai quyết
      định thì không ai chịu trách nhiệm.

      Hai ràng buộc quan trọng nhất được kiểm ngay ở đây vì chúng là CỔNG, không phải trang trí:
      cổng phê duyệt không được mâu thuẫn, và một việc bị chặn phải nói được bị chặn bởi cái gì.
    */
    assert.equal(await dem("select count(*)::int as n from information_schema.tables where table_name = 'tech_tasks'"), 1, "0101: hàng đợi việc Tech phải có mặt");
    assert.equal(await dem("select count(*)::int as n from information_schema.tables where table_name = 'tech_agents'"), 1, "0101: sổ agent phải có mặt");
    assert.equal(await dem("select count(*)::int as n from tech_agents"), 0, "0101: migration KHÔNG được gieo agent nào — mẫu chỉ chạy khi có người bấm");
    assert.equal(await dem("select count(*)::int as n from tech_tasks"), 0, "0101: migration KHÔNG được gieo việc nào");
    // "Không cần duyệt" và "đang chờ duyệt" không được cùng đúng một lúc: thiếu ràng buộc này thì
    // một việc R2 có thể mang cờ không-cần-duyệt và đi thẳng qua cổng.
    await assert.rejects(
      () => client.query(`insert into tech_tasks (id, code, title, approval_required, approval_status) values ('up-tt1', 'TECH-9001', 'Việc mâu thuẫn', false, 'PENDING')`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("tech_tasks_approval_consistency_check"),
      "0101: cờ phê duyệt mâu thuẫn phải bị CSDL chặn",
    );
    // Chặn mà không nói vì sao thì không ai gỡ được — cùng luật với `work_items`.
    await assert.rejects(
      () => client.query(`insert into tech_tasks (id, code, title, status) values ('up-tt2', 'TECH-9002', 'Việc bị chặn không lý do', 'BLOCKED')`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("tech_tasks_blocked_reason_check"),
      "0101: việc BLOCKED không có lý do phải bị CSDL chặn",
    );
    // Một agent KHÔNG BAO GIỜ được ghi dưới danh nghĩa một con người (AGENTS.md mục 34 & 36).
    await client.query(`insert into tech_tasks (id, code, title) values ('up-tt3', 'TECH-9003', 'Việc để kiểm nhật ký')`);
    await assert.rejects(
      () => client.query(`insert into tech_task_events (id, task_id, kind, actor_kind, actor_id) values ('up-te1', 'up-tt3', 'NOTE', 'AI_AGENT', 'up-u1')`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("tech_task_events_human_link_check"),
      "0101: một agent không được mang khoá tài khoản của người",
    );
    await client.query(`delete from tech_tasks where id = 'up-tt3'`);

    /*
      ═══ 0102: ĐỌC DEPLOY TỪ GITHUB — CHỈ CỘNG THÊM, KHÔNG BỊA MỘT PHÉP ĐỐI CHIẾU NÀO ═══

      Dòng deploy GÕ TAY của Phase 1 phải giữ nguyên `provider = 'MANUAL'` và
      `verification = 'UNKNOWN'`: chúng CHƯA từng được đối chiếu với bản đang chạy, và gắn cho
      chúng nhãn 'VERIFIED' là bịa ra một phép đo chưa ai thực hiện (AGENTS.md mục 8.8).
    */
    await client.query(`insert into tech_deployments (id, commit_sha, branch, status) values ('up-td1', 'abc1234', 'main', 'SUCCEEDED')`);
    assert.equal(await dem("select count(*)::int as n from tech_deployments where id = 'up-td1' and provider = 'MANUAL' and verification = 'UNKNOWN' and production_commit is null"), 1, "0102: dòng gõ tay mặc định là CHƯA đối chiếu, không phải đã khớp");

    // Khoá duy nhất chỉ áp cho dòng CÓ mã lượt chạy: hai dòng gõ tay phải cùng tồn tại được.
    await client.query(`insert into tech_deployments (id, commit_sha, branch, status) values ('up-td2', 'def5678', 'main', 'SUCCEEDED')`);
    assert.equal(await dem("select count(*)::int as n from tech_deployments where external_run_id = ''"), 2, "0102: nhiều dòng gõ tay cùng tồn tại — chỉ mục duy nhất phải CÓ ĐIỀU KIỆN");

    // …còn cùng một lượt chạy GitHub thì KHÔNG được có hai dòng.
    await client.query(`insert into tech_deployments (id, commit_sha, provider, external_run_id, external_run_attempt, status) values ('up-td3', 'aaa1111', 'GITHUB_ACTIONS', '99001', 1, 'SUCCEEDED')`);
    await assert.rejects(
      () => client.query(`insert into tech_deployments (id, commit_sha, provider, external_run_id, external_run_attempt, status) values ('up-td4', 'aaa1111', 'GITHUB_ACTIONS', '99001', 1, 'SUCCEEDED')`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("tech_deployments_external_uq"),
      "0102: một lượt chạy GitHub chỉ được một dòng",
    );
    // Nhưng lần CHẠY LẠI (attempt 2) là một sự việc mới, phải ghi được.
    await client.query(`insert into tech_deployments (id, commit_sha, provider, external_run_id, external_run_attempt, status) values ('up-td5', 'aaa1111', 'GITHUB_ACTIONS', '99001', 2, 'SUCCEEDED')`);
    assert.equal(await dem("select count(*)::int as n from tech_deployments where external_run_id = '99001'"), 2, "0102: chạy lại workflow là dòng RIÊNG — gộp là giấu mất lần người ta quan tâm");

    // Bốn giá trị xác minh là danh sách ĐÓNG: chuỗi lạ buộc màn hình chọn giữa giấu đi và tô sai màu.
    await assert.rejects(
      () => client.query(`insert into tech_deployments (id, commit_sha, status, verification) values ('up-td6', 'bbb2222', 'SUCCEEDED', 'PROBABLY')`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("tech_deployments_verification_check"),
      "0102: trạng thái xác minh ngoài bốn giá trị phải bị CSDL chặn",
    );
    await client.query(`delete from tech_deployments where id like 'up-td%'`);

    // Cây làm việc của agent: hai cột mới, mặc định TRỐNG — chưa lượt chạy nào từng có cây.
    assert.equal(await dem("select count(*)::int as n from information_schema.columns where table_name = 'tech_agent_runs' and column_name = 'worktree'"), 1, "0102: cột cây làm việc phải có mặt");
    assert.equal(await dem("select count(*)::int as n from information_schema.columns where table_name = 'tech_agent_runs' and column_name = 'heartbeat_at'"), 1, "0102: cột nhịp tim phải có mặt");

    // Cùng một sự việc phát hiện lại ở lần nhập sau KHÔNG được đếm thành hai lần rơi: nếu đếm hai
    // lần thì mỗi lần nhập lại một tệp cũ sẽ tự làm xấu tỷ lệ khớp webhook của chính nó.
    const mocGap = "2026-09-10T03:00:00.000Z";
    await client.query(`insert into vtp_webhook_gaps (id, shipment_id, tracking_code, carrier_status_text, carrier_event_at, gap_minutes, severity) values ('up-g2', 'up-s99', 'UPG1', 'Giao thành công', $1, 200, 'MAJOR')`, [mocGap]);
    await client.query(`insert into vtp_webhook_gaps (id, shipment_id, tracking_code, carrier_status_text, carrier_event_at, gap_minutes, severity) values ('up-g3', 'up-s99', 'UPG1', 'Giao thành công', $1, 999, 'CRITICAL') on conflict do nothing`, [mocGap]);
    assert.equal(await dem("select count(*)::int as n from vtp_webhook_gaps where shipment_id = 'up-s99'"), 1, "0100: phát hiện lại cùng một sự việc chỉ còn MỘT dòng");
    await client.query(`delete from vtp_webhook_gaps where shipment_id = 'up-s99'`);

    await client.query(`delete from shipments where id = 'up-s99'`);

    /*
      ═══ 0104: PHÉP CHIẾU PR VÀ SỔ ĐỀ XUẤT ═══

      Hai thứ migration này thêm, và cả hai phải VÀO ĐỜI RỖNG. Một cột `ci_state` mang sẵn giá trị
      nào đó là ERP tự khẳng định một điều GitHub chưa nói; một bản đề xuất tự sinh là AI CTO có
      tiếng nói trước khi ai bật nó lên.
    */
    assert.equal(await dem("select count(*)::int as n from tech_proposals"), 0, "0104: sổ đề xuất phải vào đời RỖNG — không migration nào được sinh một kế hoạch");
    assert.equal(await dem("select count(*)::int as n from tech_tasks where pr_state <> '' or ci_state <> '' or merge_state <> ''"), 0, "0104: phép chiếu PR phải RỖNG — rỗng là CHƯA BIẾT, không phải 'chưa có PR' và không phải 'check đỏ'");

    /* Giá trị lạ lọt vào phép chiếu là màn hình vẽ một trạng thái không tồn tại. */
    await client.query(`insert into tech_tasks (id, code, title) values ('up-t1', 'UPT-1', 'Việc kiểm phép chiếu PR')`);
    let chanCiLa = false;
    try {
      await client.query(`update tech_tasks set ci_state = 'XANH_LET' where id = 'up-t1'`);
    } catch {
      chanCiLa = true;
    }
    assert.ok(chanCiLa, "0104: trạng thái CI lạ phải bị CSDL chặn");

    /*
      Bản đề xuất ĐÃ TỪ CHỐI mà không nói vì sao thì lần lập lại kế hoạch sau lặp đúng sai lầm cũ —
      ràng buộc ở CSDL, không phải chỉ ở lớp dịch vụ.
    */
    await client.query(`insert into tech_proposals (id, source_task_id, status) values ('up-p1', 'up-t1', 'READY_FOR_REVIEW')`);
    let chanTuChoi = false;
    try {
      await client.query(`update tech_proposals set status = 'REJECTED', decided_at = now(), decision_note = 'ngắn' where id = 'up-p1'`);
    } catch {
      chanTuChoi = true;
    }
    assert.ok(chanTuChoi, "0104: từ chối mà không nêu lý do đủ dài phải bị chặn");
    /* …và đã quyết thì phải có MỐC. Một bản APPROVED không mốc là quyết định không ai chịu trách nhiệm. */
    let chanThieuMoc = false;
    try {
      await client.query(`update tech_proposals set status = 'APPROVED' where id = 'up-p1'`);
    } catch {
      chanThieuMoc = true;
    }
    assert.ok(chanThieuMoc, "0104: chốt duyệt mà không có mốc phải bị chặn");
    /* Khoá việc trùng trong CÙNG một bản kế hoạch làm `depends_on_keys` trỏ vào chỗ nhập nhằng. */
    await client.query(`insert into tech_proposal_tasks (id, proposal_id, key, title) values ('up-pt1', 'up-p1', 'T1', 'Việc một')`);
    let chanTrungKhoa = false;
    try {
      await client.query(`insert into tech_proposal_tasks (id, proposal_id, key, title) values ('up-pt2', 'up-p1', 'T1', 'Việc một lần nữa')`);
    } catch {
      chanTrungKhoa = true;
    }
    assert.ok(chanTrungKhoa, "0104: hai việc cùng khoá trong một bản kế hoạch phải bị chặn");

    /*
      ═══ 0105: BẰNG CHỨNG LƯỢT SỬA ═══

      Mặc định phải mô tả ĐÚNG những dòng đã có: hồi đó chưa có đường sửa nào tồn tại, nên mọi bản
      đề xuất cũ là "gọi một lượt, không sửa". Một mặc định nói khác đi là backfill thầm (mục 8.8).
    */
    assert.equal(
      await dem("select count(*)::int as n from tech_proposals where model_calls = 1 and initial_error = '' and repair_outcome = 'NONE'"),
      await dem("select count(*)::int as n from tech_proposals"),
      "0105: mọi dòng đã có phải mang mặc định (1, '', 'NONE') — không đoán hộ một lượt sửa chưa từng xảy ra",
    );
    /* Trần là HAI lượt. Một con số thứ ba lọt vào nghĩa là vòng lặp đã quay mà không ai chặn. */
    let chanQuaTran = false;
    try {
      await client.query(`update tech_proposals set model_calls = 3 where id = 'up-p1'`);
    } catch {
      chanQuaTran = true;
    }
    assert.ok(chanQuaTran, "0105: quá hai lượt gọi phải bị CSDL chặn — không có lượt sửa thứ hai");
    /*
      Hai cột phải kể CÙNG MỘT câu chuyện: có kết quả sửa thì phải có lượt sửa được đếm. Lệch nhau
      là con số "bao nhiêu phần trăm bản đề xuất cần sửa" sai mà không gì báo.
    */
    let chanLechNhau = false;
    try {
      await client.query(`update tech_proposals set repair_outcome = 'PASS', model_calls = 1 where id = 'up-p1'`);
    } catch {
      chanLechNhau = true;
    }
    assert.ok(chanLechNhau, "0105: có kết quả sửa mà chỉ đếm một lượt gọi phải bị chặn");
    /* …và bộ đôi hợp lệ thì phải ghi được. */
    await client.query(`update tech_proposals set repair_outcome = 'PASS', model_calls = 2, initial_error = 'tasks: Too big' where id = 'up-p1'`);
    assert.equal(await dem("select count(*)::int as n from tech_proposals where id = 'up-p1' and model_calls = 2 and repair_outcome = 'PASS'"), 1, "0105: một lượt sửa thành công phải ghi lại được");
    /*
      ═══ 0107: KHOÁ TỰ NHIÊN CHO LƯỢT CHẠY AGENT ĐẾN TỪ MÁY NGOÀI ═══

      Runner chạy trên máy GitHub Actions, không nối được CSDL production, nên sổ được CHÉP về qua
      một cửa hẹp hướng ra Internet. "Chép hai lần không đẻ hai dòng" vì thế phải là BẢO ĐẢM CỦA
      CSDL, và bài này chứng minh bằng cách chạy lệnh thật chứ không đọc tên chỉ mục.
    */
    await client.query(`insert into tech_agents (id, key, name, role) values ('up-ag1', 'up-doc', 'Vai tài liệu', 'DOCUMENTATION')`);
    /* Lượt chạy CŨ (sinh trước bản này) phải ở NULL — KHÔNG backfill một danh tính chưa từng tồn tại (mục 35). */
    await client.query(`insert into tech_agent_runs (id, agent_id, agent_key, status, ended_at) values ('up-r0', 'up-ag1', 'up-doc', 'SUCCEEDED', now())`);
    assert.equal(await dem("select count(*)::int as n from tech_agent_runs where id = 'up-r0' and external_ref is null"), 1, "0107: lượt chạy cũ phải ở NULL — không gán cho nó một khoá ngoài chưa từng có");

    await client.query(`insert into tech_agent_runs (id, agent_id, agent_key, status, ended_at, external_ref) values ('up-r1', 'up-ag1', 'up-doc', 'SUCCEEDED', now(), 'github:1:1')`);
    await assert.rejects(
      () => client.query(`insert into tech_agent_runs (id, agent_id, agent_key, status, ended_at, external_ref) values ('up-r2', 'up-ag1', 'up-doc', 'FAILED', now(), 'github:1:1')`),
      () => true,
      "0107: chép lại đúng một lượt chạy KHÔNG được đẻ dòng thứ hai",
    );
    /* Chạy LẠI workflow là một sự việc MỚI — `attempt` nằm trong khoá nên nó phải ghi được. */
    await client.query(`insert into tech_agent_runs (id, agent_id, agent_key, status, ended_at, external_ref) values ('up-r3', 'up-ag1', 'up-doc', 'SUCCEEDED', now(), 'github:1:2')`);
    /*
      NHIỀU `NULL` PHẢI CÙNG TỒN TẠI. Nếu không, khoá mới này lặng lẽ chặn mọi lượt chạy NỘI BỘ
      thứ hai — một migration làm hỏng đường ghi cũ mà không màn hình nào báo.
    */
    await client.query(`insert into tech_agent_runs (id, agent_id, agent_key, status, ended_at) values ('up-r4', 'up-ag1', 'up-doc', 'SUCCEEDED', now())`);
    assert.equal(await dem("select count(*)::int as n from tech_agent_runs where external_ref is null"), 2, "0107: lượt chạy nội bộ (NULL) không được đụng nhau");
    await client.query(`delete from tech_agent_runs where agent_id = 'up-ag1'`);
    await client.query(`delete from tech_agents where id = 'up-ag1'`);

    await client.query(`delete from tech_proposals where id = 'up-p1'`);
    await client.query(`delete from tech_tasks where id = 'up-t1'`);

    // ══ BƯỚC 3: áp lại — migration phải idempotent ══
    await migrate(db, { migrationsFolder: thuMucSo });
    // Số phòng lấy TỪ SỔ trong mã nguồn, không gõ lại: tách một phòng mới thì con số này tự đúng,
    // còn gõ tay thì bài kiểm đỏ vì một lý do chẳng liên quan tới tính idempotent nó đang đo.
    assert.equal(await dem("select count(*)::int as n from departments"), DEPARTMENT_CODES.length, "chạy lại migration KHÔNG được gieo thêm phòng ban lần hai");
    assert.equal(await dem("select count(*)::int as n from metric_targets where id not like 'up-mt%'"), 0, "chạy lại migration KHÔNG được sinh đích nào");
    // …và cũng KHÔNG được đụng tới đích đã có: hai dòng bài này gieo phải còn nguyên cả tầng lẫn số.
    assert.equal(await dem("select count(*)::int as n from metric_targets where (id = 'up-mt1' and scope = 'COMPANY' and target = 65) or (id = 'up-mt2' and scope = 'PRODUCT' and scope_ref = 'Q004' and target = 55)"), 2, "chạy lại migration KHÔNG được sửa đích đã đặt");
    assert.equal(await dem("select count(*)::int as n from shipment_return_reasons where id not like 'up-rr%'"), 0, "chạy lại migration KHÔNG được sinh lý do hoàn nào");
    assert.equal(await dem("select count(*)::int as n from cs_cases where id = 'up-c1' and assignee_user_id is null"), 1, "chạy lại migration vẫn KHÔNG được đoán người phụ trách");
    assert.equal(await dem("select count(*)::int as n from tech_proposals"), 0, "chạy lại migration KHÔNG được sinh bản đề xuất nào");
    assert.equal(await dem("select count(*)::int as n from tech_agent_runs"), 0, "chạy lại migration KHÔNG được sinh lượt chạy agent nào");

    console.log(`✓ Đường nâng cấp từ production: ${truoc} → ${sau} migration (+${sau - truoc}) · dữ liệu nghiệp vụ nguyên vẹn · tài khoản cũ giữ nguyên phạm vi ALL · KHÔNG backfill người phụ trách · đích rỗng và bốn ràng buộc mới chặn đúng, xoá người đặt không cuốn theo đích · work_items rỗng (phép chiếu, không bản sao) · sổ đề xuất AI CTO và phép chiếu PR vào đời RỖNG, bốn ràng buộc mới chặn đúng · bằng chứng lượt sửa mặc định (1,'',NONE) và hai ràng buộc 0105 chặn đúng · khoá lượt chạy ngoài chặn bản sao nhưng cho nhiều NULL, không backfill dòng cũ · chạy lại không nhân đôi`);
  } finally {
    await client.close().catch(() => {});
    rmSync(tmp, { recursive: true, force: true });
  }
}
