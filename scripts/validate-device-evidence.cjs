#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

const REQUIRED_TEST_IDS = [
  'A-01', 'A-02', 'A-03', 'A-04', 'A-05', 'A-06',
  'B-01', 'B-02', 'B-03', 'B-04', 'B-05', 'B-06',
  'C-01', 'C-02', 'C-03', 'C-04', 'C-05',
  'D-01', 'D-02', 'D-03', 'D-04', 'D-05', 'D-06',
  'E-01', 'E-02', 'E-03', 'E-04', 'E-05',
  'F-01', 'F-02', 'F-03', 'F-04', 'F-05', 'F-06', 'F-07', 'F-08',
  'G-01', 'G-02', 'G-03', 'G-04',
];

const REQUIRED_PLATFORMS = ['windows', 'macos', 'linux'];
const VALID_STATUSES = ['NOT_RUN', 'PASS', 'FAIL', 'BLOCKED', 'NOT_APPLICABLE'];

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isHttpsUrl(value) {
  if (!nonEmptyString(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

function isIsoDateTime(value) {
  if (!nonEmptyString(value) || !/(Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
  return !Number.isNaN(Date.parse(value));
}

function validateCampaign(campaign, options = {}) {
  const allowIncomplete = options.allowIncomplete === true;
  const errors = [];
  const add = (path, message) => errors.push({ path, message });
  const checkString = (value, path) => {
    if (!nonEmptyString(value)) add(path, 'must be a non-empty string');
  };
  const checkUrl = (value, path) => {
    if (!isHttpsUrl(value)) add(path, 'must be an absolute HTTPS URL');
  };
  const checkDate = (value, path) => {
    if (!isIsoDateTime(value)) add(path, 'must be an ISO-8601 date-time with a timezone');
  };

  if (!isObject(campaign)) {
    return { errors: [{ path: '$', message: 'must be a JSON object' },], requiredTestCount: REQUIRED_TEST_IDS.length };
  }

  if (campaign.schemaVersion !== 1) {
    add('schemaVersion', 'must equal 1');
  }

  const candidate = campaign.candidate;
  if (!isObject(candidate)) {
    add('candidate', 'must be an object');
  } else {
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(candidate.version || '')) {
      add('candidate.version', 'must be a semantic version such as 1.0.2');
    }
    if (!/^[a-f0-9]{40}$/i.test(candidate.commit || '')) {
      add('candidate.commit', 'must be the exact 40-character Git commit SHA');
    }
    checkUrl(candidate.ciRunUrl, 'candidate.ciRunUrl');
    checkString(candidate.electronVersion, 'candidate.electronVersion');
    checkString(candidate.nodeVersion, 'candidate.nodeVersion');
    if (!Array.isArray(candidate.supportedConfigurations) || candidate.supportedConfigurations.length < 3) {
      add('candidate.supportedConfigurations', 'must explicitly list every supported OS/device configuration for Windows, macOS, and Linux');
    }
  }

  const configurationScopes = new Map();
  const scopePlatforms = new Set();
  if (isObject(candidate) && Array.isArray(candidate.supportedConfigurations)) {
    candidate.supportedConfigurations.forEach((scope, scopeIndex) => {
      const scopePath = 'candidate.supportedConfigurations[' + scopeIndex + ']';
      if (!isObject(scope)) {
        add(scopePath, 'must be an object');
        return;
      }
      checkString(scope.id, scopePath + '.id');
      checkString(scope.description, scopePath + '.description');
      if (!REQUIRED_PLATFORMS.includes(scope.platform)) {
        add(scopePath + '.platform', 'must be one of: ' + REQUIRED_PLATFORMS.join(', '));
      } else {
        scopePlatforms.add(scope.platform);
      }
      if (nonEmptyString(scope.id)) {
        if (configurationScopes.has(scope.id)) add(scopePath + '.id', 'must be unique across supported configurations');
        else configurationScopes.set(scope.id, scope.platform);
      }
    });
  }
  for (const platform of REQUIRED_PLATFORMS) {
    if (!scopePlatforms.has(platform)) {
      add('candidate.supportedConfigurations', 'must declare at least one supported configuration for ' + platform);
    }
  }

  if (!Array.isArray(campaign.runs) || campaign.runs.length === 0) {
    add('runs', 'must contain at least one device run');
  }

  const runIds = new Set();
  const coveredPlatforms = new Set();
  const coveredConfigurations = new Set();
  let completeRecordCount = 0;
  let pendingRecordCount = 0;

  if (Array.isArray(campaign.runs)) {
    campaign.runs.forEach((run, runIndex) => {
      const base = 'runs[' + runIndex + ']';
      if (!isObject(run)) {
        add(base, 'must be an object');
        return;
      }

      checkString(run.id, base + '.id');
      if (nonEmptyString(run.id)) {
        if (runIds.has(run.id)) add(base + '.id', 'must be unique across runs');
        runIds.add(run.id);
      }

      if (!REQUIRED_PLATFORMS.includes(run.platform)) {
        add(base + '.platform', 'must be one of: ' + REQUIRED_PLATFORMS.join(', '));
      } else {
        coveredPlatforms.add(run.platform);
      }
      checkString(run.configurationId, base + '.configurationId');
      if (nonEmptyString(run.configurationId)) {
        if (!configurationScopes.has(run.configurationId)) {
          add(base + '.configurationId', 'does not match a declared supported configuration');
        } else {
          if (configurationScopes.get(run.configurationId) !== run.platform) {
            add(base + '.configurationId', 'platform does not match the declared supported configuration');
          }
          coveredConfigurations.add(run.configurationId);
        }
      }

      [
        'osRelease',
        'osBuild',
        'architecture',
        'hardware',
        'microphoneDevice',
        'audioRoute',
        'displayConfiguration',
        'artifactName',
      ].forEach((field) => checkString(run[field], base + '.' + field));

      checkUrl(run.artifactUrl, base + '.artifactUrl');
      if (!/^[a-f0-9]{64}$/i.test(run.artifactSha256 || '')) {
        add(base + '.artifactSha256', 'must be a 64-character SHA-256 digest');
      }

      if (!Array.isArray(run.records)) {
        add(base + '.records', 'must be an array containing all required test IDs');
        return;
      }

      const seenTests = new Set();
      run.records.forEach((record, recordIndex) => {
        const recordPath = base + '.records[' + recordIndex + ']';
        if (!isObject(record)) {
          add(recordPath, 'must be an object');
          return;
        }

        if (!REQUIRED_TEST_IDS.includes(record.testId)) {
          add(recordPath + '.testId', 'unknown test ID: ' + String(record.testId));
          return;
        }
        if (seenTests.has(record.testId)) {
          add(recordPath + '.testId', 'duplicate test ID: ' + record.testId);
          return;
        }
        seenTests.add(record.testId);

        if (!VALID_STATUSES.includes(record.status)) {
          add(recordPath + '.status', 'must be one of: ' + VALID_STATUSES.join(', '));
          pendingRecordCount++;
          return;
        }

        if (record.status === 'NOT_RUN') {
          pendingRecordCount++;
          if (!allowIncomplete) add(recordPath + '.status', 'is NOT_RUN; complete the physical-device test');
          return;
        }

        checkString(record.operator, recordPath + '.operator');
        checkDate(record.executedAt, recordPath + '.executedAt');

        if (record.status === 'NOT_APPLICABLE') {
          checkString(record.reason, recordPath + '.reason');
          if (allowIncomplete) completeRecordCount++;
          return;
        }

        checkString(record.actualResult, recordPath + '.actualResult');

        if (record.status === 'PASS') {
          if (!Array.isArray(record.evidenceUrls) || record.evidenceUrls.length === 0) {
            add(recordPath + '.evidenceUrls', 'a PASS requires at least one evidence URL');
          } else {
            record.evidenceUrls.forEach((url, urlIndex) => checkUrl(url, recordPath + '.evidenceUrls[' + urlIndex + ']'));
          }
          completeRecordCount++;
          return;
        }

        if (record.status === 'FAIL' || record.status === 'BLOCKED') {
          checkString(record.reason, recordPath + '.reason');
          pendingRecordCount++;
          if (!allowIncomplete) add(recordPath + '.status', 'must be PASS or justified NOT_APPLICABLE for release sign-off');
        }
      });

      for (const testId of REQUIRED_TEST_IDS) {
        if (!seenTests.has(testId)) {
          add(base + '.records', 'missing required test ID ' + testId);
          pendingRecordCount++;
        }
      }
    });
  }

  for (const platform of REQUIRED_PLATFORMS) {
    if (!coveredPlatforms.has(platform)) {
      add('runs', 'missing real-device coverage for the ' + platform + ' release target');
    }
  }
  for (const configurationId of configurationScopes.keys()) {
    if (!coveredConfigurations.has(configurationId)) {
      add('runs', 'missing a device run for declared supported configuration ' + configurationId);
    }
  }

  if (!allowIncomplete || campaign.signOff !== undefined) {
    const signOff = campaign.signOff;
    if (!isObject(signOff)) {
      add('signOff', 'is required for final release sign-off');
    } else {
      checkString(signOff.reviewer, 'signOff.reviewer');
      checkDate(signOff.reviewedAt, 'signOff.reviewedAt');
      checkUrl(signOff.evidenceUrl, 'signOff.evidenceUrl');
    }
  }

  return {
    errors,
    requiredTestCount: REQUIRED_TEST_IDS.length,
    completeRecordCount,
    pendingRecordCount,
    runCount: Array.isArray(campaign.runs) ? campaign.runs.length : 0,
    coveredPlatforms: Array.from(coveredPlatforms).sort(),
  };
}

function printUsage() {
  process.stdout.write(
    'Usage: node scripts/validate-device-evidence.cjs <campaign.json> [--allow-incomplete]\n' +
    'Default mode requires all 40 test records per run, all three release platforms,\n' +
    'PASS or justified NOT_APPLICABLE results, evidence links for PASS, and owner sign-off.\n' +
    '--allow-incomplete validates the campaign structure while evidence is being collected.\n'
  );
}

function runCli(argv) {
  const args = [...argv];
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return 0;
  }

  const allowIncomplete = args.includes('--allow-incomplete');
  const paths = args.filter((arg) => arg !== '--allow-incomplete');
  if (paths.length !== 1) {
    printUsage();
    return 2;
  }

  let campaign;
  try {
    campaign = JSON.parse(fs.readFileSync(paths[0], 'utf8'));
  } catch (error) {
    process.stderr.write('Could not read campaign JSON: ' + error.message + '\n');
    return 2;
  }

  const result = validateCampaign(campaign, { allowIncomplete });
  if (result.errors.length > 0) {
    process.stderr.write('Device evidence validation failed:\n');
    for (const error of result.errors) {
      process.stderr.write('- ' + error.path + ': ' + error.message + '\n');
    }
    process.stderr.write(result.errors.length + ' validation error(s).\n');
    return 1;
  }

  if (allowIncomplete) {
    process.stdout.write(
      'Campaign structure is valid. ' + result.runCount + ' run(s), ' +
      result.coveredPlatforms.join(', ') + ' coverage; ' +
      result.pendingRecordCount + ' pending record(s). This is not release sign-off.\n'
    );
  } else {
    process.stdout.write(
      'Device evidence is structurally complete: ' + result.runCount + ' run(s), ' +
      result.coveredPlatforms.join(', ') + ' coverage, ' +
      result.requiredTestCount + ' required test IDs per run. Human evidence review is still required.\n'
    );
  }
  return 0;
}

if (require.main === module) {
  process.exitCode = runCli(process.argv.slice(2));
}

module.exports = {
  REQUIRED_TEST_IDS,
  REQUIRED_PLATFORMS,
  validateCampaign,
  runCli,
};
