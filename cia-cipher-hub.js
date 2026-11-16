'use strict';

const HUB_MARKER = 'data-cia-cipher-hub';
const NAV_MARKER = '      <li id="morse-nav" class="nav-btn" onclick="openMorseTranslator()">';
const CONTENT_MARKER = '  <div class="content-area">';
const NAV_ITEM = '      <li id="cia-cipher-hub-nav" class="nav-btn" role="button" tabindex="0" aria-controls="cia-cipher-hub-view" onclick="openCiaCipherHub()"><i class="fa-solid fa-shield-halved" aria-hidden="true"></i> شفرات الـCIA</li>';
const HUB_PANE = [
  '    <div id="cia-cipher-hub-view" class="view-pane cia-cipher-hub-view" aria-label="شفرات الـCIA" data-cia-cipher-hub>',
  '      <section class="cia-cipher-hub" dir="rtl" aria-labelledby="cia-cipher-hub-title">',
  '        <header class="cia-cipher-hub__header">',
  '          <div><span class="cia-cipher-hub__eyebrow">BLACKRIDGE CIA / SECURE SYSTEMS</span><h1 id="cia-cipher-hub-title">شفرات الـCIA</h1><p>اختر النظام المطلوب للدخول إلى أداته الحالية.</p></div>',
  '          <span class="cia-cipher-hub__seal" aria-hidden="true"><i class="fa-solid fa-shield-halved"></i></span>',
  '        </header>',
  '        <div class="cia-cipher-hub__grid">',
  '          <article class="cia-cipher-card" data-cia-cipher-card="morse">',
  '            <span class="cia-cipher-card__icon" aria-hidden="true"><i class="fa-solid fa-tower-broadcast"></i></span>',
  '            <div class="cia-cipher-card__body"><span class="cia-cipher-card__eyebrow">SIGNAL TRANSLATION</span><h2>شفرة مورس</h2><p>حوّل النص الإنجليزي إلى مورس أو فكّ الرموز ضمن نظام مورس الحالي.</p></div>',
  '            <button type="button" class="cia-cipher-card__action" onclick="openCiaCipherTarget(\'morse\')">الدخول إلى شفرة مورس <i class="fa-solid fa-arrow-left" aria-hidden="true"></i></button>',
  '          </article>',
  '          <article class="cia-cipher-card" data-cia-cipher-card="intelligence">',
  '            <span class="cia-cipher-card__icon" aria-hidden="true"><i class="fa-solid fa-key"></i></span>',
  '            <div class="cia-cipher-card__body"><span class="cia-cipher-card__eyebrow">PRIVATE MESSAGE TOOL</span><h2>الشفرة الاستخباراتية</h2><p>شفّر الرسائل وفكّها باستخدام أداة BLACKRIDGE الاستخباراتية الحالية.</p></div>',
  '            <button type="button" class="cia-cipher-card__action" onclick="openCiaCipherTarget(\'intelligence\')">فتح الشفرة الاستخباراتية <i class="fa-solid fa-arrow-left" aria-hidden="true"></i></button>',
  '          </article>',
  '          <article class="cia-cipher-card" data-cia-cipher-card="puzzle">',
  '            <span class="cia-cipher-card__icon" aria-hidden="true"><i class="fa-solid fa-puzzle-piece"></i></span>',
  '            <div class="cia-cipher-card__body"><span class="cia-cipher-card__eyebrow">FIELD CHALLENGES</span><h2>شفرة البازل</h2><p>أنشئ الألغاز وحلّها وشارك تحدياتك عبر الروابط العامة الحالية.</p></div>',
  '            <button type="button" class="cia-cipher-card__action" onclick="openCiaCipherTarget(\'puzzle\')">فتح نظام البازل <i class="fa-solid fa-arrow-left" aria-hidden="true"></i></button>',
  '          </article>',
  '        </div>',
  '      </section>',
  '    </div>'
].join('\n');

function insertBackButton(html, paneId) {
  if (html.includes('data-cia-cipher-back="' + paneId + '"')) return html;
  const paneMarker = 'id="' + paneId + '"';
  const paneStart = html.indexOf(paneMarker);
  if (paneStart < 0) return html;
  const tagEnd = html.indexOf('>', paneStart);
  if (tagEnd < 0) return html;
  const button = '\n      <button type="button" class="cia-cipher-hub-back" data-cia-cipher-back="' + paneId + '" onclick="openCiaCipherHub()"><i class="fa-solid fa-arrow-right" aria-hidden="true"></i> رجوع إلى شفرات الـCIA</button>\n';
  return html.slice(0, tagEnd + 1) + button + html.slice(tagEnd + 1);
}

function injectCiaCipherHubMarkup(html) {
  if (typeof html !== 'string' || html.includes(HUB_MARKER)) return html;
  let output = html;
  if (output.includes(NAV_MARKER)) output = output.replace(NAV_MARKER, NAV_ITEM + '\n' + NAV_MARKER);
  if (output.includes(CONTENT_MARKER)) output = output.replace(CONTENT_MARKER, CONTENT_MARKER + '\n' + HUB_PANE);
  output = insertBackButton(output, 'morse-translator-view');
  output = insertBackButton(output, 'blackridge-cipher-view');
  output = insertBackButton(output, 'puzzles-view');
  const styles = '<link rel="stylesheet" href="/cia-cipher-hub.css" data-cia-cipher-hub-styles>';
  const scripts = '<script src="/cia-cipher-hub-client.js" data-cia-cipher-hub-client defer></script>';
  if (output.includes('</head>')) output = output.replace('</head>', styles + '\n</head>');
  if (output.includes('</body>')) output = output.replace('</body>', scripts + '\n</body>');
  return output;
}

module.exports = { injectCiaCipherHubMarkup };