/* HKT – giao diện quản lý giao dịch. Vanilla JS, không phụ thuộc thư viện. */
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const fmt = new Intl.NumberFormat('vi-VN');
  const money = (n) => (n == null ? '—' : fmt.format(Math.round(n) || 0) + ' ₫');
  const signed = (n) => (n > 0 ? '+' : '') + money(n);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const iso = (d) => d.toISOString().slice(0, 10);
  const fmtDate = (s) => (s ? s.split('-').reverse().join('/') : '');

  const state = { categories: [], groups: [], txPage: 1, txLimit: 100, selected: new Set(), importFile: null };

  // -------------------------------------------------------------- API
  async function api(path, opts = {}) {
    const res = await fetch(path, { headers: opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}, ...opts,
      body: opts.body && !(opts.body instanceof FormData) ? JSON.stringify(opts.body) : opts.body });
    if (!res.ok) {
      let msg = res.statusText;
      try { const j = await res.json(); msg = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail); } catch (_) {}
      throw new Error(msg);
    }
    return res.json();
  }
  let toastTimer;
  function toast(msg, err = false) {
    const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), err ? 6000 : 3000);
  }
  const onErr = (e) => toast(e.message || String(e), true);
  async function refreshBadge() {
    try { const st = await api('/api/stats'); const b = $('#badgeUnclassified'); b.hidden = !st.unclassified; b.textContent = st.unclassified; } catch (_) {}
  }

  // -------------------------------------------------------------- Tabs
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  function showTab(name) {
    $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    $$('.tab').forEach((s) => (s.hidden = s.id !== 'tab-' + name));
    if (name === 'dashboard') loadDashboard();
    if (name === 'transactions') loadTransactions();
    if (name === 'rules') loadRules();
    if (name === 'categories') renderCategoriesTab();
    if (name === 'settings') loadSettings();
    location.hash = name;
  }

  // -------------------------------------------------------------- Periods
  function periodRange(kind) {
    const now = new Date(); const y = now.getFullYear(); const m = now.getMonth();
    const d = (yy, mm, dd) => new Date(Date.UTC(yy, mm, dd));
    switch (kind) {
      case 'this-month': return [iso(d(y, m, 1)), iso(d(y, m + 1, 0))];
      case 'last-month': return [iso(d(y, m - 1, 1)), iso(d(y, m, 0))];
      case 'this-quarter': { const q = Math.floor(m / 3) * 3; return [iso(d(y, q, 1)), iso(d(y, q + 3, 0))]; }
      case 'this-year': return [iso(d(y, 0, 1)), iso(d(y, 11, 31))];
      case 'all': return ['2000-01-01', iso(d(y + 1, 11, 31))];
    }
  }
  $$('.quick button').forEach((b) => b.addEventListener('click', () => {
    const [f, t] = periodRange(b.dataset.period); $('#dashFrom').value = f; $('#dashTo').value = t; loadDashboard();
  }));
  $('#dashRefresh').addEventListener('click', loadDashboard);

  // -------------------------------------------------------------- Categories
  async function loadCategories() {
    const data = await api('/api/categories');
    state.categories = data.categories; state.groups = data.groups;
    const opts = categoryOptions();
    ['#txCategory', '#bulkCategory', '#ruleCategory', '#fTxCategory'].forEach((sel) => {
      const el = $(sel); const first = el.options[0] && el.options[0].value === '' ? el.options[0].outerHTML : '';
      el.innerHTML = (sel === '#txCategory' || sel === '#fTxCategory' ? first : '') + opts;
    });
    $('#txGroup').innerHTML = '<option value="">— Nhóm kế toán —</option>' + state.groups.map((g) => `<option value="${g.code}">${esc(g.name)}</option>`).join('');
    $('#catGroup').innerHTML = state.groups.filter((g) => g.code !== 'UNCLASSIFIED').map((g) => `<option value="${g.code}">${esc(g.name)}${g.account ? ' (' + g.account + ')' : ''}</option>`).join('');
  }
  function categoryOptions(selected) {
    let html = ''; let grp = null;
    for (const c of state.categories) {
      if (c.grp !== grp) { if (grp) html += '</optgroup>'; grp = c.grp; html += `<optgroup label="${esc(c.grp_name)}${c.account ? ' · ' + c.account : ''}">`; }
      html += `<option value="${c.code}" ${c.code === selected ? 'selected' : ''}>${esc(c.name)}</option>`;
    }
    return html + (grp ? '</optgroup>' : '');
  }

  // -------------------------------------------------------------- Dashboard
  async function loadDashboard() {
    const f = $('#dashFrom').value, t = $('#dashTo').value;
    const qs = `?date_from=${f}&date_to=${t}`;
    try {
      const [pnl, br, stats] = await Promise.all([api('/api/reports/pnl' + qs), api('/api/reports/categories' + qs), api('/api/stats')]);
      renderKpis(pnl); renderPnl(pnl); renderBreakdown(br);
      const badge = $('#badgeUnclassified'); badge.hidden = !stats.unclassified; badge.textContent = stats.unclassified;
      const yearSel = $('#chartYear'); const yr = f.slice(0, 4);
      if (!yearSel.options.length || !$$('option', yearSel).some((o) => o.value === yr)) {
        const y0 = stats.first_date ? +stats.first_date.slice(0, 4) : +yr; const y1 = Math.max(+yr, new Date().getFullYear());
        const years = []; for (let y = Math.min(y0, +yr); y <= y1; y++) years.push(y);
        yearSel.innerHTML = years.map((y) => `<option value="${y}">${y}</option>`).join('');
      }
      yearSel.value = yr; loadMonthly();
    } catch (e) { onErr(e); }
  }
  $('#chartYear').addEventListener('change', loadMonthly);

  function renderKpis(pnl) {
    const s = pnl.summary; const pct = (v) => (v == null ? '' : v.toFixed(1) + '%');
    const cls = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
    const items = [
      ['Doanh thu thuần', money(s.net_revenue), s.deductions ? 'giảm trừ ' + money(s.deductions) : 'doanh thu ' + money(s.revenue)],
      ['Giá vốn hàng bán', money(s.cogs), s.net_revenue ? (100 - (s.gross_margin_pct ?? 0)).toFixed(1) + '% doanh thu' : ''],
      ['Lợi nhuận gộp', `<span class="${cls(s.gross_profit)}">${money(s.gross_profit)}</span>`, 'biên gộp ' + pct(s.gross_margin_pct)],
      ['Chi phí bán hàng + quản lý', money(s.selling + s.admin), `bán hàng ${money(s.selling)} · quản lý ${money(s.admin)}`],
      ['Lợi nhuận trước thuế', `<span class="${cls(s.profit_before_tax)}">${money(s.profit_before_tax)}</span>`, 'tổng chi phí ' + money(s.total_expenses)],
      ['Lợi nhuận sau thuế', `<span class="${cls(s.profit_after_tax)}">${money(s.profit_after_tax)}</span>`, 'biên ròng ' + pct(s.net_margin_pct)],
      ['Dòng tiền qua tài khoản', `<span class="${cls(s.net_cash_flow)}">${signed(s.net_cash_flow)}</span>`, `vào ${money(s.cash_in)} · ra ${money(s.cash_out)}`],
    ];
    if (s.closing_balance != null) items.push(['Số dư cuối kỳ', money(s.closing_balance), s.opening_balance != null ? 'đầu kỳ ' + money(s.opening_balance) : '']);
    let html = items.map(([l, v, sub]) => `<div class="kpi"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${sub}</div></div>`).join('');
    if (s.unclassified_count) html += `<div class="kpi warn"><div class="l">Chưa phân loại</div><div class="v">${s.unclassified_count} GD</div><div class="s">vào ${money(s.unclassified_in)} · ra ${money(s.unclassified_out)} <a href="#" id="goUnclassified">gán nhãn →</a></div></div>`;
    $('#kpis').innerHTML = html;
    const go = $('#goUnclassified'); if (go) go.addEventListener('click', (e) => { e.preventDefault(); $('#txUnclassified').checked = true; $('#txFrom').value = pnl.period.from; $('#txTo').value = pnl.period.to; showTab('transactions'); });
  }
  function renderPnl(pnl) {
    $('#pnlTable').innerHTML = pnl.lines.map((l) => `<tr class="l${l.level} ${l.highlight ? 'hl' : ''}"><td class="code">${l.code}</td><td>${esc(l.label)}</td><td class="num ${l.negative ? 'neg-line' : ''}">${l.negative && l.value ? '(' + money(l.value) + ')' : money(l.value)}</td></tr>`).join('');
    const te = pnl.tax_estimate; const s = pnl.summary;
    const yearNote = (y) => y.below_threshold
      ? `Năm ${y.year}: doanh thu thuần luỹ kế <b>${money(y.year_net_revenue)}</b> – dưới ngưỡng ${money(te.threshold)}/năm nên chưa phải nộp thuế GTGT/TNCN.`
      : `Năm ${y.year}: doanh thu thuần trong kỳ ${money(y.period_net_revenue)} → GTGT ${te.vat_rate}% = <b>${money(y.vat)}</b>, TNCN ${te.pit_rate}% = <b>${money(y.pit)}</b>.`;
    let txt = te.years.map(yearNote).join('<br>');
    if (!te.below_threshold) txt += `<br>Tổng thuế ước tính kỳ này <b>${money(te.total)}</b> → lợi nhuận sau thuế ước tính <b>${money(te.profit_after_tax_est)}</b>. (Đã nộp thực tế trong kỳ: ${money(s.tax_paid)}.)`;
    txt += `<br>Các khoản không tính vào lãi/lỗ trong kỳ: vào ${money(s.non_pl_in)} · ra ${money(s.non_pl_out)} (góp/rút vốn, vay, chuyển nội bộ, mua tài sản...).`;
    $('#taxNote').innerHTML = txt;
  }
  function renderBreakdown(br) {
    const rows = []; let grp = null; let gsum = 0;
    const maxAbs = Math.max(1, ...br.items.map((i) => Math.abs(i.value)));
    const flushGroup = () => {};
    for (const it of br.items) {
      if (it.grp !== grp) {
        grp = it.grp; gsum = br.items.filter((x) => x.grp === grp).reduce((a, x) => a + x.value, 0);
        rows.push(`<tr class="grp"><td colspan="2">${esc(it.grp_name)}${it.account ? ' <span class="tag">TK ' + it.account + '</span>' : ''}</td><td class="num">${money(gsum)}</td><td class="num">${br.net_revenue && !['NON_PL', 'UNCLASSIFIED'].includes(grp) ? (gsum * 100 / br.net_revenue).toFixed(1) + '%' : ''}</td><td></td><td></td></tr>`);
      }
      const isRev = ['REVENUE', 'FIN_INCOME', 'OTHER_INCOME'].includes(it.grp);
      rows.push(`<tr><td>${esc(it.name)}</td><td class="bar"><i class="${isRev ? 'rev' : ''}" style="width:${Math.abs(it.value) * 100 / maxAbs}%"></i></td><td class="num">${money(it.value)}</td><td class="num">${it.pct_of_revenue == null ? '' : it.pct_of_revenue.toFixed(1) + '%'}</td><td class="num">${it.count} GD</td><td class="num"><small>vào ${money(it.cash_in)} · ra ${money(it.cash_out)}</small></td></tr>`);
    }
    flushGroup();
    $('#breakdownTable').innerHTML = `<thead><tr><th>Đầu mục</th><th></th><th class="num">Giá trị</th><th class="num">% DT thuần</th><th class="num">Số GD</th><th class="num">Dòng tiền</th></tr></thead><tbody>${rows.join('') || '<tr><td colspan="6">Chưa có giao dịch trong kỳ.</td></tr>'}</tbody>`;
  }
  async function loadMonthly() {
    try {
      const data = await api('/api/reports/monthly?year=' + $('#chartYear').value);
      renderChart(data.months); renderMonthlyTable(data.months);
    } catch (e) { onErr(e); }
  }
  function renderChart(months) {
    const W = 600, H = 220, padL = 10, padB = 22, padT = 10;
    const vals = months.flatMap((m) => [m.net_revenue, m.expenses, m.profit_before_tax]);
    const maxV = Math.max(1, ...vals.map((v) => Math.abs(v)));
    const minV = Math.min(0, ...vals);
    const scale = (H - padB - padT) / (maxV - minV || 1);
    const zeroY = padT + (maxV - 0) * scale;
    const gw = (W - padL * 2) / 12; const bw = gw / 4;
    let svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><line x1="0" x2="${W}" y1="${zeroY}" y2="${zeroY}" stroke="#cbd5e1"/>`;
    months.forEach((m, i) => {
      const x0 = padL + i * gw + bw / 2;
      [[m.net_revenue, 'var(--c-rev)'], [m.expenses, 'var(--c-exp)'], [m.profit_before_tax, 'var(--c-profit)']].forEach(([v, col], k) => {
        const h = Math.abs(v) * scale; const y = v >= 0 ? zeroY - h : zeroY;
        svg += `<rect x="${x0 + k * bw}" y="${y}" width="${bw - 1}" height="${h}" fill="${col}"><title>${m.month}: ${money(v)}</title></rect>`;
      });
      svg += `<text x="${padL + i * gw + gw / 2}" y="${H - 6}" font-size="10" text-anchor="middle" fill="#6b7280">T${i + 1}</text>`;
    });
    $('#chart').innerHTML = svg + '</svg>';
  }
  function renderMonthlyTable(months) {
    const has = months.filter((m) => m.cash_in || m.cash_out);
    if (!has.length) { $('#monthlyTable').innerHTML = ''; return; }
    $('#monthlyTable').innerHTML = `<thead><tr><th>Tháng</th><th class="num">DT thuần</th><th class="num">Giá vốn</th><th class="num">LN gộp</th><th class="num">CP BH+QL</th><th class="num">LN trước thuế</th></tr></thead><tbody>` +
      has.map((m) => `<tr><td>${m.month.slice(5)}/${m.month.slice(0, 4)}</td><td class="num">${money(m.net_revenue)}</td><td class="num">${money(m.cogs)}</td><td class="num">${money(m.gross_profit)}</td><td class="num">${money(m.selling + m.admin)}</td><td class="num ${m.profit_before_tax < 0 ? 'neg' : 'pos'}">${money(m.profit_before_tax)}</td></tr>`).join('') + '</tbody>';
  }

  // -------------------------------------------------------------- Transactions
  $('#txSearch').addEventListener('click', () => { state.txPage = 1; loadTransactions(); });
  $('#txQ').addEventListener('keydown', (e) => { if (e.key === 'Enter') { state.txPage = 1; loadTransactions(); } });
  $('#txUnclassified').addEventListener('change', () => { state.txPage = 1; loadTransactions(); });
  $('#txExport').addEventListener('click', () => {
    const f = $('#txFrom').value || '2000-01-01', t = $('#txTo').value || '2099-12-31';
    if (window.HKT_LOCAL) { window.HKT_LOCAL.exportCsv(f, t); toast('Đã tạo file CSV'); return; }
    window.location = `/api/export.csv?date_from=${f}&date_to=${t}`;
  });
  $('#txCheckAll').addEventListener('change', (e) => { $$('#txTable tbody input[type=checkbox]').forEach((c) => { c.checked = e.target.checked; toggleSel(+c.value, c.checked); }); });
  $('#bulkClear').addEventListener('click', () => { state.selected.clear(); $('#txCheckAll').checked = false; loadTransactions(); });
  $('#bulkApply').addEventListener('click', async () => {
    try { const r = await api('/api/transactions/bulk-categorize', { method: 'POST', body: { ids: [...state.selected], category_code: $('#bulkCategory').value } });
      toast(`Đã gán ${r.updated} giao dịch`); state.selected.clear(); loadTransactions(); refreshBadge(); } catch (e) { onErr(e); }
  });
  function toggleSel(id, on) { on ? state.selected.add(id) : state.selected.delete(id); const bar = $('#bulkBar'); bar.hidden = !state.selected.size; $('#bulkCount').textContent = state.selected.size; }

  async function loadTransactions() {
    const p = new URLSearchParams({ page: state.txPage, limit: state.txLimit });
    if ($('#txFrom').value) p.set('date_from', $('#txFrom').value);
    if ($('#txTo').value) p.set('date_to', $('#txTo').value);
    if ($('#txQ').value) p.set('q', $('#txQ').value);
    if ($('#txGroup').value) p.set('grp', $('#txGroup').value);
    if ($('#txCategory').value) p.set('category', $('#txCategory').value);
    if ($('#txDirection').value) p.set('direction', $('#txDirection').value);
    if ($('#txUnclassified').checked) p.set('unclassified', 'true');
    try {
      const data = await api('/api/transactions?' + p);
      $('#txSummary').innerHTML = `<b>${data.total}</b> giao dịch · tiền vào <b class="pos">${money(data.sum_in)}</b> · tiền ra <b class="neg">${money(data.sum_out)}</b> · chênh lệch <b>${signed(data.sum_in - data.sum_out)}</b>`;
      $('#txTable tbody').innerHTML = data.items.map((t) => `
        <tr data-id="${t.id}" class="${!t.category_code || t.category_code === 'CHUA_PHAN_LOAI' ? 'uncl' : ''}">
          <td><input type="checkbox" value="${t.id}" ${state.selected.has(t.id) ? 'checked' : ''}></td>
          <td>${fmtDate(t.txn_date)}${t.txn_time ? '<br><small>' + t.txn_time.slice(0, 5) + '</small>' : ''}</td>
          <td class="desc">${esc(t.description)}${t.bank_ref ? `<br><small class="tag">${esc(t.bank_ref)}</small>` : ''}${t.labeled_by && t.labeled_by.startsWith('rule') ? '<span class="tag" title="Gán bởi quy tắc">auto</span>' : ''}</td>
          <td class="cp">${esc(t.counterparty)}</td>
          <td class="num pos">${t.amount > 0 ? money(t.amount) : ''}</td>
          <td class="num neg">${t.amount < 0 ? money(-t.amount) : ''}</td>
          <td><div class="catcell"><select class="cat" title="Chọn danh mục – lưu ngay khi đổi">${categoryOptions(t.category_code || 'CHUA_PHAN_LOAI')}</select>
              <button class="icon mkrule" title="Tạo quy tắc tự gán cho các giao dịch giống thế này">+ quy tắc</button></div></td>
          <td><input class="note" value="${esc(t.note)}" placeholder="ghi chú"></td>
          <td><button class="icon del" title="Xoá">✕</button></td>
        </tr>`).join('') || '<tr><td colspan="9">Không có giao dịch.</td></tr>';
      const pages = Math.max(1, Math.ceil(data.total / state.txLimit));
      $('#txPager').innerHTML = pages > 1 ? `<button id="pgPrev" ${state.txPage <= 1 ? 'disabled' : ''}>‹</button> Trang ${state.txPage}/${pages} <button id="pgNext" ${state.txPage >= pages ? 'disabled' : ''}>›</button>` : '';
      const pv = $('#pgPrev'), pn = $('#pgNext');
      if (pv) pv.addEventListener('click', () => { state.txPage--; loadTransactions(); });
      if (pn) pn.addEventListener('click', () => { state.txPage++; loadTransactions(); });
    } catch (e) { onErr(e); }
  }
  $('#txTable').addEventListener('change', async (e) => {
    const tr = e.target.closest('tr'); if (!tr) return; const id = +tr.dataset.id;
    try {
      if (e.target.matches('input[type=checkbox]')) { toggleSel(id, e.target.checked); return; }
      if (e.target.matches('select.cat')) { await api(`/api/transactions/${id}`, { method: 'PATCH', body: { category_code: e.target.value } }); tr.classList.toggle('uncl', e.target.value === 'CHUA_PHAN_LOAI'); toast('Đã gán nhãn'); refreshBadge(); }
      if (e.target.matches('input.note')) { await api(`/api/transactions/${id}`, { method: 'PATCH', body: { note: e.target.value } }); toast('Đã lưu ghi chú'); }
    } catch (err) { onErr(err); }
  });
  $('#txTable').addEventListener('click', async (e) => {
    const tr = e.target.closest('tr'); if (!tr) return; const id = +tr.dataset.id;
    if (e.target.matches('button.del')) {
      if (!confirm('Xoá giao dịch này?')) return;
      try { await api(`/api/transactions/${id}`, { method: 'DELETE' }); tr.remove(); toast('Đã xoá'); } catch (err) { onErr(err); }
    }
    if (e.target.matches('button.mkrule')) {
      const desc = tr.querySelector('td.desc').childNodes[0].textContent.trim();
      const cp = tr.querySelector('td.cp').textContent.trim();
      const suggestion = cp || desc.replace(/^customer\s+/i, '').split(/\s+/).slice(0, 3).join(' ');
      const kw = prompt('Từ khoá để nhận diện các giao dịch tương tự (có thể sửa):', suggestion);
      if (!kw) return;
      const out = tr.querySelector('td.neg').textContent.trim() !== '';
      $('#ruleId').value = ''; $('#ruleName').value = kw; $('#rulePattern').value = kw; $('#ruleMatch').value = 'contains';
      $('#ruleField').value = cp && kw === cp ? 'counterparty' : 'all';
      $('#ruleDirection').value = out ? 'out' : 'in'; $('#rulePriority').value = 50; $('#ruleCategory').value = tr.querySelector('select.cat').value; $('#ruleEnabled').checked = true;
      showTab('rules'); $('#rulePattern').focus();
    }
  });

  // Modal thêm tay
  $('#txAdd').addEventListener('click', () => { $('#fTxDate').value = iso(new Date()); $('#txModal').hidden = false; });
  $('#txModalClose').addEventListener('click', () => ($('#txModal').hidden = true));
  $('#txForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const amt = Math.abs(+$('#fTxAmount').value) * ($('#fTxDir').value === 'out' ? -1 : 1);
    try {
      await api('/api/transactions', { method: 'POST', body: { txn_date: $('#fTxDate').value, amount: amt, description: $('#fTxDesc').value, counterparty: $('#fTxCounterparty').value, category_code: $('#fTxCategory').value || null, note: $('#fTxNote').value } });
      toast('Đã thêm giao dịch'); $('#txModal').hidden = true; $('#txForm').reset(); loadTransactions();
    } catch (err) { onErr(err); }
  });

  // -------------------------------------------------------------- Import
  $('#importFile').addEventListener('change', (e) => { state.importFile = e.target.files[0]; $('#importCommit').disabled = true; $('#importPreviewCard').hidden = true; $('#importResult').textContent = ''; });
  async function doImport(dryRun) {
    if (!state.importFile) return toast('Hãy chọn file sao kê', true);
    const fd = new FormData(); fd.append('file', state.importFile);
    $('#importResult').className = 'note'; $('#importResult').textContent = 'Đang xử lý…';
    try {
      const r = await api('/api/import?dry_run=' + dryRun, { method: 'POST', body: fd });
      $('#importResult').className = 'note ok';
      $('#importResult').innerHTML = `${dryRun ? 'Xem trước' : 'Đã nhập'}: đọc được <b>${r.parsed}</b> giao dịch · ${dryRun ? 'sẽ nhập' : 'đã nhập'} <b>${r.imported}</b> · trùng bỏ qua <b>${r.skipped_duplicates}</b> · tự gán nhãn <b>${r.auto_labeled}</b> · chưa phân loại <b>${r.unlabeled}</b>` +
        (r.meta && (r.meta.owner_name || r.meta.account_no) ? `<br>Sao kê của <b>${esc(r.meta.owner_name || '')}</b> ${r.meta.account_no ? 'STK ' + esc(r.meta.account_no) : ''}${r.meta.opening_balance != null ? ' · số dư đầu kỳ ' + money(r.meta.opening_balance) : ''}${r.meta.closing_balance != null ? ' · cuối kỳ ' + money(r.meta.closing_balance) : ''}` : '') +
        (r.errors.length ? `<br><span class="neg">${r.errors.length} dòng lỗi: ${r.errors.slice(0, 5).map((x) => `dòng ${x.row}: ${esc(x.error)}`).join('; ')}</span>` : '');
      if (dryRun) {
        $('#importCommit').disabled = r.imported === 0;
        $('#importPreviewCard').hidden = false; $('#importPreviewInfo').textContent = `(${r.preview.length} dòng đầu)`;
        $('#importPreviewTable tbody').innerHTML = r.preview.map((t) => `<tr class="${t.duplicate ? 'dup' : (t.category_code === 'CHUA_PHAN_LOAI' ? 'uncl' : '')}"><td>${fmtDate(t.txn_date)}</td><td class="desc">${esc(t.description)}</td><td>${esc(t.counterparty)}</td><td class="num pos">${t.amount > 0 ? money(t.amount) : ''}</td><td class="num neg">${t.amount < 0 ? money(-t.amount) : ''}</td><td class="num">${t.balance_after != null ? money(t.balance_after) : ''}</td><td>${esc(t.category_name)}</td><td>${t.duplicate ? 'Trùng – bỏ qua' : 'Mới'}</td></tr>`).join('');
      } else { $('#importCommit').disabled = true; $('#importPreviewCard').hidden = true; loadCategories(); refreshBadge(); }
    } catch (e) { $('#importResult').className = 'note err'; $('#importResult').textContent = e.message; }
  }
  $('#importPreview').addEventListener('click', () => doImport(true));
  $('#importCommit').addEventListener('click', () => doImport(false));

  // -------------------------------------------------------------- Rules
  async function loadRules() {
    try {
      const rules = await api('/api/rules');
      $('#rulesTable tbody').innerHTML = rules.map((r) => `<tr data-id="${r.id}"><td>${r.priority}</td><td>${esc(r.name)}${r.is_system ? '<span class="tag">mặc định</span>' : ''}</td><td><code>${esc(r.pattern)}</code></td><td>${r.match_type}</td><td>${{ in: 'vào', out: 'ra', any: 'cả hai' }[r.direction]}</td><td>${{ all: 'ND + đối tác', description: 'nội dung', counterparty: 'đối tác' }[r.field || 'all']}</td><td>${esc(r.category_name || r.category_code)}</td><td>${r.enabled ? '✓' : '—'}</td><td><button class="icon edit" title="Sửa">✎</button><button class="icon del" title="Xoá">✕</button></td></tr>`).join('');
      state.rules = rules;
    } catch (e) { onErr(e); }
  }
  $('#rulesTable').addEventListener('click', async (e) => {
    const tr = e.target.closest('tr'); if (!tr) return; const id = +tr.dataset.id; const r = state.rules.find((x) => x.id === id);
    if (e.target.matches('.edit')) {
      $('#ruleFormTitle').textContent = 'Sửa quy tắc #' + id; $('#ruleCancel').hidden = false;
      $('#ruleId').value = id; $('#ruleName').value = r.name; $('#rulePattern').value = r.pattern; $('#ruleMatch').value = r.match_type; $('#ruleDirection').value = r.direction; $('#ruleField').value = r.field || 'all'; $('#rulePriority').value = r.priority; $('#ruleCategory').value = r.category_code; $('#ruleEnabled').checked = !!r.enabled;
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    if (e.target.matches('.del')) { if (!confirm('Xoá quy tắc này?')) return; try { await api('/api/rules/' + id, { method: 'DELETE' }); toast('Đã xoá'); loadRules(); } catch (err) { onErr(err); } }
  });
  const ruleBody = () => ({ name: $('#ruleName').value, pattern: $('#rulePattern').value, match_type: $('#ruleMatch').value, direction: $('#ruleDirection').value, field: $('#ruleField').value, category_code: $('#ruleCategory').value, priority: +$('#rulePriority').value, enabled: $('#ruleEnabled').checked });
  function resetRuleForm() { $('#ruleForm').reset(); $('#ruleId').value = ''; $('#rulePriority').value = 50; $('#ruleFormTitle').textContent = 'Thêm quy tắc'; $('#ruleCancel').hidden = true; $('#ruleTestResult').innerHTML = ''; }
  $('#ruleCancel').addEventListener('click', resetRuleForm);
  $('#ruleForm').addEventListener('submit', async (e) => {
    e.preventDefault(); const id = $('#ruleId').value;
    try { await api(id ? '/api/rules/' + id : '/api/rules', { method: id ? 'PUT' : 'POST', body: ruleBody() }); toast('Đã lưu quy tắc'); resetRuleForm(); loadRules(); } catch (err) { onErr(err); }
  });
  $('#ruleTest').addEventListener('click', async () => {
    const b = ruleBody();
    try { const r = await api(`/api/rules/test?pattern=${encodeURIComponent(b.pattern)}&match_type=${b.match_type}&direction=${b.direction}&field=${b.field}`);
      $('#ruleTestResult').innerHTML = `Khớp <b>${r.count}</b> giao dịch hiện có.` + (r.items.length ? '<ul>' + r.items.slice(0, 8).map((t) => `<li>${fmtDate(t.txn_date)} · ${signed(t.amount)} · ${esc(t.description)}</li>`).join('') + '</ul>' : '');
    } catch (err) { onErr(err); }
  });
  async function applyRules(onlyUnclassified) {
    try { const r = await api('/api/rules/apply', { method: 'POST', body: { only_unclassified: onlyUnclassified } }); $('#applyRulesResult').className = 'note ok'; $('#applyRulesResult').textContent = `Đã quét ${r.scanned} giao dịch, gán nhãn mới cho ${r.updated}.`; loadCategories(); refreshBadge(); } catch (e) { onErr(e); }
  }
  $('#applyRulesUnclassified').addEventListener('click', () => applyRules(true));
  $('#applyRulesAll').addEventListener('click', () => applyRules(false));

  // -------------------------------------------------------------- Categories tab
  async function renderCategoriesTab() {
    await loadCategories();
    let html = ''; let grp = null;
    for (const c of state.categories) {
      if (c.grp !== grp) { grp = c.grp; const g = state.groups.find((x) => x.code === grp); html += `<tr class="grp"><td colspan="4">${esc(g.name)}${g.account ? ' <span class="tag">TK ' + g.account + '</span>' : ''} <small style="font-weight:400;color:#6b7280">${esc(g.description)}</small></td></tr>`; }
      html += `<tr><td><code>${c.code}</code></td><td>${esc(c.name)}${c.is_system ? '' : '<span class="tag">tuỳ chỉnh</span>'}</td><td><small>${esc(c.description)}</small></td><td class="num">${c.txn_count} GD ${c.is_system ? '' : `<button class="icon delcat" data-code="${c.code}">✕</button>`}</td></tr>`;
    }
    $('#catsTable tbody').innerHTML = html;
  }
  $('#catsTable').addEventListener('click', async (e) => {
    if (!e.target.matches('.delcat')) return; const code = e.target.dataset.code;
    if (!confirm(`Xoá danh mục ${code}? Giao dịch thuộc danh mục này sẽ về "Chưa phân loại".`)) return;
    try { await api('/api/categories/' + code, { method: 'DELETE' }); toast('Đã xoá'); renderCategoriesTab(); } catch (err) { onErr(err); }
  });
  $('#catForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('/api/categories', { method: 'POST', body: { code: $('#catCode').value, name: $('#catName').value, grp: $('#catGroup').value, kind: $('#catKind').value, description: $('#catDesc').value } }); toast('Đã thêm danh mục'); $('#catForm').reset(); renderCategoriesTab(); } catch (err) { onErr(err); }
  });

  // -------------------------------------------------------------- Settings
  async function loadSettings() {
    try { const s = await api('/api/settings'); $('#setShopName').value = s.shop_name; $('#setBankName').value = s.bank_name; $('#setAccountNo').value = s.account_no; $('#setOwnerName').value = s.owner_name || ''; $('#setVat').value = s.tax_vat_rate; $('#setPit').value = s.tax_pit_rate; $('#setThreshold').value = s.tax_threshold_year; $('#shopName').textContent = s.shop_name || 'HKT'; } catch (e) { onErr(e); }
  }
  $('#settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('/api/settings', { method: 'PUT', body: { values: { shop_name: $('#setShopName').value, bank_name: $('#setBankName').value, account_no: $('#setAccountNo').value, owner_name: $('#setOwnerName').value, tax_vat_rate: $('#setVat').value, tax_pit_rate: $('#setPit').value, tax_threshold_year: $('#setThreshold').value } } }); toast('Đã lưu cài đặt'); loadSettings(); } catch (err) { onErr(err); }
  });
  $('#deleteAll').addEventListener('click', async () => {
    if (prompt('Gõ XOA để xác nhận xoá toàn bộ giao dịch:') !== 'XOA') return;
    try { const r = await api('/api/transactions?confirm=XOA', { method: 'DELETE' }); toast(`Đã xoá ${r.deleted} giao dịch`); } catch (err) { onErr(err); }
  });

  // -------------------------------------------------------------- Init
  (async () => {
    let [f, t] = periodRange('this-month');
    try {
      const st = await api('/api/stats');
      if (st.last_date && st.last_date < f) { const ym = st.last_date.slice(0, 7); const [y, m] = ym.split('-').map(Number); f = `${ym}-01`; t = iso(new Date(Date.UTC(y, m, 0))); }
      const b = $('#badgeUnclassified'); b.hidden = !st.unclassified; b.textContent = st.unclassified;
    } catch (_) {}
    $('#dashFrom').value = f; $('#dashTo').value = t; $('#txFrom').value = f; $('#txTo').value = t;
    try { await loadCategories(); await loadSettings(); } catch (e) { onErr(e); }
    const tab = location.hash.replace('#', '');
    showTab(['dashboard', 'transactions', 'import', 'rules', 'categories', 'settings'].includes(tab) ? tab : 'dashboard');
  })();
})();
