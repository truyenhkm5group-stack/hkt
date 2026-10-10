/**
 * ═══════ HAI LƯỢT GỌI CÙNG LÚC KHÔNG ĐƯỢC CHẠY CÙNG MỘT JOB HAI LẦN ═══════
 *
 * `runSyncJob` (lib/sync/runner.ts) hứa "Mỗi job chỉ chạy một tiến trình tại một thời điểm". Nhưng thứ tự trong hàm là:
 *   kiểm `runningJobs.has(key)`  →  `await` update `sync_runs` mồ côi  →  `await` insert `sync_runs`  →  …  →
 *   `runningJobs.set(key, promise)`.
 * Giữa lúc KIỂM và lúc GIỮ khoá có hai lượt chờ CSDL, nên hai lời gọi bắt đầu trong cùng một nhịp (một lượt lịch và
 * một cú bấm tay, hay hai webhook kích cùng một job) đều thấy "chưa ai chạy" và cùng chạy thân job.
 *
 * Bài kiểm hiện có (`tests/platform-process-isolation.test.ts` mục 5) CHỜ lượt đầu thật sự chạy (`doiToi`) rồi mới gọi
 * lượt hai — đúng với khoá, nhưng không bao giờ chạm cửa sổ đua. Bài này gọi hai lượt KHÔNG chờ nhau.
 *
 * Phần 1 (phải XANH): gọi tuần tự khi lượt đầu đang chạy ⇒ lượt hai bị bỏ qua — hợp đồng đã có.
 * Phần 2 (hồi quy F3): hai lượt cùng lúc ⇒ thân job chạy 1 lần — khoá được giữ TRƯỚC lượt `await` đầu tiên.
 * Phần 3: giữ sớm thì phải nhả ở mọi nhánh — chèn `sync_runs` ném ⇒ lỗi đi ra ngoài VÀ khoá được nhả (không kẹt job tới khi
 *         khởi động lại); lượt sau chạy lại được, không bị báo "đang chạy".
 *
 * CSDL: PGlite trong bộ nhớ của tiến trình kiểm thử (không chạm Postgres nào). Job dùng `observeOnly` + tên riêng.
 * Chạy: DATABASE_URL=pglite:memory npx tsx --tsconfig tsconfig.json tests/sync-runner-concurrent-start.test.ts
 */
import assert from "node:assert/strict";

export async function testSyncRunnerConcurrentStart(): Promise<{ passed: number; failed: string[] }> {
  if (!process.env.DATABASE_URL) process.env.DATABASE_URL = "pglite:memory";
  assert.ok(/^pglite:/.test(process.env.DATABASE_URL), "bài này chỉ chạy trên PGlite — không bao giờ trên Postgres thật");
  const { ensureMigrated } = await import("@/db/migrate");
  await ensureMigrated(); // idempotent — trong runner chung đã chạy rồi thì là phép no-op
  const { runSyncJob, runningJobKeys } = await import("@/lib/sync/runner");

  const failed: string[] = [];
  let passed = 0;
  const check = (name: string, fn: () => void) => {
    try {
      fn();
      passed += 1;
      console.log(`  ✓ ${name}`);
    } catch (e) {
      failed.push(name);
      console.log(`  ✗ ${name}\n      ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}`);
    }
  };

  /** Thân job giữ cổng tới khi bài kiểm mở — để hai lượt chắc chắn chồng lên nhau nếu khoá không giữ. */
  const makeJob = () => {
    let bodies = 0;
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const body = async () => {
      bodies += 1;
      await gate;
      return bodies;
    };
    return { body, open: () => open(), bodies: () => bodies };
  };
  const waitUntil = async (cond: () => boolean, ms = 5_000) => {
    const end = Date.now() + ms;
    while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
    return cond();
  };

  // Mồi CSDL (migrate PGlite lần đầu) để thời gian migrate không lẫn vào phép đo bên dưới.
  await runSyncJob({ source: "ERP", job: "race_warmup", observeOnly: true }, async () => 0);

  // ── 1 · Hợp đồng đã có: lượt hai tới SAU khi lượt đầu đã chạy ──
  {
    const j = makeJob();
    const p1 = runSyncJob({ source: "ERP", job: "race_sequential", observeOnly: true }, j.body);
    const started = await waitUntil(() => j.bodies() === 1);
    const r2 = await runSyncJob({ source: "ERP", job: "race_sequential", observeOnly: true }, j.body);
    j.open();
    await p1;
    check("tuần tự: lượt hai bị bỏ qua khi lượt đầu đang chạy", () => {
      assert.ok(started, "lượt đầu phải bắt đầu chạy");
      assert.equal(r2.skippedBecauseRunning, true);
      assert.equal(j.bodies(), 1);
    });
  }

  // ── 2 · Hồi quy: hai lượt bắt đầu trong CÙNG một nhịp ──
  {
    const j = makeJob();
    const p1 = runSyncJob({ source: "ERP", job: "race_concurrent", observeOnly: true }, j.body);
    const p2 = runSyncJob({ source: "ERP", job: "race_concurrent", observeOnly: true }, j.body);
    // Cho cả hai lượt đi hết phần chờ CSDL trước khi mở cổng.
    await waitUntil(() => j.bodies() >= 2, 1_500);
    const bodiesWhileOpen = j.bodies();
    j.open();
    const [r1, r2] = await Promise.all([p1, p2]);
    const skipped = [r1, r2].filter((r) => r.skippedBecauseRunning === true).length;
    check("cùng lúc: thân job chỉ chạy MỘT lần", () => {
      assert.equal(bodiesWhileOpen, 1, `thân job chạy ${bodiesWhileOpen} lần song song — khoá được giữ SAU lượt await CSDL`);
    });
    check("cùng lúc: đúng một lượt báo skippedBecauseRunning", () => {
      assert.equal(skipped, 1, `${skipped}/2 lượt báo bị bỏ qua`);
    });
  }

  // ── 3 · Chèn `sync_runs` ném ⇒ khoá phải được nhả ──
  {
    // Ký tự NUL không vào được cột `text` của Postgres/PGlite ⇒ lệnh chèn `sync_runs` ném THẬT, không cần giả lập module.
    const job = "race_insert_fails\u0000";
    let bodies = 0;
    const body = async () => {
      bodies += 1;
      return bodies;
    };
    const loi1 = await runSyncJob({ source: "ERP", job, observeOnly: true }, body).then(
      () => null,
      (e: unknown) => e,
    );
    const conKhoa = runningJobKeys().some((k) => k.includes("race_insert_fails"));
    const loi2 = await runSyncJob({ source: "ERP", job, observeOnly: true }, body).then(
      (r) => (r.skippedBecauseRunning ? "SKIPPED" : null),
      (e: unknown) => e,
    );
    check("chèn sync_runs ném ⇒ lỗi đi ra ngoài, thân job không chạy", () => {
      assert.ok(loi1 instanceof Error, "lỗi chèn sync_runs phải được ném ra cho bên gọi");
      assert.equal(bodies, 0);
    });
    check("chèn sync_runs ném ⇒ khoá được nhả", () => {
      assert.equal(conKhoa, false, "khoá còn giữ sau khi chèn sync_runs ném — job sẽ kẹt tới khi khởi động lại");
      assert.ok(loi2 instanceof Error, `lượt sau phải thử lại thật (ném lỗi chèn), không bị báo "đang chạy" — nhận ${String(loi2)}`);
    });
  }

  return { passed, failed };
}

if (/sync-runner-concurrent-start\.test\.ts$/.test(process.argv[1] ?? "")) {
  testSyncRunnerConcurrentStart().then(
    (r) => {
      console.log(`sync-runner-concurrent-start: ${r.passed} đạt · ${r.failed.length} không đạt`);
      process.exit(r.failed.length ? 1 : 0);
    },
    (e) => {
      console.error(e);
      process.exit(2);
    },
  );
}
