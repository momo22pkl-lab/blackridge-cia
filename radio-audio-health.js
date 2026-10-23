'use strict';

(function exposeRadioAudioHealth(root) {
  const LOW_AUDIO_LEVEL = 0.02;
  const LOW_LEVEL_SAMPLE_LIMIT = 3;
  const NO_MEDIA_SAMPLE_LIMIT = 2;

  function createState() {
    return {
      lastBytes: null,
      noMediaSamples: 0,
      lowLevelSamples: 0
    };
  }

  function summarize(reports, direction, state = createState()) {
    const outbound = direction === 'outbound';
    const wantedType = outbound ? 'outbound-rtp' : 'inbound-rtp';
    const byteField = outbound ? 'bytesSent' : 'bytesReceived';
    let audioReport = null;
    if (reports && typeof reports.forEach === 'function') {
      reports.forEach((report) => {
        if (
          !audioReport &&
          report &&
          report.type === wantedType &&
          (report.kind === 'audio' || report.mediaType === 'audio')
        ) {
          audioReport = report;
        }
      });
    }

    if (!audioReport) {
      return { status: 'unavailable', deltaBytes: 0, audioLevel: null };
    }

    const rawBytes = Number(audioReport[byteField]);
    const bytes = Number.isFinite(rawBytes) && rawBytes > 0 ? rawBytes : 0;
    const deltaBytes = state.lastBytes === null
      ? bytes
      : Math.max(0, bytes - state.lastBytes);
    state.lastBytes = bytes;
    state.noMediaSamples = deltaBytes > 0 ? 0 : state.noMediaSamples + 1;

    const audioLevel = typeof audioReport.audioLevel === 'number' &&
      Number.isFinite(audioReport.audioLevel)
      ? Math.max(0, Math.min(1, audioReport.audioLevel))
      : null;
    if (audioLevel !== null && deltaBytes > 0) {
      state.lowLevelSamples = audioLevel <= LOW_AUDIO_LEVEL
        ? state.lowLevelSamples + 1
        : 0;
    } else if (audioLevel === null || audioLevel > LOW_AUDIO_LEVEL) {
      state.lowLevelSamples = 0;
    }

    let status = 'waiting';
    if (state.noMediaSamples >= NO_MEDIA_SAMPLE_LIMIT) status = 'no-media';
    else if (state.lowLevelSamples >= LOW_LEVEL_SAMPLE_LIMIT) status = 'low-level';
    else if (deltaBytes > 0) status = 'active';

    return { status, deltaBytes, audioLevel };
  }

  const api = Object.freeze({ createState, summarize });
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RadioAudioHealth = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
