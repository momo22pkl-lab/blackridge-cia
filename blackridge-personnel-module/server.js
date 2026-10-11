'use strict';

/**
 * BLACKRIDGE CITY CIA — Personnel Actions demo module.
 * IMPORTANT: X-Demo-Role is intentionally a demo-only role selector. Replace it
 * with the authenticated role from the existing project's server-side session
 * before production use. Do not use this demo identity model as real security.
 */
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const REPORTS_DIR = path.join(DATA_DIR, 'reports');
const DATA_FILE = path.join(DATA_DIR, 'state.json');
const ROLES = ['CIA CHIEF', 'SENIOR COMMANDER', 'HIGH COMMANDER', 'AGENT'];
const REPORT_READERS = ['CIA CHIEF', 'SENIOR COMMANDER'];
const WARNING_CREATORS = ['CIA CHIEF', 'SENIOR COMMANDER', 'HIGH COMMANDER'];
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024, files: 1 } });

fs.mkdirSync(REPORTS_DIR, { recursive: true });
app.use(express.json({ limit: '1mb' }));

function seededState() {
  return {
    people: [
      { code: 'AG-1042', name: 'اسم تجريبي — 01', rank: 'AGENT', warnings: 0, suspension: null, dismissed: false, dismissalReason: null },
      { code: 'AG-1088', name: 'اسم تجريبي — 02', rank: 'AGENT', warnings: 1, suspension: null, dismissed: false, dismissalReason: null },
      { code: 'HC-2011', name: 'هوية سرية — 03', rank: 'HIGH COMMANDER', warnings: 0, suspension: null, dismissed: false, dismissalReason: null },
      { code: 'SC-3007', name: 'هوية سرية — 04', rank: 'SENIOR COMMANDER', warnings: 0, suspension: null, dismissed: false, dismissalReason: null },
      { code: 'AG-1135', name: 'اسم تجريبي — 05', rank: 'AGENT', warnings: 0, suspension: null, dismissed: false, dismissalReason: null }
    ],
    warnings: [
      { id: 'WARN-DEMO-001', targetCode: 'AG-1088', targetRank: 'AGENT', reason: 'مخالفة التعليمات', note: 'سجل تجريبي للمعاينة فقط.', createdByRole: 'SENIOR COMMANDER', createdAt: Date.now() - 3600000 }
    ],
    suspensionsLog: [],
    dismissalsLog: [],
    reports: [],
    inquiries: [],
    sequence: 1
  };
}

function readState() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      const state = seededState();
      fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
      return state;
    }
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const defaults = seededState();
    for (const key of Object.keys(defaults)) if (!Array.isArray(parsed[key]) && key !== 'sequence') parsed[key] = defaults[key];
    if (!Number.isInteger(parsed.sequence)) parsed.sequence = 1;
    if (!Array.isArray(parsed.people)) parsed.people = defaults.people;
    return parsed;
  } catch (error) {
    console.error('[BLACKRIDGE] Could not read state file:', error.message);
    return seededState();
  }
}
let state = readState();

function saveState() {
  const temp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2));
  fs.renameSync(temp, DATA_FILE);
}
function newId(prefix) {
  const random = crypto.randomBytes(3).toString('hex').toUpperCase();
  const serial = String(state.sequence++).padStart(4, '0');
  saveState();
  return `${prefix}-${serial}-${random}`;
}
function expireSuspensions() {
  let changed = false;
  const now = Date.now();
  for (const p of state.people) {
    if (p.suspension && Number(p.suspension.endsAt) <= now) {
      state.suspensionsLog.push({ type: 'انتهاء تلقائي للإيقاف', targetCode: p.code, at: now, byRole: 'SYSTEM' });
      p.suspension = null;
      changed = true;
    }
  }
  if (changed) saveState();
}
function roleOf(req) {
  const role = String(req.get('X-Demo-Role') || 'CIA CHIEF').toUpperCase();
  return ROLES.includes(role) ? role : 'AGENT';
}
function codeOf(req) {
  const code = String(req.get('X-Demo-Code') || 'AG-1042').toUpperCase();
  return state.people.some(p => p.code === code) ? code : 'AG-1042';
}
function actorOf(req) {
  // Demo identity only; the integration prompt requires using the existing authenticated user ID.
  const supplied = String(req.get('X-Demo-Actor') || '').trim();
  if (supplied) return supplied.slice(0, 120);
  const role = roleOf(req);
  return ({ 'CIA CHIEF': 'DEMO-CHIEF-001', 'SENIOR COMMANDER': 'DEMO-SENIOR-001', 'HIGH COMMANDER': 'DEMO-HIGH-001', 'AGENT': codeOf(req) })[role];
}
function requireRoles(...allowed) {
  return (req, res, next) => {
    req.demoRole = roleOf(req);
    if (!allowed.includes(req.demoRole)) return res.status(403).json({ error: 'ليس لديك صلاحية لتنفيذ هذا الإجراء.' });
    next();
  };
}
function getPerson(code) { return state.people.find(p => p.code === String(code || '').toUpperCase()); }
function canReadReports(role) { return REPORT_READERS.includes(role); }
function publicPerson(p, role) {
  const hasWarning = state.warnings.some(w => w.targetCode === p.code);
  if (role === 'AGENT') return { code: p.code, hasWarning, warningCount: p.warnings, dismissed: Boolean(p.dismissed), suspended: Boolean(p.suspension) };
  const result = { code: p.code, rank: p.rank, hasWarning, warningCount: p.warnings, dismissed: Boolean(p.dismissed), suspended: Boolean(p.suspension) };
  if (role === 'CIA CHIEF') {
    result.name = p.name;
    result.dismissalReason = p.dismissalReason || null;
  }
  if (role === 'CIA CHIEF' || role === 'SENIOR COMMANDER') {
    result.suspensionByRole = p.suspension ? p.suspension.byRole : null;
    result.suspensionEndsAt = p.suspension ? p.suspension.endsAt : null;
    result.suspensionReason = p.suspension ? p.suspension.reason : null;
  }
  return result;
}
function safeWarning(w, role) {
  const item = { id: w.id, targetCode: w.targetCode, targetRank: w.targetRank, reason: w.reason, createdAt: w.createdAt };
  if (role === 'CIA CHIEF' || role === 'SENIOR COMMANDER') {
    item.note = w.note || '';
    item.createdByRole = w.createdByRole;
  }
  return item;
}
function safeReport(r, role) {
  const item = { id: r.id, warningId: r.warningId, targetCode: r.targetCode, targetRank: r.targetRank,
    reason: r.reason, reportBody: r.reportBody, createdByRole: r.createdByRole, createdAt: r.createdAt,
    fileName: r.fileName };
  if (role === 'CIA CHIEF') {
    const p = getPerson(r.targetCode);
    item.targetName = p ? p.name : 'هوية غير متاحة';
  }
  return item;
}
function fail(res, status, error) { return res.status(status).json({ error }); }

app.get('/api/health', (_req, res) => res.json({ ok: true, module: 'blackridge-personnel-actions', version: '1.0.0' }));

app.get('/api/state', (req, res) => {
  expireSuspensions();
  const role = roleOf(req);
  const result = {
    role,
    people: state.people.map(p => publicPerson(p, role)),
    totals: {
      personnel: state.people.length,
      warnings: state.people.reduce((n, p) => n + (Number(p.warnings) || 0), 0),
      suspensions: state.people.filter(p => p.suspension).length,
      dismissed: state.people.filter(p => p.dismissed).length
    },
    warnings: [], reports: [], suspensionsLog: [], dismissalsLog: [], inquiries: []
  };
  if (role === 'CIA CHIEF') {
    result.warnings = state.warnings.map(w => ({ ...safeWarning(w, role), targetName: getPerson(w.targetCode)?.name || 'هوية غير متاحة' })).sort((a,b)=>b.createdAt-a.createdAt);
    result.suspensionsLog = state.suspensionsLog.map(x => ({ ...x, targetName: getPerson(x.targetCode)?.name || null })).sort((a,b)=>b.at-a.at);
    result.dismissalsLog = state.dismissalsLog.map(x => ({ ...x, targetName: getPerson(x.targetCode)?.name || null })).sort((a,b)=>b.at-a.at);
  } else if (role === 'SENIOR COMMANDER') {
    result.warnings = state.warnings.map(w => safeWarning(w, role)).sort((a,b)=>b.createdAt-a.createdAt);
  } else if (role === 'HIGH COMMANDER') {
    result.warnings = state.warnings.filter(w => w.createdByRole === role).map(w => safeWarning(w, role)).sort((a,b)=>b.createdAt-a.createdAt);
  }
  if (canReadReports(role)) {
    result.reports = state.reports.map(r => safeReport(r, role)).sort((a,b)=>b.createdAt-a.createdAt);
    result.inquiries = state.inquiries.map(q => ({ ...q, targetName: role === 'CIA CHIEF' ? (getPerson(q.targetCode)?.name || null) : undefined })).sort((a,b)=>b.createdAt-a.createdAt);
  }
  return res.json(result);
});

app.get('/api/status/:code', (req, res) => {
  expireSuspensions();
  const viewerRole = roleOf(req);
  if (viewerRole === 'AGENT' && String(req.params.code).toUpperCase() !== codeOf(req)) return fail(res, 403, 'يمكنك الاطلاع على حالة حسابك فقط.');
  const p = getPerson(req.params.code);
  if (!p) return fail(res, 404, 'الكود العسكري غير موجود.');
  return res.json({ code: p.code, dismissed: Boolean(p.dismissed), dismissalReason: roleOf(req) === 'CIA CHIEF' ? p.dismissalReason : null,
    suspension: p.suspension ? { endsAt: p.suspension.endsAt, reason: p.suspension.reason, id: p.suspension.id,
      remainingMs: Math.max(0, p.suspension.endsAt - Date.now()) } : null,
    hasWarning: state.warnings.some(w => w.targetCode === p.code), warningCount: p.warnings });
});

app.post('/api/warnings', requireRoles(...WARNING_CREATORS), (req, res) => {
  const p = getPerson(req.body.code);
  if (!p) return fail(res, 404, 'الكود العسكري غير موجود.');
  if (p.dismissed) return fail(res, 409, 'لا يمكن إصدار تحذير لحساب مفصول.');
  const reason = String(req.body.reason || '').trim();
  if (!reason) return fail(res, 400, 'سبب التحذير مطلوب.');
  p.warnings = (Number(p.warnings) || 0) + 1;
  const warning = { id: newId('WARN'), targetCode: p.code, targetRank: p.rank, reason,
    note: String(req.body.note || '').trim().slice(0, 5000), createdByRole: req.demoRole, createdByActorId: actorOf(req), createdAt: Date.now() };
  state.warnings.push(warning);
  saveState();
  return res.status(201).json({ warning: safeWarning(warning, req.demoRole), allowReport: ['HIGH COMMANDER', 'SENIOR COMMANDER'].includes(req.demoRole) });
});

app.post('/api/suspensions', requireRoles('CIA CHIEF', 'SENIOR COMMANDER'), (req, res) => {
  expireSuspensions();
  const p = getPerson(req.body.code);
  if (!p) return fail(res, 404, 'الكود العسكري غير موجود.');
  if (p.dismissed) return fail(res, 409, 'الحساب مفصول بالفعل.');
  const seconds = Number(req.body.durationSeconds);
  if (!Number.isFinite(seconds) || seconds < 60 || seconds > 604800) return fail(res, 400, 'مدة الإيقاف يجب أن تكون بين دقيقة و7 أيام.');
  const reason = String(req.body.reason || '').trim();
  if (!reason) return fail(res, 400, 'سبب الإيقاف مطلوب.');
  p.suspension = { id: newId('SUSP'), endsAt: Date.now() + seconds * 1000, byRole: req.demoRole, byActorId: actorOf(req), reason, note: String(req.body.note || '').trim().slice(0, 5000), createdAt: Date.now() };
  state.suspensionsLog.push({ id: p.suspension.id, type: 'إيقاف مؤقت', targetCode: p.code, byRole: req.demoRole, at: Date.now(), endsAt: p.suspension.endsAt });
  saveState();
  return res.status(201).json({ code: p.code, suspension: p.suspension });
});

app.post('/api/suspensions/:code/lift', (req, res) => {
  expireSuspensions();
  const role = roleOf(req);
  if (!['CIA CHIEF', 'SENIOR COMMANDER'].includes(role)) return fail(res, 403, 'رفع الإيقاف غير مسموح لرتبتك.');
  const p = getPerson(req.params.code);
  if (!p) return fail(res, 404, 'الكود العسكري غير موجود.');
  if (!p.suspension) return fail(res, 409, 'لا يوجد إيقاف فعال.');
  if (role === 'SENIOR COMMANDER' && p.suspension.byActorId !== actorOf(req)) return fail(res, 403, 'يمكنك رفع الإيقاف الذي أصدرته أنت فقط.');
  const old = p.suspension;
  p.suspension = null;
  state.suspensionsLog.push({ id: old.id, type: 'رفع يدوي للإيقاف', targetCode: p.code, byRole: role, at: Date.now() });
  saveState();
  return res.json({ ok: true, code: p.code });
});

app.post('/api/dismissals/:code', requireRoles('CIA CHIEF'), (req, res) => {
  const p = getPerson(req.params.code);
  if (!p) return fail(res, 404, 'الكود العسكري غير موجود.');
  if (p.dismissed) return fail(res, 409, 'هذا الفرد مفصول بالفعل.');
  const reason = String(req.body.reason || '').trim();
  if (!reason) return fail(res, 400, 'سبب الفصل مطلوب للتوثيق.');
  p.dismissed = true;
  p.dismissalReason = reason.slice(0, 3000);
  p.dismissedAt = Date.now();
  p.suspension = null;
  state.dismissalsLog.push({ id: newId('DISM'), targetCode: p.code, reason: p.dismissalReason, byRole: 'CIA CHIEF', at: p.dismissedAt });
  saveState();
  return res.status(201).json({ ok: true, code: p.code, dismissed: true });
});

app.post('/api/reports', upload.single('pdf'), (req, res) => {
  const role = roleOf(req);
  if (!['HIGH COMMANDER', 'SENIOR COMMANDER'].includes(role)) return fail(res, 403, 'إنشاء تقارير التحذيرات متاح للهاي كوماندر والسينيور كوماندر فقط.');
  const warning = state.warnings.find(w => w.id === String(req.body.warningId || '') && w.createdByRole === role && w.createdByActorId === actorOf(req));
  if (!warning) return fail(res, 404, 'التحذير غير موجود أو لا يتبع الجهة المرسلة.');
  const reportBody = String(req.body.reportBody || '').trim();
  if (reportBody.length < 10) return fail(res, 400, 'اكتب تفاصيل التقرير بشكل أوضح (10 أحرف على الأقل).');
  if (!req.file || req.file.mimetype !== 'application/pdf' || req.file.buffer.slice(0, 5).toString() !== '%PDF-') return fail(res, 400, 'ملف PDF الرسمي مطلوب.');
  const id = newId('RPT');
  const fileName = `${id}.pdf`;
  const filePath = path.join(REPORTS_DIR, fileName);
  fs.writeFileSync(filePath, req.file.buffer);
  const report = { id, warningId: warning.id, targetCode: warning.targetCode, targetRank: warning.targetRank,
    reason: warning.reason, reportBody, createdByRole: role, createdAt: Date.now(), fileName };
  state.reports.push(report);
  saveState();
  return res.status(201).json({ ok: true, report: { ...report, pdfUrl: `/api/reports/${id}/pdf` } });
});

app.get('/api/reports', requireRoles('CIA CHIEF', 'SENIOR COMMANDER'), (req, res) => {
  return res.json({ reports: state.reports.map(r => safeReport(r, req.demoRole)).sort((a,b)=>b.createdAt-a.createdAt) });
});
app.get('/api/reports/:id/pdf', requireRoles('CIA CHIEF', 'SENIOR COMMANDER'), (req, res) => {
  const report = state.reports.find(r => r.id === req.params.id);
  if (!report) return fail(res, 404, 'التقرير غير موجود.');
  const filePath = path.join(REPORTS_DIR, path.basename(report.fileName));
  if (!fs.existsSync(filePath)) return fail(res, 404, 'ملف PDF غير موجود على هذا الخادم.');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${report.id}.pdf"`);
  fs.createReadStream(filePath).pipe(res);
});

app.post('/api/inquiries', (req, res) => {
  const code = getPerson(req.body.code);
  if (!code) return fail(res, 404, 'الكود العسكري غير موجود.');
  if (roleOf(req) === 'AGENT' && code.code !== codeOf(req)) return fail(res, 403, 'يمكنك إرسال استفسار عن حسابك فقط.');
  const body = String(req.body.body || '').trim();
  const subject = String(req.body.subject || 'استفسار').trim();
  if (body.length < 4) return fail(res, 400, 'اكتب تفاصيل الاستفسار.');
  const inquiry = { id: newId('INQ'), targetCode: code.code, subject: subject.slice(0, 150), body: body.slice(0, 4000), status: 'قيد المراجعة', createdAt: Date.now() };
  state.inquiries.push(inquiry);
  saveState();
  return res.status(201).json({ ok: true, id: inquiry.id });
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'مسار API غير موجود.' }));
app.use((err, _req, res, _next) => {
  console.error('[BLACKRIDGE] Request error:', err.message);
  if (err instanceof multer.MulterError) return res.status(400).json({ error: 'حجم ملف التقرير أكبر من المسموح أو الملف غير صالح.' });
  return res.status(500).json({ error: 'حدث خطأ داخلي. راجع سجل الخادم.' });
});
app.get('/brand-seal.jpg', (_req, res) => {
  res.sendFile(path.join(PUBLIC, 'blackridge-official-seal.jpg'));
});
app.use(express.static(PUBLIC));
app.get('*', (_req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[BLACKRIDGE] Personnel Actions demo running on port ${PORT}`);
  console.log('[BLACKRIDGE] Demo only: replace X-Demo-Role with the real authenticated role before production.');
});
