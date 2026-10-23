'use strict';

(function exposeRadioVoiceSignalPolicy(root) {
  const maxCandidatesPerPeer = 64;

  function createEarlyCandidateBuffer(limit = maxCandidatesPerPeer) {
    const candidatesByPeer = new Map();
    const max = Number.isSafeInteger(limit) && limit > 0 ? limit : maxCandidatesPerPeer;

    return Object.freeze({
      enqueue(peerId, candidate) {
        const key = String(peerId || '');
        if (!key || !candidate) return 0;
        const candidates = candidatesByPeer.get(key) || [];
        if (candidates.length >= max) candidates.shift();
        candidates.push(candidate);
        candidatesByPeer.set(key, candidates);
        return candidates.length;
      },
      drain(peerId) {
        const key = String(peerId || '');
        const candidates = candidatesByPeer.get(key) || [];
        candidatesByPeer.delete(key);
        return candidates;
      },
      clear() {
        candidatesByPeer.clear();
      }
    });
  }

  const policy = Object.freeze({
    canHandleSignalWithoutPeer(type) {
      // The server validates same-channel membership and active PTT authority
      // on the participant pair before relaying offers and trickled ICE.
      return type === 'offer' || type === 'ice';
    },
    createEarlyCandidateBuffer
  });

  if (typeof module === 'object' && module.exports) {
    module.exports = policy;
  } else {
    root.RadioVoiceSignalPolicy = policy;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
