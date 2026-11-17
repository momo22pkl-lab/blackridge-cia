'use strict';

const HUB_MARKER = 'data-cia-cipher-hub';
const NAV_MARKER = '      <li id="morse-nav" class="nav-btn" onclick="openMorseTranslator()">';
const CONTENT_MARKER = '  <div class="content-area">';
const NAV_ITEM = '      <li id="cia-cipher-hub-nav" class="nav-btn" role="button" tabindex="0" aria-controls="cia-cipher-hub-view" onclick="openCiaCipherHub()"><i class="fa-solid fa-shield-halved" aria-hidden="true"></i> شفرات الـCIA</li>';
const HUB_PANE = [
  '    <div id="cia-cipher-hub-view" class="view-pane cia-cipher-hub-view" aria-label="شفرات الـCIA" data-cia-cipher-hub>',
  '      <section class="cia-cipher-hub" dir="rtl" aria-labelledby="cia-cipher-hub-title">',
  '        <header class="cia-cipher-hub__header">',
  '          <div><span class="cia-cipher-hub__eyebrow">BLACKRIDGE CIA / SECURE SYSTEMS</span><h1 id="cia-cipher-hub-title">شفرات الـCIA</h1><p>اختر نظامًا واحدًا، وستظهر أداته هنا داخل القسم.</p></div>',
  '          <span class="cia-cipher-hub__seal" aria-hidden="true"><i class="fa-solid fa-shield-halved"></i></span>',
  '        </header>',
  '        <div class="cia-cipher-hub__controls">',
  '          <label for="cia-cipher-hub-select">نظام الشفرة</label>',
  '          <select id="cia-cipher-hub-select" aria-controls="cia-cipher-hub-tool-slot">',
  '            <option value="">اختر النظام</option>',
  '            <option value="morse">شفرة مورس</option>',
  '            <option value="intelligence">الشفرة الاستخباراتية</option>',
  '            <option value="puzzle">شفرة البازل</option>',
  '          </select>',
  '        </div>',
  '        <p id="cia-cipher-hub-status" class="cia-cipher-hub__status" role="status" aria-live="polite">اختر نظامًا من القائمة لعرضه داخل هذا القسم.</p>',
  '        <div id="cia-cipher-hub-tool-slot" class="cia-cipher-hub__tool-slot" aria-live="polite"></div>',
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
