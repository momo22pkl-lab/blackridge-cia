'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const expectedIds = ['CH-1', 'TAC-1', 'CH-3', 'CH-4', 'CH-5', 'CH-6', 'CH-7', 'CH-8', 'CH-9', 'CH-10'];

function attribute(tag, name) {
  return tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? '';
}

test('radio wheel has ten numbered choices and keeps CH-3 in its existing protected slot', () => {
  const tags = [...html.matchAll(/<button\b[^>]*class="radio-channel-btn[^"]*"[^>]*>/g)].map(match => match[0]);
  assert.equal(tags.length, 10);
  assert.deepEqual(tags.map(tag => attribute(tag, 'data-channel')), expectedIds);
  assert.deepEqual(tags.map(tag => Number(attribute(tag, 'data-wave-number'))), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.ok(tags.every(tag => /onclick="changeRadioChannel\(/.test(tag)));
  assert.match(html, /id="radio-wheel-number"/);
  assert.match(html, /id="radio-wheel-name"/);

  const mainStart = server.indexOf('const RADIO_MAIN_CHANNELS');
  const mainEnd = server.indexOf('const RADIO_MAIN_CHANNEL_IDS', mainStart);
  const mainIds = [...server.slice(mainStart, mainEnd).matchAll(/\bid: '([^']+)'/g)].map(match => match[1]);
  assert.deepEqual(mainIds, expectedIds);
  assert.match(server, /channel === 'CH-3' && !isLeadership\(actor\)/);
  assert.match(server, /return channel === 'CH-3' \|\| !RADIO_MAIN_CHANNEL_IDS\.has\(channel\)/);
  assert.match(html, /@media \(max-width: 480px\)[\s\S]*?width: min\(100%, 76vw, 260px\)/);
});

test('clicking a wave updates the center, selection, accessibility state, and radio join request', () => {
  const optionStart = html.indexOf('const RADIO_CHANNEL_OPTIONS = Object.freeze([');
  const optionEnd = html.indexOf('const RADIO_SPEAKER_NOTICE_CHANNELS', optionStart);
  const wheelStart = html.indexOf('function syncRadioChannelWheel(channel = radioChannel)');
  const wheelEnd = html.indexOf('function removeRadioSpeakingNotice(', wheelStart);
  const changeStart = html.indexOf('function changeRadioChannel(ch, freq, label)');
  const changeEnd = html.indexOf('function joinCustomRadioChannel()', changeStart);
  assert.ok(optionStart >= 0 && optionEnd > optionStart, 'channel metadata exists');
  assert.ok(wheelStart >= 0 && wheelEnd > wheelStart, 'wheel synchronization handler exists');
  assert.ok(changeStart >= 0 && changeEnd > changeStart, 'radio channel handler exists');
  const optionSource = html.slice(optionStart, optionEnd);
  const functionSource = html.slice(wheelStart, wheelEnd) + '\n' + html.slice(changeStart, changeEnd);
  const tags = [...html.matchAll(/<button\b[^>]*class="radio-channel-btn[^"]*"[^>]*>/g)].map(match => match[0]);
  const buttons = tags.map(tag => {
    const attributes = {
      'data-channel': attribute(tag, 'data-channel'),
      'data-wave-number': attribute(tag, 'data-wave-number'),
      'aria-pressed': attribute(tag, 'aria-pressed')
    };
    const classes = new Set(tag.includes(' active ') ? ['active'] : []);
    return {
      attributes,
      classList: {
        toggle(name, force) { if (force) classes.add(name); else classes.delete(name); },
        contains(name) { return classes.has(name); }
      },
      getAttribute(name) { return attributes[name] ?? null; },
      setAttribute(name, value) { attributes[name] = String(value); }
    };
  });
  const elements = {
    'radio-wheel-number': { innerText: '1' },
    'radio-wheel-name': { innerText: 'القناة العامة' },
    'radio-freq-display': { innerText: '104.50' },
    'radio-channel-short': { innerText: 'CH-1' }
  };
  const joined = [];
  const context = {
    document: {
      getElementById(id) { return elements[id] ?? null; },
      querySelectorAll(selector) { return selector === '.radio-channel-btn' ? buttons : []; }
    },
    radioChannel: 'CH-1',
    radioCustomLabel: '',
    radioPoweredOn: true,
    radioJoinRequestId: 0,
    radioJoinPending: false,
    radioJoinConfirmed: true,
    radioActiveTalkers: { clear() {} },
    radioPeersReceiving: { clear() {} },
    isCustomRadioChannel(channel) { return String(channel).startsWith('CUSTOM:'); },
    normalizeCustomRadioLabel(value) { return String(value || '').trim().replace(/\s+/g, ' '); },
    radioChannelDisplayName(channel) { return String(channel || 'CH-1'); },
    saveRadioPreference() {},
    closeAllRadioVoicePeers() {},
    updateRadioPowerUI() {},
    requestRadioJoin(channel) { joined.push(channel); },
    setRadioActivity() {},
    stopPTT() {}
  };
  vm.createContext(context);
  vm.runInContext(`${optionSource}\n${functionSource}`, context);

  const waveTen = tags.find(tag => attribute(tag, 'data-wave-number') === '10');
  vm.runInContext(attribute(waveTen, 'onclick'), context);
  assert.equal(context.radioChannel, 'CH-10');
  assert.equal(elements['radio-wheel-number'].innerText, '10');
  assert.equal(elements['radio-wheel-name'].innerText, 'موجة 10');
  assert.equal(buttons.filter(button => button.classList.contains('active')).length, 1);
  assert.equal(buttons[9].getAttribute('aria-pressed'), 'true');
  assert.deepEqual(joined, ['CH-10']);

  const waveThree = tags.find(tag => attribute(tag, 'data-wave-number') === '3');
  vm.runInContext(attribute(waveThree, 'onclick'), context);
  assert.equal(context.radioChannel, 'CH-3');
  assert.equal(elements['radio-wheel-number'].innerText, '3');
  assert.equal(elements['radio-wheel-name'].innerText, 'القيادة المشفرة');
  assert.deepEqual(joined, ['CH-10', 'CH-3']);
});
