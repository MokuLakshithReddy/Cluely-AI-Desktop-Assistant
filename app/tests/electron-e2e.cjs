const assert = require('node:assert/strict');
const { safeStorage } = require('electron');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(check, description, timeoutMs = 15000) {
  const startedAt = Date.now();
  let lastError;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }

  const suffix = lastError ? ': ' + (lastError.message || lastError) : '';
  throw new Error('Timed out waiting for ' + description + suffix);
}

async function execute(win, fn, args) {
  if (!win || win.isDestroyed()) throw new Error('Dashboard window was destroyed during E2E test');
  const serializedArgs = args === undefined ? [] : (Array.isArray(args) ? args : [args]);
  return win.webContents.executeJavaScript('(' + fn.toString() + ').apply(null,' + JSON.stringify(serializedArgs) + ')');
}

async function runDesktopE2E({ windowCoordinator }) {
  const dashboard = windowCoordinator.openDashboardWindow('models');
  // The control window owns capture. Keep the E2E on that real renderer instead
  // of changing the dashboard route and accidentally creating a second audio owner.
  const control = windowCoordinator.createControlWindow();
  const sessionId = 'electron-e2e-' + Date.now();
  let keySaveAttempted = false;
  let sessionSaveAttempted = false;
  const evidence = [];

  try {
    const ready = function () {
      return Boolean(
        document.readyState === 'complete' &&
        window.desktopBridge &&
        document.querySelector('form') &&
        Array.from(document.querySelectorAll('label')).some(label =>
          label.textContent.includes('Google Gemini API Key')
        )
      );
    };
    await waitFor(() => execute(dashboard, ready), 'Dashboard renderer and credential form');
    evidence.push('Real Dashboard renderer mounted with the credential form');

    const controlReady = function () {
      return Boolean(document.readyState === 'complete' && window.desktopBridge &&
        window.location.hash.replace(/^#\/?/, '') === 'control');
    };
    await waitFor(() => execute(control, controlReady), 'Control renderer and audio-owner hook');
    evidence.push('Real control renderer mounted as the single audio owner');

    let vaultAvailable = false;
    try {
      const encryptionAvailable = Boolean(safeStorage && safeStorage.isEncryptionAvailable());
      const backend = process.platform === 'linux' && safeStorage &&
        typeof safeStorage.getSelectedStorageBackend === 'function'
        ? safeStorage.getSelectedStorageBackend()
        : null;
      vaultAvailable = encryptionAvailable &&
        !(process.platform === 'linux' && (!backend || backend === 'basic_text'));
    } catch {
      vaultAvailable = false;
    }

    if (vaultAvailable) {
      const submitGeminiKey = function () {
        const label = Array.from(document.querySelectorAll('label')).find(item =>
          item.textContent.includes('Google Gemini API Key')
        );
        const input = label && label.parentElement && label.parentElement.parentElement
          ? label.parentElement.parentElement.querySelector('input[type="password"]')
          : null;
        const submit = Array.from(document.querySelectorAll('form button[type="submit"]')).find(button =>
          button.textContent.includes('Update Encrypted Credentials')
        );
        if (!input || !submit) throw new Error('Gemini input or credential submit button not found');

        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, 'e2e-invalid-test-key');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        submit.click();
        return true;
      };

      keySaveAttempted = true;
      await execute(dashboard, submitGeminiKey);

      const hasStoredKey = function () {
        const label = Array.from(document.querySelectorAll('label')).find(item =>
          item.textContent.includes('Google Gemini API Key')
        );
        return Boolean(label && label.parentElement &&
          label.parentElement.textContent.includes('Stored in Vault'));
      };
      await waitFor(() => execute(dashboard, hasStoredKey), 'Dashboard Stored in Vault state after save');
      evidence.push('Rendered credential form saved a key and received the updated IPC state');

      const clickDelete = function () {
        const label = Array.from(document.querySelectorAll('label')).find(item =>
          item.textContent.includes('Google Gemini API Key')
        );
        const deleteButton = label && label.parentElement
          ? Array.from(label.parentElement.querySelectorAll('button')).find(button =>
              button.textContent.trim() === 'Delete')
          : null;
        if (!deleteButton) throw new Error('Gemini Delete button not found');
        deleteButton.click();
        return true;
      };
      await execute(dashboard, clickDelete);

      const hasNoStoredKey = function () {
        const label = Array.from(document.querySelectorAll('label')).find(item =>
          item.textContent.includes('Google Gemini API Key')
        );
        return Boolean(label && label.parentElement &&
          label.parentElement.textContent.includes('Not Configured'));
      };
      await waitFor(() => execute(dashboard, hasNoStoredKey), 'Dashboard Not Configured state after delete');

      const remainingKeys = await execute(dashboard, function () {
        return window.desktopBridge.getHasApiKeys();
      });
      assert.equal(remainingKeys.gemini, false, 'Gemini test credential should be removed');
      evidence.push('Rendered Delete action removed the key and updated the visible status');
    } else {
      evidence.push('Credential UI save/delete skipped because Electron safeStorage is unavailable on this runner');
    }

    sessionSaveAttempted = true;
    const now = new Date().toISOString();
    const record = {
      id: sessionId,
      title: 'Electron bridge E2E verification',
      createdAt: now,
      updatedAt: now,
      durationSeconds: 1,
      mode: 'copilot',
      audioInputLanguage: 'en',
      transcript: [],
      messages: [{
        id: 'e2e-message-1',
        role: 'user',
        content: 'Verify renderer to main-process session persistence.',
        createdAt: now,
      }],
    };

    const sessionWorkflow = async function (value, canStoreCredentials) {
      const bridge = window.desktopBridge;
      await bridge.saveSessionRecord(value);
      const sessions = await bridge.listPastSessions();
      const loaded = await bridge.getPastSession(value.id);
      const deleted = await bridge.deletePastSession(value.id);
      const sessionsAfterDelete = await bridge.listPastSessions();

      // Re-seed one archived record and (when OS secure storage is available) one
      // encrypted provider credential so the real desktop purge path is exercised.
      await bridge.saveSessionRecord(value);
      let credentialSeeded = false;
      if (canStoreCredentials) {
        await bridge.saveApiKey('openai', 'e2e-invalid-test-openai-key');
        credentialSeeded = true;
      }

      const purgeResult = await bridge.purgeAllData();
      const keysAfterPurge = await bridge.getHasApiKeys();
      const sessionsAfterPurge = await bridge.listPastSessions();
      const stateAfterPurge = await bridge.getSharedState();

      return {
        listed: sessions.some(item => item.id === value.id),
        loadedTitle: loaded && loaded.title,
        loadedMessage: loaded && loaded.messages && loaded.messages[0] && loaded.messages[0].content,
        deleted,
        remainsAfterDelete: sessionsAfterDelete.some(item => item.id === value.id),
        purgeResult,
        sessionsAfterPurge: sessionsAfterPurge.length,
        configuredProvidersAfterPurge: Object.entries(keysAfterPurge)
          .filter(([, configured]) => configured)
          .map(([provider]) => provider),
        activeSessionAfterPurge: stateAfterPurge.session,
        knowledgeDocsAfterPurge: stateAfterPurge.knowledgeDocs.length,
        providerFlagsAfterPurge: stateAfterPurge.hasApiKeys,
        credentialSeeded,
      };
    };
    const sessionResult = await execute(dashboard, sessionWorkflow, [record, vaultAvailable]);

    assert.equal(sessionResult.listed, true, 'Saved session should appear in the session list');
    assert.equal(sessionResult.loadedTitle, record.title, 'Saved session should load through IPC');
    assert.equal(sessionResult.loadedMessage, record.messages[0].content, 'Saved message should survive persistence');
    assert.equal(sessionResult.deleted, true, 'Session delete IPC should return true');
    assert.equal(sessionResult.remainsAfterDelete, false, 'Deleted session should disappear from the session list');
    assert.equal(sessionResult.purgeResult, true, 'Native purge-all-data IPC should resolve successfully');
    assert.equal(sessionResult.sessionsAfterPurge, 0, 'Native purge should remove archived session records');
    assert.deepEqual(sessionResult.configuredProvidersAfterPurge, [], 'Native purge should remove every saved provider credential');
    assert.equal(sessionResult.activeSessionAfterPurge, null, 'Native purge should clear the active session');
    assert.equal(sessionResult.knowledgeDocsAfterPurge, 0, 'Native purge should clear knowledge documents');
    assert.deepEqual(
      Object.values(sessionResult.providerFlagsAfterPurge),
      [false, false, false, false, false],
      'Native purge should clear all shared provider-presence flags'
    );
    evidence.push('Preload bridge exercised session save/list/get/delete against the disk-backed repository');
    evidence.push(sessionResult.credentialSeeded
      ? 'Native purge-all-data removed archived sessions, reset active state, and deleted the encrypted credential vault'
      : 'Native purge-all-data removed archived sessions and reset active state; credential storage was unavailable on this runner');

    // Exercise the real App/useAudioCapture hook with deterministic fake media devices.
    // Capture is injected into the actual control window, which is the sole audio owner.
    // This tests renderer + hook + preload IPC; it does not claim physical microphone coverage.
    const activeCapturePurgeWorkflow = async function () {
      const bridge = window.desktopBridge;
      if (!bridge || typeof bridge.patchSharedState !== 'function') {
        throw new Error('Control-window shared-state bridge is unavailable');
      }

      const stopped = { mic: false, loopback: false, video: false };
      const contexts = [];
      const processors = [];
      const makeTrack = kind => ({
        kind,
        enabled: true,
        stop() {
          if (kind === 'video') stopped.video = true;
          else if (kind === 'microphone') stopped.mic = true;
          else if (kind === 'loopback') stopped.loopback = true;
        },
      });
      const micTrack = makeTrack('microphone');
      const loopbackTrack = makeTrack('loopback');
      const videoTrack = makeTrack('video');

      class FakeMediaStream {
        constructor(tracks) { this.tracks = tracks || []; }
        getTracks() { return this.tracks; }
        getAudioTracks() { return this.tracks.filter(track => track.kind !== 'video'); }
        getVideoTracks() { return this.tracks.filter(track => track.kind === 'video'); }
      }

      class FakeAudioContext {
        constructor() {
          this.destination = {};
          this.state = 'running';
          this.closed = false;
          contexts.push(this);
        }
        createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
        createScriptProcessor() {
          const node = { onaudioprocess: null, connect() {}, disconnect() {} };
          processors.push(node);
          return node;
        }
        close() {
          this.closed = true;
          this.state = 'closed';
          return Promise.resolve();
        }
      }

      const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
      const originalAudioContext = Object.getOwnPropertyDescriptor(window, 'AudioContext');
      const originalMediaStream = Object.getOwnPropertyDescriptor(window, 'MediaStream');

      try {
        Object.defineProperty(navigator, 'mediaDevices', {
          configurable: true,
          value: {
            getUserMedia: async () => new FakeMediaStream([micTrack]),
            getDisplayMedia: async () => new FakeMediaStream([videoTrack, loopbackTrack]),
          },
        });
        Object.defineProperty(window, 'AudioContext', { configurable: true, value: FakeAudioContext });
        Object.defineProperty(window, 'MediaStream', { configurable: true, value: FakeMediaStream });

        await bridge.patchSharedState({ isRecording: true });
        for (let attempt = 0; attempt < 100 && processors.length < 2; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        if (processors.length !== 2) {
          throw new Error('Control audio owner did not create exactly one microphone and one loopback processor');
        }

        const speechFrame = new Float32Array(4096);
        for (let i = 0; i < speechFrame.length; i++) {
          speechFrame[i] = Math.sin((2 * Math.PI * 300 * i) / 48000) * 0.35;
        }
        for (const processor of processors) {
          if (typeof processor.onaudioprocess !== 'function') {
            throw new Error('Audio processor callback was not attached');
          }
          processor.onaudioprocess({ inputBuffer: { getChannelData: () => speechFrame } });
        }

        let activeState = await bridge.getSharedState();
        for (let attempt = 0; attempt < 40 &&
          !(activeState.meHasVoiceActivity && activeState.themHasVoiceActivity); attempt++) {
          await new Promise(resolve => setTimeout(resolve, 25));
          activeState = await bridge.getSharedState();
        }
        if (!activeState.meHasVoiceActivity || !activeState.themHasVoiceActivity) {
          throw new Error('Synthetic overlapping speech did not activate both independent VAD sources');
        }

        const purgeResult = await bridge.purgeAllData();
        await new Promise(resolve => setTimeout(resolve, 150));
        const stateAfterPurge = await bridge.getSharedState();

        return {
          purgeResult,
          activeMicrophone: activeState.meHasVoiceActivity,
          activeLoopback: activeState.themHasVoiceActivity,
          stopped,
          contextsClosed: contexts.length === 2 && contexts.every(context => context.closed),
          recordingAfterPurge: stateAfterPurge.isRecording,
          micActivityAfterPurge: stateAfterPurge.meHasVoiceActivity,
          systemActivityAfterPurge: stateAfterPurge.themHasVoiceActivity,
          sessionAfterPurge: stateAfterPurge.session,
          knowledgeDocsAfterPurge: stateAfterPurge.knowledgeDocs.length,
        };
      } finally {
        if (originalMediaDevices) Object.defineProperty(navigator, 'mediaDevices', originalMediaDevices);
        else delete navigator.mediaDevices;
        if (originalAudioContext) Object.defineProperty(window, 'AudioContext', originalAudioContext);
        else delete window.AudioContext;
        if (originalMediaStream) Object.defineProperty(window, 'MediaStream', originalMediaStream);
        else delete window.MediaStream;
      }
    };

    const activeCaptureResult = await execute(control, activeCapturePurgeWorkflow);
    assert.equal(activeCaptureResult.activeMicrophone, true, 'Microphone VAD should detect overlapping speech');
    assert.equal(activeCaptureResult.activeLoopback, true, 'Loopback VAD should detect overlapping speech');
    assert.equal(activeCaptureResult.purgeResult, true, 'Purge should complete while the real capture hook is active');
    assert.equal(activeCaptureResult.stopped.mic, true, 'Purge should stop microphone media track');
    assert.equal(activeCaptureResult.stopped.loopback, true, 'Purge should stop loopback media track');
    assert.equal(activeCaptureResult.stopped.video, true, 'Display video track should be stopped');
    assert.equal(activeCaptureResult.contextsClosed, true, 'Purge should close both audio contexts');
    assert.equal(activeCaptureResult.recordingAfterPurge, false, 'Recording must be off after purge');
    assert.equal(activeCaptureResult.micActivityAfterPurge, false, 'Microphone VAD activity must be cleared');
    assert.equal(activeCaptureResult.systemActivityAfterPurge, false, 'System VAD activity must be cleared');
    assert.equal(activeCaptureResult.sessionAfterPurge, null, 'Buffered speech must not recreate a session during purge');
    assert.equal(activeCaptureResult.knowledgeDocsAfterPurge, 0, 'Purge must leave no knowledge docs');
    evidence.push('Actual control-window useAudioCapture hook opened fake mic + loopback streams, detected overlapping speech in both VAD sources, and stopped/discarded both streams during purge');

    console.log('[E2E_EVIDENCE]', JSON.stringify(evidence));
  } finally {
    if (dashboard && !dashboard.isDestroyed()) {
      try {
        const cleanup = async function (id, deleteKey) {
          if (window.desktopBridge) {
            if (deleteKey) await window.desktopBridge.deleteApiKey('gemini');
            await window.desktopBridge.deletePastSession(id);
          }
          return true;
        };
        await execute(dashboard, cleanup, [sessionId, keySaveAttempted]);
      } catch {}
    }
  }
}

module.exports = { runDesktopE2E };
