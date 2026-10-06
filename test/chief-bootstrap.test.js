'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  readChiefBootstrapConfig,
  withoutBootstrapCodes
} = require('../chief-bootstrap');

test('chief bootstrap values are read from environment and kept out of persisted config', () => {
  const config = readChiefBootstrapConfig({
    CIA_CHIEF_REGISTRATION_CODE: 'registration-example-value-123',
    CIA_CHIEF_SAVE_CODE: 'save-example-value-456789'
  });

  assert.equal(config.registrationCode, 'registration-example-value-123');
  assert.equal(config.saveCode, 'save-example-value-456789');
  assert.equal(config.configured, true);
  assert.deepEqual(
    withoutBootstrapCodes({
      chiefRegistrationCode: 'legacy-registration',
      chiefSaveCode: 'legacy-save',
      unrelatedSetting: true
    }),
    { unrelatedSetting: true }
  );
});

test('chief bootstrap is disabled when either value is missing or both are equal', () => {
  assert.equal(readChiefBootstrapConfig({}).configured, false);
  assert.equal(readChiefBootstrapConfig({
    CIA_CHIEF_REGISTRATION_CODE: 'registration-example-value-123'
  }).configured, false);
  assert.equal(readChiefBootstrapConfig({
    CIA_CHIEF_REGISTRATION_CODE: 'same-example-value-123456',
    CIA_CHIEF_SAVE_CODE: 'same-example-value-123456'
  }).configured, false);
  assert.equal(readChiefBootstrapConfig({
    CIA_CHIEF_REGISTRATION_CODE: 'short',
    CIA_CHIEF_SAVE_CODE: 'another-short'
  }).configured, false);
});
