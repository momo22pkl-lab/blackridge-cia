'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8');
const serverSource = fs.readFileSync(path.join(projectRoot, 'server.js'), 'utf8');

function getWithdrawalFunction() {
  const start = html.indexOf('function withdrawBankMoney(button){');
  const end = html.indexOf('function claimBankSalary()', start);
  assert.ok(start >= 0 && end > start, 'withdrawal handler should exist');
  return html.slice(start, end);
}

function runWithdrawal(getResult, withdrawalResult) {
  const calls = [];
  const alerts = [];
  const input = { value: '100', disabled: false };
  const button = { disabled: false };
  const context = {
    currentUser: { publicCode: 'ALPHA#', bank: { balance: 8700 } },
    ciaSocket: {
      connected: true,
      emit(event, payload, callback) {
        calls.push({ event, payload });
        if (event === 'bank:get') callback(getResult);
        if (event === 'bank:withdraw') callback(withdrawalResult);
      }
    },
    document: {
      getElementById() { return input; },
      querySelector() { return button; }
    },
    window: {},
    alert(message) { alerts.push(String(message)); },
    renderBank() {},
    renderDailyAuditLogs() {},
    setTimeout() { return 1; },
    clearTimeout() {},
    calls,
    alerts,
    input,
    button
  };
  vm.runInNewContext(getWithdrawalFunction() + '\nwithdrawBankMoney(button);', context);
  return context;
}

function bank(code, balance) {
  return {
    code,
    balance,
    accountNumber: code,
    salary: 500,
    enabled: true,
    salaryEnabled: true
  };
}

test('the replacement button sends the selected account and accepts a valid withdrawal', () => {
  assert.match(html, /onclick="withdrawBankMoney\(this\)"\s*>\s*سحب من الرصيد/);
  const result = runWithdrawal(
    { ok: true, bank: bank('ALPHA#', 8700) },
    { ok: true, amount: 100, bank: bank('ALPHA#', 8600) }
  );
  assert.equal(result.calls.length, 2);
  assert.equal(result.calls[0].event, 'bank:get');
  assert.equal(result.calls[0].payload.publicCode, 'ALPHA#');
  assert.equal(result.calls[1].event, 'bank:withdraw');
  assert.equal(result.calls[1].payload.publicCode, 'ALPHA#');
  assert.equal(result.calls[1].payload.amount, 100);
  assert.equal(result.currentUser.bank.balance, 8600);
  assert.equal(result.input.value, '');
  assert.match(result.alerts[0], /تم سحب 100/);
});

test('a rejection displays the balance the server actually compared', () => {
  const result = runWithdrawal(
    { ok: true, bank: bank('ALPHA#', 8700) },
    {
      ok: false,
      message: 'الرصيد غير كافٍ.',
      requestedAmount: 100,
      availableBalance: 50,
      bank: bank('ALPHA#', 50),
      self: bank('OTHER', 8700)
    }
  );
  assert.equal(result.currentUser.bank.balance, 50);
  assert.match(result.alerts[0], /الرصيد الذي قارنه الخادم: 50/);
  assert.doesNotMatch(result.alerts[0], /الرصيد الذي قارنه الخادم: 8700/);
});

test('a mismatched account returned by the server is not withdrawn from', () => {
  const result = runWithdrawal(
    { ok: true, bank: bank('OTHER', 8700) },
    { ok: true, amount: 100, bank: bank('OTHER', 8600) }
  );
  assert.equal(result.calls.length, 1);
  assert.match(result.alerts[0], /لا يطابق الحساب المحدد/);
});

test('the server still checks available balance before deducting funds', () => {
  const start = serverSource.indexOf("socket.on(\n      'bank:withdraw'");
  const end = serverSource.indexOf("socket.on(\n      'bank:freeze'", start);
  assert.ok(start >= 0 && end > start, 'server withdrawal handler should exist');
  const handler = serverSource.slice(start, end);
  assert.match(handler, /availableBalance < amount/);
  assert.match(handler, /target\.bank\.balance = availableBalance - amount/);
  assert.match(handler, /canManageBank/);
});
