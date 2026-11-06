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

    let vaultAvailable = false;
    try {
      vaultAvailable = Boolean(safeStorage && safeStorage.isEncryptionAvailable());
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
    evidence.push('Preload bridge exercised session save/list/get/delete against the disk-backed repository');
    evidence.push(sessionResult.credentialSeeded
      ? 'Native purge-all-data removed archived sessions, reset active state, and deleted the encrypted credential vault'
      : 'Native purge-all-data removed archived sessions and reset active state; credential storage was unavailable on this runner');

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
