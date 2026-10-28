'use strict';

const { normalizePushEndpoint, WebPushStore } = require('./mobile-push-store');

const PRIORITIES = new Set(['NORMAL', 'HIGH', 'CRITICAL']);
const BROADCAST_INTERVAL_MS = 15000;
const lastBroadcastAt = new Map();
const MOBILE_PUSH_HEAD_MARKUP = [
  '<link rel="manifest" href="/manifest.webmanifest">',
  '<link rel="apple-touch-icon" href="/blackridge-push-icon-192.png">',
  '<meta name="theme-color" content="#0b1119">',
  '<meta name="mobile-web-app-capable" content="yes">',
  '<meta name="apple-mobile-web-app-capable" content="yes">',
  '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">',
  '<meta name="apple-mobile-web-app-title" content="BLACK RIDGE CIA">'
].join('\n  ');

function injectMobilePushMarkup(html) {
  let result = String(html == null ? '' : html);
  if (!/<head(?:\s[^>]*)?>/i.test(result) || !/<\/body>/i.test(result)) return result;
  if (!result.includes('href="/manifest.webmanifest"')) {
    result = result.replace(/<head(?:\s[^>]*)?>/i, (tag) => `${tag}\n  ${MOBILE_PUSH_HEAD_MARKUP}`);
  }
  if (!result.includes('src="/mobile-push-client.js"')) {
    result = result.replace(/<\/body>/i, '  <script src="/mobile-push-client.js" defer></script>\n</body>');
  }
  return result;
}

function clean(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function publicVapidKey(value) {
  const key = String(value || '').trim();
  return /^[A-Za-z0-9_-]{80,100}$/.test(key) ? key : '';
}

function createWebPushTransport(options = {}) {
  const env = options.env || process.env;
  const publicKey = publicVapidKey(env.VAPID_PUBLIC_KEY);
  const privateKey = String(env.VAPID_PRIVATE_KEY || '').trim();
  const subject = String(env.VAPID_SUBJECT || '').trim();
  if (!publicKey || !privateKey || !subject) {
    return { configured: false, publicKey: '', sendNotification: null };
  }

  try {
    const webPush = options.webPush || require('web-push');
    webPush.setVapidDetails(subject, publicKey, privateKey);
    return {
      configured: true,
      publicKey,
      sendNotification: webPush.sendNotification.bind(webPush)
    };
  } catch (_error) {
    return { configured: false, publicKey: '', sendNotification: null };
  }
}

function eligiblePushMember(person) {
  return !!person &&
    person.approved !== false &&
    person.serviceApproved !== false &&
    person.suspended !== true &&
    person.securityStatus === 'ACTIVE' &&
    !!clean(person.publicCode, 100);
}

function unitMemberCodes(unit) {
  const values = [
    ...(Array.isArray(unit?.memberCodes) ? unit.memberCodes : []),
    unit?.commanderCode,
    unit?.deputyCode,
    unit?.seniorCommanderCode
  ];
  return values.map((value) => clean(value, 100).toUpperCase()).filter(Boolean);
}

function activeSectorUnits(units) {
  return (Array.isArray(units) ? units : []).filter((unit) =>
    unit && String(unit.status || '').toUpperCase() !== 'ARCHIVED' && clean(unit.sector, 100)
  );
}

function sectorOptions(units, users) {
  const sectors = new Map();
  for (const unit of activeSectorUnits(units)) {
    const name = clean(unit.sector, 100);
    const key = name.toLocaleLowerCase();
    if (!sectors.has(key)) sectors.set(key, name);
  }
  return [...sectors.values()].map((name) => ({
    name,
    memberCount: sectorMembers(users, units, name).length
  })).filter((sector) => sector.memberCount > 0);
}

function sectorMembers(users, units, sectorName) {
  const wantedSector = clean(sectorName, 100).toLocaleLowerCase();
  if (!wantedSector) return [];
  const codes = new Set();
  for (const unit of activeSectorUnits(units)) {
    if (clean(unit.sector, 100).toLocaleLowerCase() !== wantedSector) continue;
    for (const code of unitMemberCodes(unit)) codes.add(code);
  }
  const seen = new Set();
  return (Array.isArray(users) ? users : []).filter((person) => {
    const code = clean(person?.publicCode, 100).toUpperCase();
    if (!eligiblePushMember(person) || !codes.has(code) || seen.has(String(person.id))) return false;
    seen.add(String(person.id));
    return true;
  });
}

function sectorMemberOptions(users, units, sectorName) {
  return sectorMembers(users, units, sectorName).map((person) => ({
    id: String(person.id),
    name: clean(person.identity?.fullName || person.name || person.publicCode || 'عضو', 100),
    publicCode: clean(person.publicCode, 100)
  }));
}

function urgencyForPriority(priority) {
  return priority === 'NORMAL' ? 'normal' : 'high';
}

async function sendBatched(records, sendNotification, payload, priority, removeExpired) {
  let accepted = 0;
  let failed = 0;
  for (let index = 0; index < records.length; index += 20) {
    const batch = records.slice(index, index + 20);
    const results = await Promise.allSettled(batch.map((record) => Promise.resolve().then(() =>
      sendNotification(record.subscription, JSON.stringify(payload), {
        TTL: 900,
        urgency: urgencyForPriority(priority)
      })
    )));
    for (let offset = 0; offset < results.length; offset += 1) {
      const result = results[offset];
      if (result.status === 'fulfilled') {
        accepted += 1;
        continue;
      }
      failed += 1;
      const statusCode = Number(result.reason?.statusCode);
      if (statusCode === 404 || statusCode === 410) {
        try {
          await removeExpired(records[index + offset].userId, records[index + offset].subscription.endpoint);
        } catch (_error) {
          // Keep processing the rest of the batch if stale-subscription cleanup fails.
        }
      }
    }
  }
  return { accepted, failed };
}

function registerMobilePushSocket(socket, context) {
  const reply = (callback, value) => {
    if (typeof callback === 'function') callback(value);
    return value;
  };
  const fail = (callback, message) => reply(callback, { ok: false, message });
  const getActor = () => context.requireSocketUser(socket);
  const getUnits = () => context.getUnits();

  socket.on('mobile-push:info', (payload, callback) => {
    const actor = getActor();
    if (!actor) return fail(callback, 'يجب تسجيل الدخول إلى الخدمة أولاً.');
    const canSend = context.isLeadership(actor);
    return reply(callback, {
      ok: true,
      configured: context.transport.configured === true,
      publicKey: context.transport.configured ? context.transport.publicKey : '',
      canSend,
      sectors: canSend ? sectorOptions(getUnits(), context.getUsers()) : []
    });
  });

  socket.on('mobile-push:members', (payload, callback) => {
    const actor = getActor();
    if (!actor) return fail(callback, 'يجب تسجيل الدخول إلى الخدمة أولاً.');
    if (!context.isLeadership(actor)) return fail(callback, 'قائمة مستلمي الإشعارات متاحة للقيادة فقط.');
    if (context.transport.configured !== true) return fail(callback, 'إشعارات الهاتف غير مهيأة على الخادم بعد.');

    const requestedSector = clean(payload?.sector, 100);
    const sector = sectorOptions(getUnits(), context.getUsers()).find((item) =>
      item.name.toLocaleLowerCase() === requestedSector.toLocaleLowerCase()
    );
    if (!sector) return fail(callback, 'القطاع المحدد غير موجود أو لا يحتوي أفراداً مؤهلين.');

    return reply(callback, {
      ok: true,
      sector: sector.name,
      members: sectorMemberOptions(context.getUsers(), getUnits(), sector.name)
    });
  });

  socket.on('mobile-push:subscribe', async (payload, callback) => {
    const actor = getActor();
    if (!actor) return fail(callback, 'يجب تسجيل الدخول إلى الخدمة أولاً.');
    if (context.transport.configured !== true) return fail(callback, 'إشعارات الهاتف غير مهيأة على الخادم بعد.');
    try {
      await context.store.saveSubscription(actor.id, payload?.subscription);
      return reply(callback, { ok: true });
    } catch (_error) {
      return fail(callback, 'تعذر حفظ اشتراك هذا الجهاز. تحقق من دعم المتصفح ثم أعد المحاولة.');
    }
  });

  socket.on('mobile-push:unsubscribe', async (payload, callback) => {
    const actor = getActor();
    if (!actor) return fail(callback, 'يجب تسجيل الدخول إلى الخدمة أولاً.');
    const endpoint = normalizePushEndpoint(payload?.endpoint);
    if (!endpoint) return fail(callback, 'اشتراك هذا الجهاز غير صالح.');
    try {
      const removed = await context.store.removeSubscription(actor.id, endpoint);
      return reply(callback, { ok: true, removed });
    } catch (_error) {
      return fail(callback, 'تعذر إيقاف اشتراك هذا الجهاز على الخادم.');
    }
  });

  socket.on('mobile-push:send-sector', async (payload, callback) => {
    const actor = getActor();
    if (!actor) return fail(callback, 'يجب تسجيل الدخول إلى الخدمة أولاً.');
    if (!context.isLeadership(actor)) return fail(callback, 'إرسال إشعارات القطاع متاح لـ CIA CHIEF وSUPREME COMMANDER فقط.');
    if (context.transport.configured !== true || typeof context.transport.sendNotification !== 'function') {
      return fail(callback, 'إشعارات الهاتف غير مهيأة على الخادم بعد.');
    }

    const title = clean(payload?.title, 100);
    const message = clean(payload?.message, 600);
    const requestedSector = clean(payload?.sector, 100);
    const audience = String(payload?.audience || 'SECTOR').trim().toUpperCase();
    const requestedMemberId = clean(payload?.memberId, 100);
    const priority = String(payload?.priority || 'NORMAL').trim().toUpperCase();
    if (!title || !message || !requestedSector || !PRIORITIES.has(priority) ||
        !['SECTOR', 'MEMBER'].includes(audience) || (audience === 'MEMBER' && !requestedMemberId)) {
      return fail(callback, 'أدخل القطاع والعنوان والرسالة وحدد مستلماً وأولوية صالحة.');
    }

    const options = sectorOptions(getUnits(), context.getUsers());
    const sector = options.find((item) => item.name.toLocaleLowerCase() === requestedSector.toLocaleLowerCase());
    if (!sector) return fail(callback, 'القطاع المحدد غير موجود أو لا يحتوي أفراداً مؤهلين.');

    const nowMs = Date.now();
    const lastSentAt = lastBroadcastAt.get(String(actor.id)) || 0;
    if (nowMs - lastSentAt < BROADCAST_INTERVAL_MS) {
      return fail(callback, 'انتظر قليلاً قبل إرسال إشعار آخر للقطاع.');
    }
    lastBroadcastAt.set(String(actor.id), nowMs);

    const eligibleRecipients = sectorMembers(context.getUsers(), getUnits(), sector.name);
    if (!eligibleRecipients.length) return fail(callback, 'لا يوجد أفراد مؤهلون في هذا القطاع.');
    let recipients = eligibleRecipients;
    let targetMember = null;
    if (audience === 'MEMBER') {
      targetMember = eligibleRecipients.find((person) => String(person.id) === requestedMemberId);
      if (!targetMember) return fail(callback, 'الشخص المحدد غير مؤهل أو لا ينتمي إلى القطاع المختار.');
      recipients = [targetMember];
    }

    let subscriptions;
    try {
      subscriptions = await context.store.listForUsers(recipients.map((person) => person.id));
    } catch (_error) {
      return fail(callback, 'تعذر تحميل اشتراكات الأجهزة. لم يُرسل الإشعار.');
    }
    if (!subscriptions.length) {
      return fail(callback, 'لم يُرسل الإشعار؛ لا يملك أي فرد في هذا القطاع اشتراكاً مفعلاً على جهازه.');
    }

    const payloadForDevice = {
      id: context.makeId('PUSH'),
      title,
      body: message,
      priority,
      sector: sector.name,
      url: '/'
    };
    let delivery;
    try {
      delivery = await sendBatched(
        subscriptions,
        context.transport.sendNotification,
        payloadForDevice,
        priority,
        (userId, endpoint) => context.store.removeExpiredSubscription(userId, endpoint)
      );
    } catch (_error) {
      return fail(callback, 'تعذر إرسال الإشعار إلى خدمة Web Push.');
    }

    if (typeof context.addAuditLog === 'function') {
      try {
        context.addAuditLog(
          'إرسال إشعار هاتف',
          actor,
          null,
          `القطاع: ${sector.name}؛ المستهدف: ${audience === 'MEMBER' ? `الفرد ${targetMember.publicCode}` : 'كل أفراد القطاع'}؛ الأولوية: ${priority}؛ الأجهزة المقبولة: ${delivery.accepted}؛ الفاشلة: ${delivery.failed}.`
        );
        if (typeof context.saveState === 'function') await context.saveState();
      } catch (_error) {
        // Delivery already happened; an audit persistence failure must not report it as unsent.
      }
    }

    return reply(callback, {
      ok: true,
      sector: sector.name,
      audience,
      targetMemberName: targetMember
        ? clean(targetMember.identity?.fullName || targetMember.name || targetMember.publicCode || 'عضو', 100)
        : '',
      priority,
      recipientCount: recipients.length,
      subscribedMembers: new Set(subscriptions.map((item) => item.userId)).size,
      noSubscriptionMembers: Math.max(0, recipients.length - new Set(subscriptions.map((item) => item.userId)).size),
      deviceCount: subscriptions.length,
      acceptedByPushService: delivery.accepted,
      failed: delivery.failed
    });
  });
}

module.exports = {
  PRIORITIES,
  BROADCAST_INTERVAL_MS,
  MOBILE_PUSH_HEAD_MARKUP,
  clean,
  injectMobilePushMarkup,
  publicVapidKey,
  createWebPushTransport,
  eligiblePushMember,
  unitMemberCodes,
  activeSectorUnits,
  sectorOptions,
  sectorMembers,
  sectorMemberOptions,
  urgencyForPriority,
  sendBatched,
  registerMobilePushSocket,
  WebPushStore
};
