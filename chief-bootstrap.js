'use strict';

const MIN_BOOTSTRAP_CODE_LENGTH = 24;

function readChiefBootstrapConfig(env = process.env) {
  const registrationCode = String(env.CIA_CHIEF_REGISTRATION_CODE || '').trim().slice(0, 100);
  const saveCode = String(env.CIA_CHIEF_SAVE_CODE || '').trim().slice(0, 100);

  return Object.freeze({
    registrationCode,
    saveCode,
    configured: Boolean(
      registrationCode.length >= MIN_BOOTSTRAP_CODE_LENGTH &&
      saveCode.length >= MIN_BOOTSTRAP_CODE_LENGTH &&
      registrationCode !== saveCode
    )
  });
}

function withoutBootstrapCodes(systemConfig) {
  const safeConfig = systemConfig &&
    typeof systemConfig === 'object' &&
    !Array.isArray(systemConfig)
    ? { ...systemConfig }
    : {};

  delete safeConfig.chiefRegistrationCode;
  delete safeConfig.chiefSaveCode;
  return safeConfig;
}

module.exports = {
  readChiefBootstrapConfig,
  withoutBootstrapCodes
};
