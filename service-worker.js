'use strict';

function plainNotificationText(value, maxLength) {
  return String(value == null ? '' : value)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function escapeNotificationSvgText(value, maxLength) {
  return plainNotificationText(value, maxLength)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatSummonsImageDate(value) {
  const date = new Date(value || '');
  if (!Number.isFinite(date.getTime())) return 'غير متاح';
  try {
    return new Intl.DateTimeFormat('ar-JO', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'Asia/Amman'
    }).format(date);
  } catch (_error) {
    return date.toISOString().slice(0, 16).replace('T', ' ');
  }
}

function buildOfficialSummonsImage(card) {
  const record = card && typeof card === 'object' && !Array.isArray(card) ? card : {};
  const issuer = escapeNotificationSvgText(record.issuer || 'BLACK RIDGE CIA', 100);
  const issuerRank = escapeNotificationSvgText(record.issuerRank || '', 60);
  const recipient = escapeNotificationSvgText(record.recipient || 'المستلم', 100);
  const subject = escapeNotificationSvgText(record.subject || 'استدعاء رسمي', 100);
  const reference = escapeNotificationSvgText(record.summonsNumber || record.reference || '—', 48);
  const issuedAt = escapeNotificationSvgText(formatSummonsImageDate(record.issuedAt), 64);
  const message = escapeNotificationSvgText(record.message || '', 86);
  const issuerLine = issuerRank ? issuer + ' · ' + issuerRank : issuer;
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="600" viewBox="0 0 1200 600">',
    '<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#17140c"/><stop offset="0.55" stop-color="#08090a"/><stop offset="1" stop-color="#020304"/></linearGradient><radialGradient id="glow"><stop offset="0" stop-color="#b99246" stop-opacity=".16"/><stop offset="1" stop-color="#b99246" stop-opacity="0"/></radialGradient></defs>',
    '<rect width="1200" height="600" fill="url(#bg)"/><ellipse cx="1060" cy="20" rx="440" ry="300" fill="url(#glow)"/>',
    '<rect x="18" y="18" width="1164" height="564" rx="28" fill="none" stroke="#b99850" stroke-width="3"/><rect x="30" y="30" width="1140" height="540" rx="22" fill="none" stroke="#6f572d" stroke-opacity=".55"/>',
    '<circle cx="108" cy="105" r="58" fill="#070809" stroke="#c6a14e" stroke-width="3"/><circle cx="108" cy="105" r="49" fill="none" stroke="#8a6c33" stroke-width="1.5"/>',
    '<path d="M108 65 L118 91 L146 91 L124 108 L132 137 L108 120 L84 137 L92 108 L70 91 L98 91 Z" fill="#c6a14e"/><text x="108" y="159" text-anchor="middle" fill="#e7d39e" font-family="Arial,sans-serif" font-size="14" font-weight="700">BR CIA</text>',
    '<text x="1090" y="72" text-anchor="end" direction="ltr" fill="#d9bd78" font-family="Arial,sans-serif" font-size="22" font-weight="700" letter-spacing="2">BLACK RIDGE CIA</text>',
    '<text x="1090" y="132" text-anchor="end" direction="rtl" fill="#f0d58c" font-family="Arial,sans-serif" font-size="40" font-weight="700">استدعاء رسمي</text>',
    '<text x="1090" y="166" text-anchor="end" direction="rtl" fill="#a99c7c" font-family="Arial,sans-serif" font-size="18">وثيقة صادرة عن القيادة</text>',
    '<rect x="865" y="45" width="150" height="42" rx="7" fill="#0a0a09" stroke="#b99850" stroke-width="2"/><text x="940" y="73" text-anchor="middle" direction="rtl" fill="#e7ca7b" font-family="Arial,sans-serif" font-size="20" font-weight="700">رسمي</text>',
    '<line x1="64" y1="204" x2="1136" y2="204" stroke="#92743b" stroke-opacity=".6"/>',
    '<text x="1090" y="244" text-anchor="end" direction="rtl" fill="#a8915a" font-family="Arial,sans-serif" font-size="18">الجهة المصدرة</text>',
    '<text x="1090" y="279" text-anchor="end" direction="rtl" fill="#ece6d6" font-family="Arial,sans-serif" font-size="23">' + issuerLine + '</text>',
    '<text x="585" y="244" text-anchor="end" direction="rtl" fill="#a8915a" font-family="Arial,sans-serif" font-size="18">المستلم</text>',
    '<text x="585" y="279" text-anchor="end" direction="rtl" fill="#ece6d6" font-family="Arial,sans-serif" font-size="23">' + recipient + '</text>',
    '<text x="1090" y="337" text-anchor="end" direction="rtl" fill="#a8915a" font-family="Arial,sans-serif" font-size="18">موضوع الاستدعاء</text>',
    '<text x="1090" y="372" text-anchor="end" direction="rtl" fill="#e8cb80" font-family="Arial,sans-serif" font-size="23" font-weight="700">' + subject + '</text>',
    '<text x="585" y="337" text-anchor="end" direction="rtl" fill="#a8915a" font-family="Arial,sans-serif" font-size="18">التاريخ والوقت · رقم الاستدعاء</text>',
    '<text x="585" y="372" text-anchor="end" direction="rtl" fill="#ece6d6" font-family="Arial,sans-serif" font-size="21">' + issuedAt + ' · ' + reference + '</text>',
    '<rect x="64" y="405" width="1072" height="110" rx="12" fill="#0a0b0c" stroke="#705a31" stroke-opacity=".7"/>',
    '<text x="1090" y="438" text-anchor="end" direction="rtl" fill="#a8915a" font-family="Arial,sans-serif" font-size="18">نص الاستدعاء</text>',
    '<text x="1090" y="478" text-anchor="end" direction="rtl" fill="#dedbd2" font-family="Arial,sans-serif" font-size="22">' + message + '</text>',
    '<line x1="64" y1="535" x2="1136" y2="535" stroke="#92743b" stroke-opacity=".6"/>',
    '<text x="1090" y="562" text-anchor="end" direction="rtl" fill="#d8bd7b" font-family="Arial,sans-serif" font-size="17" font-weight="700">BLACK RIDGE CIA  |  عرض تفاصيل الاستدعاء</text>',
    '</svg>'
  ].join('');
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

function buildCommandCircularImage(card) {
  const record = card && typeof card === 'object' && !Array.isArray(card) ? card : {};
  const issuer = escapeNotificationSvgText(record.issuer || 'BLACK RIDGE CIA', 100);
  const issuerRank = escapeNotificationSvgText(record.issuerRank || '', 60);
  const circularTitle = escapeNotificationSvgText(record.title || 'تعميم قيادي', 100);
  const reference = escapeNotificationSvgText(record.circularNumber || record.reference || '—', 48);
  const issuedAt = escapeNotificationSvgText(formatSummonsImageDate(record.issuedAt), 64);
  const message = escapeNotificationSvgText(record.message || '', 92);
  const issuerLine = issuerRank ? issuer + ' · ' + issuerRank : issuer;
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="600" viewBox="0 0 1200 600">',
    '<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#152438"/><stop offset=".55" stop-color="#08111d"/><stop offset="1" stop-color="#03070d"/></linearGradient><radialGradient id="glow"><stop offset="0" stop-color="#7893b4" stop-opacity=".2"/><stop offset="1" stop-color="#7893b4" stop-opacity="0"/></radialGradient></defs>',
    '<rect width="1200" height="600" fill="url(#bg)"/><ellipse cx="1060" cy="20" rx="440" ry="300" fill="url(#glow)"/>',
    '<rect x="18" y="18" width="1164" height="564" rx="22" fill="none" stroke="#8ca7c5" stroke-width="3"/><rect x="30" y="30" width="1140" height="540" rx="17" fill="none" stroke="#526a84" stroke-opacity=".65"/>',
    '<path d="M108 56 L153 81 L153 132 Q153 161 108 180 Q63 161 63 132 L63 81 Z" fill="#09121e" stroke="#9cb2cc" stroke-width="3"/><path d="M82 91 H134 V143 H82 Z M91 104 H125 M91 116 H125 M91 128 H117" fill="none" stroke="#d1dce8" stroke-width="4" stroke-linecap="round"/>',
    '<text x="1090" y="72" text-anchor="end" direction="ltr" fill="#c8d4e1" font-family="Arial,sans-serif" font-size="22" font-weight="700" letter-spacing="2">BLACK RIDGE CIA</text>',
    '<text x="1090" y="132" text-anchor="end" direction="rtl" fill="#e1e9f2" font-family="Arial,sans-serif" font-size="40" font-weight="700">تعميم قيادي</text>',
    '<text x="1090" y="166" text-anchor="end" direction="rtl" fill="#9eafc2" font-family="Arial,sans-serif" font-size="18">توجيه صادر عن القيادة</text>',
    '<rect x="865" y="45" width="150" height="42" rx="4" fill="#101d2c" stroke="#8ca7c5" stroke-width="2"/><text x="940" y="73" text-anchor="middle" direction="rtl" fill="#d3deea" font-family="Arial,sans-serif" font-size="20" font-weight="700">تعميم</text>',
    '<line x1="64" y1="204" x2="1136" y2="204" stroke="#758ba4" stroke-opacity=".65"/>',
    '<text x="1090" y="244" text-anchor="end" direction="rtl" fill="#99aec5" font-family="Arial,sans-serif" font-size="18">الجهة المصدرة</text>',
    '<text x="1090" y="279" text-anchor="end" direction="rtl" fill="#e1e8f0" font-family="Arial,sans-serif" font-size="23">' + issuerLine + '</text>',
    '<text x="585" y="244" text-anchor="end" direction="rtl" fill="#99aec5" font-family="Arial,sans-serif" font-size="18">تاريخ الإصدار · رقم التعميم</text>',
    '<text x="585" y="279" text-anchor="end" direction="rtl" fill="#d3deea" font-family="Arial,sans-serif" font-size="21">' + issuedAt + ' · ' + reference + '</text>',
    '<text x="1090" y="337" text-anchor="end" direction="rtl" fill="#99aec5" font-family="Arial,sans-serif" font-size="18">عنوان التعميم</text>',
    '<text x="1090" y="372" text-anchor="end" direction="rtl" fill="#e1e9f2" font-family="Arial,sans-serif" font-size="23" font-weight="700">' + circularTitle + '</text>',
    '<rect x="64" y="405" width="1072" height="110" rx="8" fill="#07111d" stroke="#536b84" stroke-opacity=".85"/>',
    '<text x="1090" y="438" text-anchor="end" direction="rtl" fill="#99aec5" font-family="Arial,sans-serif" font-size="18">محتوى التعميم</text>',
    '<text x="1090" y="478" text-anchor="end" direction="rtl" fill="#d7e1eb" font-family="Arial,sans-serif" font-size="22">' + message + '</text>',
    '<line x1="64" y1="535" x2="1136" y2="535" stroke="#758ba4" stroke-opacity=".6"/>',
    '<text x="1090" y="562" text-anchor="end" direction="rtl" fill="#c3d0df" font-family="Arial,sans-serif" font-size="17" font-weight="700">BLACK RIDGE CIA  |  قراءة التعميم</text>',
    '</svg>'
  ].join('');
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (_error) {
    payload = { body: event.data ? event.data.text() : '' };
  }

  const notificationType = String(payload.notificationType || '').trim().toUpperCase();
  const isOfficialSummon = notificationType === 'OFFICIAL_SUMMON';
  const isCommandCircular = notificationType === 'COMMAND_CIRCULAR';
  const title = String(payload.title || (isOfficialSummon
    ? 'استدعاء رسمي'
    : isCommandCircular
      ? 'تعميم قيادي'
      : 'BLACK RIDGE CIA')).slice(0, 100);
  const priority = String(payload.priority || 'NORMAL').toUpperCase();
  const options = {
    body: String(payload.body || 'لديك إشعار جديد.').slice(0, 600),
    icon: '/blackridge-push-icon-192.png',
    badge: '/blackridge-push-icon-192.png',
    tag: String(payload.id || ''),
    renotify: false,
    requireInteraction: priority === 'CRITICAL',
    lang: 'ar',
    dir: isOfficialSummon || isCommandCircular ? 'rtl' : 'auto',
    data: {
      url: String(payload.url || '/'),
      notificationId: String(payload.notificationId || ''),
      notificationType
    }
  };
  if (isOfficialSummon && payload.summonsCard && typeof payload.summonsCard === 'object') {
    options.image = buildOfficialSummonsImage(payload.summonsCard);
  }
  if (isCommandCircular && payload.circularCard && typeof payload.circularCard === 'object') {
    options.image = buildCommandCircularImage(payload.circularCard);
  }
  if (isOfficialSummon) {
    options.actions = [{
      action: 'view-summons',
      title: 'عرض تفاصيل الاستدعاء',
      icon: '/blackridge-push-icon-192.png'
    }];
  }
  if (isCommandCircular) {
    options.actions = [{
      action: 'read-circular',
      title: 'قراءة التعميم',
      icon: '/blackridge-push-icon-192.png'
    }];
  }
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL('/', self.location.origin);
  const requestedPath = String(event.notification.data?.url || '/');
  try {
    const parsed = new URL(requestedPath, self.location.origin);
    if (parsed.origin === self.location.origin) target.href = parsed.href;
  } catch (_error) {
    // Keep the default same-origin route.
  }

  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
    const existing = clients.find((client) => {
      try {
        return new URL(client.url).origin === self.location.origin && typeof client.focus === 'function';
      } catch (_error) {
        return false;
      }
    });
    if (!existing) return self.clients.openWindow(target.href);
    if (typeof existing.navigate === 'function') {
      return existing.navigate(target.href).then((navigated) => (navigated || existing).focus());
    }
    return existing.focus();
  }));
});
