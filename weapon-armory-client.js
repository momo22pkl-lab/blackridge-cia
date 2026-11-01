'use strict';

(function () {
  const byId = (id) => document.getElementById(id);
  const state = { snapshot: null, sectors: [], admin: null, busy: false };

  function request(event, payload = {}) {
    const socket = window.blackRidgeSocket;
    if (!socket || typeof socket.emit !== 'function') {
      return Promise.reject(new Error('اتصال الخدمة غير جاهز.'));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('انتهت مهلة الاتصال؛ أعد تحميل البيانات قبل تكرار العملية.'));
      }, 20000);
      socket.emit(event, payload, (result) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        if (!result || typeof result !== 'object') return reject(new Error('لم يصل رد صالح من الخادم.'));
        resolve(result);
      });
    });
  }

  function requestId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    return `wa-${Date.now()}-${Math.random().toString(36).slice(2, 14)}`;
  }

  function setStatus(message, type = 'info') {
    const node = byId('wa-status');
    if (!node) return;
    node.textContent = message || '';
    node.hidden = !message;
    node.className = `wa-status wa-status-${type}`;
  }

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function formatDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat('ar', { dateStyle: 'short', timeStyle: 'short' }).format(date);
  }

  function imageOrIcon(item, className = 'wa-weapon-art') {
    const art = make('div', className);
    if (item.imageUrl) {
      const image = document.createElement('img');
      image.src = item.imageUrl;
      image.alt = item.name || 'سلاح';
      image.loading = 'lazy';
      image.referrerPolicy = 'no-referrer';
      image.onerror = () => {
        image.remove();
        const icon = make('i', `fa-solid ${item.icon || 'fa-gun'}`);
        icon.setAttribute('aria-hidden', 'true');
        art.append(icon);
      };
      art.append(image);
    } else {
      const icon = make('i', `fa-solid ${item.icon || 'fa-gun'}`);
      icon.setAttribute('aria-hidden', 'true');
      art.append(icon);
    }
    return art;
  }

  function renderMember(data) {
    state.snapshot = data;
    byId('wa-sector-label').textContent = `القطاع: ${data.sector?.name || data.sector?.id || '—'} · الحد الأعلى 3 أسلحة نشطة`;
    const count = Math.max(0, Number(data.activeCount) || 0);
    const limit = Math.max(1, Number(data.limit) || 3);
    byId('wa-limit-count').textContent = `${count}/${limit}`;
    byId('wa-limit-progress').style.width = `${Math.min(100, (count / limit) * 100)}%`;

    const grid = byId('wa-weapon-grid');
    grid.replaceChildren();
    if (!data.weapons?.length) {
      grid.append(make('div', 'wa-empty', 'لا توجد أسلحة متاحة للاستلام في هذا القطاع حالياً.'));
    } else {
      for (const item of data.weapons) {
        const card = make('article', 'wa-weapon-card');
        card.append(imageOrIcon(item));
        const details = make('div', 'wa-weapon-details');
        details.append(make('h3', '', item.name));
        details.append(make('p', 'wa-stock-label', `المتاح: ${Number(item.availableQuantity) || 0}`));
        const button = make('button', 'wa-button wa-button-primary', 'استلام السلاح');
        button.type = 'button';
        button.disabled = state.busy || count >= limit || Number(item.availableQuantity) < 1;
        button.addEventListener('click', () => issueWeapon(item.id, button));
        details.append(button);
        card.append(details);
        grid.append(card);
      }
    }

    const held = byId('wa-held-list');
    held.replaceChildren();
    if (!data.issues?.length) {
      held.append(make('div', 'wa-empty', 'لا توجد أسلحة مسجلة على عهدتك.'));
    } else {
      for (const issue of data.issues) {
        const row = make('article', 'wa-held-card');
        row.append(imageOrIcon({ name: issue.weaponName, icon: 'fa-gun' }, 'wa-held-art'));
        const details = make('div', 'wa-held-details');
        details.append(make('strong', '', issue.weaponName));
        details.append(make('span', '', `القطاع: ${issue.sectorId || '—'} · الاستلام: ${formatDate(issue.issuedAt)}`));
        row.append(details);
        if (issue.returnAllowed) {
          const button = make('button', 'wa-button wa-button-muted', 'إرجاع');
          button.type = 'button';
          button.disabled = state.busy;
          button.addEventListener('click', () => returnWeapon(issue.id, button));
          row.append(button);
        } else {
          row.append(make('span', 'wa-no-return', 'غير قابل للإرجاع'));
        }
        held.append(row);
      }
    }
  }

  async function issueWeapon(weaponId, button) {
    if (state.busy) return;
    state.busy = true;
    button.disabled = true;
    setStatus('جارٍ التحقق من الحد والمخزون…');
    try {
      const result = await request('weapon-armory:issue', { requestId: requestId(), weaponId });
      setStatus(result.message || (result.ok ? 'تم تسجيل الاستلام.' : 'تعذر تسجيل الاستلام.'), result.ok ? 'success' : 'error');
      await loadMember(true);
    } catch (error) {
      setStatus(error.message, 'error');
    } finally {
      state.busy = false;
      if (state.snapshot) renderMember(state.snapshot);
    }
  }

  async function returnWeapon(issueId, button) {
    if (state.busy) return;
    state.busy = true;
    button.disabled = true;
    setStatus('جارٍ تسجيل الإرجاع…');
    try {
      const result = await request('weapon-armory:return', { requestId: requestId(), issueId });
      setStatus(result.message || (result.ok ? 'تم تسجيل الإرجاع وإعادة الكمية للمخزون.' : 'تعذر تسجيل الإرجاع.'), result.ok ? 'success' : 'error');
      await loadMember(true);
    } catch (error) {
      setStatus(error.message, 'error');
    } finally {
      state.busy = false;
      if (state.snapshot) renderMember(state.snapshot);
    }
  }

  function uniqueWeapons(rows) {
    const seen = new Set();
    return (rows || []).filter((row) => {
      if (seen.has(row.id)) return false;
      seen.add(row.id);
      return true;
    });
  }

  function fillSelect(select, options, getValue, getLabel, emptyLabel) {
    const previous = select.value;
    select.replaceChildren();
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = emptyLabel || 'اختر';
    select.append(empty);
    for (const item of options) {
      const option = document.createElement('option');
      option.value = getValue(item);
      option.textContent = getLabel(item);
      select.append(option);
    }
    if ([...select.options].some((option) => option.value === previous)) select.value = previous;
  }

  function renderSectorOptions(sectors, selectedIds = [], returnAllowedIds = []) {
    const container = byId('wa-sector-options');
    container.replaceChildren();
    for (const sector of sectors) {
      const label = make('div', 'wa-sector-option');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = sector.id;
      checkbox.checked = selectedIds.includes(sector.id);
      const text = make('span', '', sector.name);
      checkbox.dataset.sectorAllowed = 'true';
      const returnLabel = make('label', 'wa-sector-return');
      const returnCheckbox = document.createElement('input');
      returnCheckbox.type = 'checkbox';
      returnCheckbox.value = sector.id;
      returnCheckbox.dataset.sectorReturn = 'true';
      returnCheckbox.checked = returnAllowedIds.includes(sector.id);
      returnCheckbox.disabled = !checkbox.checked;
      checkbox.addEventListener('change', () => {
        returnCheckbox.disabled = !checkbox.checked;
        if (!checkbox.checked) returnCheckbox.checked = false;
      });
      returnLabel.append(returnCheckbox, make('span', '', 'إرجاع'));
      label.append(checkbox, text, returnLabel);
      container.append(label);
    }
  }

  function renderRows(tbody, rows, columns, emptyText) {
    tbody.replaceChildren();
    if (!rows?.length) {
      const tr = document.createElement('tr');
      const td = make('td', 'wa-table-empty', emptyText);
      td.colSpan = columns;
      tr.append(td);
      tbody.append(tr);
      return;
    }
    for (const row of rows) {
      const tr = document.createElement('tr');
      for (const value of row) {
        const td = document.createElement('td');
        if (value instanceof Node) td.append(value);
        else td.textContent = value == null ? '—' : String(value);
        tr.append(td);
      }
      tbody.append(tr);
    }
  }

  function renderAdmin(data) {
    state.admin = data;
    state.sectors = data.sectors || [];
    const admin = byId('wa-admin');
    admin.hidden = !data.canView;
    if (!data.canView) return;
    byId('wa-weapon-form').hidden = !data.canManage;
    byId('wa-stock-form').hidden = !data.canManage;
    byId('wa-admin-title').textContent = data.canManage ? 'إدارة المستودع' : 'بيانات القطاع';

    renderSectorOptions(state.sectors);
    const weapons = uniqueWeapons(data.weapons);
    fillSelect(byId('wa-stock-form').elements.weaponId, weapons, (row) => row.id, (row) => row.name, 'اختر السلاح');
    fillSelect(byId('wa-stock-form').elements.sectorId, state.sectors, (row) => row.id, (row) => row.name, 'اختر القطاع');

    const stockRows = (data.weapons || []).map((item) => {
      let edit = '—';
      if (data.canManage) {
        edit = make('button', 'wa-inline-button', 'تعديل');
        edit.type = 'button';
        edit.dataset.weaponId = item.id;
        edit.addEventListener('click', () => editWeapon(item.id));
      }
      return [item.name, item.sectorId, item.availableQuantity, item.enabled ? 'مفعّل' : 'موقوف', item.returnAllowed ? 'مسموح' : 'غير مسموح', edit];
    });
    renderRows(byId('wa-stock-rows'), stockRows, 6, 'لا توجد أسلحة أو مخزونات مسجلة.');
    renderIssueRows(data.issues || []);
    renderAuditRows(data.audit || []);
  }

  function renderIssueRows(items) {
    renderRows(byId('wa-issue-rows'), items.map((item) => [
      item.memberName,
      item.memberCode,
      item.weaponName,
      item.sectorId || (item.result?.sectorIds || []).join(', '),
      `${item.memberActiveCount} نشط / ${item.memberWeaponCount} إجمالاً`,
      item.status === 'ISSUED' ? 'بعهدة العضو' : 'مُعاد',
      formatDate(item.issuedAt)
    ]), 7, 'لا توجد عمليات استلام ضمن نطاق البحث.');
  }

  function renderAuditRows(items) {
    renderRows(byId('wa-audit-rows'), items.map((item) => [
      formatDate(item.createdAt),
      item.actorName || item.actorCode,
      item.memberName || item.memberCode,
      item.weaponName,
      item.sectorId,
      item.action,
      item.quantity,
      item.outcome,
      item.reason
    ]), 9, 'لا توجد سجلات ضمن نطاق البحث.');
  }

  function editWeapon(weaponId) {
    const weapon = uniqueWeapons(state.admin?.weapons).find((item) => item.id === weaponId);
    if (!weapon) return;
    const form = byId('wa-weapon-form');
    form.elements.id.value = weapon.id;
    form.elements.name.value = weapon.name || '';
    form.elements.imageUrl.value = weapon.imageUrl || '';
    form.elements.icon.value = weapon.icon || 'fa-gun';
    const selected = state.admin.weapons.filter((item) => item.id === weaponId && item.enabled).map((item) => item.sectorId);
    const returnAllowed = state.admin.weapons.filter((item) => item.id === weaponId && item.enabled && item.returnAllowed).map((item) => item.sectorId);
    renderSectorOptions(state.sectors, selected, returnAllowed);
    byId('wa-weapon-cancel').hidden = false;
    form.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  async function loadMember(keepStatus = false) {
    try {
      const result = await request('weapon-armory:member:get');
      if (result.ok) {
        renderMember(result);
        if (!keepStatus) setStatus('', 'info');
      } else if (result.message) {
        setStatus(result.message, 'error');
      }
      return result;
    } catch (error) {
      setStatus(error.message, 'error');
      return { ok: false };
    }
  }

  async function loadAdmin() {
    try {
      const result = await request('weapon-armory:admin:get');
      if (result.ok && result.canView) renderAdmin(result);
      else if (byId('wa-admin')) byId('wa-admin').hidden = true;
      return result;
    } catch (_error) {
      byId('wa-admin').hidden = true;
      return { ok: false };
    }
  }

  async function load() {
    const [member, admin] = await Promise.all([loadMember(), loadAdmin()]);
    if (!member.ok && admin?.canView) {
      byId('wa-sector-label').textContent = admin.canManage
        ? 'عرض القيادة للقطاعات النشطة ضمن الصلاحيات الحالية'
        : `نطاق العرض: ${admin.sectors?.map((sector) => sector.name).join('، ') || 'القطاع المصرّح'}`;
      byId('wa-weapon-grid').replaceChildren(make('div', 'wa-empty', 'لا توجد عضوية قطاعية مرتبطة بالحساب لعرض استلام شخصي.'));
      byId('wa-held-list').replaceChildren(make('div', 'wa-empty', 'لا توجد عهدة شخصية مرتبطة بالحساب.'));
      setStatus('', 'info');
    }
  }

  async function searchAdmin(filters) {
    try {
      const result = await request('weapon-armory:admin:search', filters);
      if (!result.ok) {
        setStatus(result.message || 'تعذر البحث في السجلات.', 'error');
        return;
      }
      if (state.admin) renderAdmin({ ...state.admin, issues: result.issues, audit: result.audit });
      setStatus(`ظهرت ${result.issues.length} عملية استلام/إرجاع و${result.audit.length} نتيجة تدقيق (بحد أقصى 200 لكل قائمة).`, 'success');
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }

  function bindForms() {
    const weaponForm = byId('wa-weapon-form');
    weaponForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const sectorIds = [...byId('wa-sector-options').querySelectorAll('input[data-sector-allowed]:checked')].map((input) => input.value);
      const returnAllowedSectorIds = [...byId('wa-sector-options').querySelectorAll('input[data-sector-return]:checked')].map((input) => input.value);
      const form = weaponForm.elements;
      if (!sectorIds.length) return setStatus('اختر قطاعًا نشطًا واحدًا على الأقل.', 'error');
      if (returnAllowedSectorIds.some((sector) => !sectorIds.includes(sector))) return setStatus('سياسة الإرجاع تتطلب تفعيل القطاع أولاً.', 'error');
      try {
        const result = await request('weapon-armory:weapon:save', {
          requestId: requestId(),
          weapon: {
            id: form.id.value || undefined,
            name: form.name.value,
            imageUrl: form.imageUrl.value,
            icon: form.icon.value
          },
          sectorIds,
          returnAllowedSectorIds
        });
        setStatus(result.message || (result.ok ? 'تم حفظ السلاح والقطاعات.' : 'تعذر حفظ السلاح.'), result.ok ? 'success' : 'error');
        if (result.ok) {
          weaponForm.reset();
          form.icon.value = 'fa-gun';
          byId('wa-weapon-cancel').hidden = true;
          await loadAdmin();
        }
      } catch (error) {
        setStatus(error.message, 'error');
      }
    });

    byId('wa-weapon-cancel').addEventListener('click', () => {
      weaponForm.reset();
      weaponForm.elements.icon.value = 'fa-gun';
      byId('wa-weapon-cancel').hidden = true;
      renderSectorOptions(state.sectors);
    });

    const stockForm = byId('wa-stock-form');
    stockForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = stockForm.elements;
      try {
        const result = await request('weapon-armory:stock:adjust', {
          requestId: requestId(),
          weaponId: form.weaponId.value,
          sectorId: form.sectorId.value,
          delta: Number(form.delta.value),
          reason: form.reason.value
        });
        setStatus(result.message || (result.ok ? `تم تسجيل التعديل. الكمية المتاحة الآن: ${result.availableQuantity}.` : 'تعذر تعديل المخزون.'), result.ok ? 'success' : 'error');
        if (result.ok) {
          stockForm.elements.delta.value = '';
          stockForm.elements.reason.value = '';
          await loadAdmin();
        }
      } catch (error) {
        setStatus(error.message, 'error');
      }
    });

    byId('wa-search-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget.elements;
      await searchAdmin({ search: form.search.value, from: form.from.value, to: form.to.value });
    });
  }

  function boot() {
    const nav = byId('weapon-armory-nav');
    if (!nav || !byId('weapon-armory')) return;
    nav.addEventListener('click', load);
    if (window.blackRidgeSocket && typeof window.blackRidgeSocket.on === 'function') {
      window.blackRidgeSocket.on('connect', () => {
        if (byId('weapon-armory').classList.contains('active')) load();
      });
    }
    bindForms();
    if (byId('weapon-armory').classList.contains('active')) load();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
