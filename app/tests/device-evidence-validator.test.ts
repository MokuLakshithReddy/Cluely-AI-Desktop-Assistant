import { describe, expect, it } from 'vitest';

const {
  REQUIRED_TEST_IDS,
  validateCampaign,
} = require('../../scripts/validate-device-evidence.cjs') as {
  REQUIRED_TEST_IDS: string[];
  validateCampaign: (campaign: unknown, options?: { allowIncomplete?: boolean }) => {
    errors: Array<{ path: string; message: string }>;
    requiredTestCount: number;
    pendingRecordCount: number;
    coveredPlatforms: string[];
  };
};

const TESTED_AT = '2026-11-09T09:00:00.000Z';

function buildCampaign(): any {
  const platforms = ['windows', 'macos', 'linux'];
  return {
    schemaVersion: 1,
    candidate: {
      version: '1.0.2',
      commit: 'a'.repeat(40),
      ciRunUrl: 'https://github.com/MokuLakshithReddy/Cluely-AI-Desktop-Assistant/actions/runs/123456',
      electronVersion: '45.2.3',
      nodeVersion: '24.22.2',
      supportedConfigurations: platforms.map((platform) => ({
        id: platform + '-device-01',
        platform,
        description: 'One claimed ' + platform + ' release configuration.',
        osRelease: platform === 'windows' ? 'Windows 11 24H2' : platform === 'macos' ? 'macOS 15' : 'Ubuntu 24.04',
        osBuild: 'test-build-identifier',
        architecture: 'x64',
        hardware: 'Test hardware model',
        microphoneDevice: 'Test microphone',
        audioRoute: 'Test audio output and loopback',
        displayConfiguration: 'Single 1920x1080 display',
      })),
    },
    runs: platforms.map((platform) => ({
      id: platform + '-device-01',
      configurationId: platform + '-device-01',
      platform,
      osRelease: platform === 'windows' ? 'Windows 11 24H2' : platform === 'macos' ? 'macOS 15' : 'Ubuntu 24.04',
      osBuild: 'test-build-identifier',
      architecture: 'x64',
      hardware: 'Test hardware model',
      microphoneDevice: 'Test microphone',
      audioRoute: 'Test audio output and loopback',
      displayConfiguration: 'Single 1920x1080 display',
      artifactName: 'Cluely-Copilot-1.0.2-' + platform,
      artifactUrl: 'https://example.com/artifacts/' + platform,
      artifactSha256: 'b'.repeat(64),
      records: REQUIRED_TEST_IDS.map((testId) => ({
        testId,
        status: 'PASS',
        operator: 'test operator',
        executedAt: TESTED_AT,
        actualResult: 'Verified observed behavior on the physical test device.',
        evidenceUrls: ['https://example.com/evidence/' + platform + '/' + testId],
      })),
    })),
    signOff: {
      reviewer: 'release owner',
      reviewedAt: TESTED_AT,
      evidenceUrl: 'https://example.com/evidence/release-signoff',
    },
  };
}

describe('device evidence campaign validator', () => {
  it('accepts a complete campaign with every test ID on all release platforms', () => {
    const result = validateCampaign(buildCampaign());

    expect(result.errors).toEqual([]);
    expect(result.requiredTestCount).toBe(40);
    expect(result.coveredPlatforms).toEqual(['linux', 'macos', 'windows']);
  });

  it('rejects missing coverage for a release platform', () => {
    const campaign = buildCampaign();
    campaign.runs = campaign.runs.filter((run) => run.platform !== 'linux');

    const result = validateCampaign(campaign);

    expect(result.errors.some((error) => error.message.includes('linux'))).toBe(true);
  });

  it('rejects a declared supported device configuration with no evidence run', () => {
    const campaign = buildCampaign();
    campaign.candidate.supportedConfigurations.push({
      id: 'windows-10-x64-device-02',
      platform: 'windows',
      description: 'A separately claimed Windows 10 configuration.',
    });

    const result = validateCampaign(campaign);

    expect(result.errors.some((error) => error.message.includes('windows-10-x64-device-02'))).toBe(true);
  });

  it('rejects a run whose platform conflicts with its declared configuration', () => {
    const campaign = buildCampaign();
    campaign.runs[0].platform = 'macos';

    const result = validateCampaign(campaign);

    expect(result.errors.some((error) => error.message.includes('does not match the declared'))).toBe(true);
  });
  it('rejects device metadata that differs from the declared supported configuration', () => {
    const campaign = buildCampaign();
    campaign.runs[0].osBuild = 'a-different-windows-build';

    const result = validateCampaign(campaign);

    expect(result.errors.some((error) => error.message.includes('does not match declared supported configuration'))).toBe(true);
  });
  it('rejects a missing test record within a platform run', () => {
    const campaign = buildCampaign();
    campaign.runs[0].records = campaign.runs[0].records.filter((record) => record.testId !== 'D-04');

    const result = validateCampaign(campaign);

    expect(result.errors.some((error) => error.message.includes('D-04'))).toBe(true);
  });

  it('rejects duplicate test IDs instead of allowing a record to mask another', () => {
    const campaign = buildCampaign();
    campaign.runs[0].records.push({ ...campaign.runs[0].records[0] });

    const result = validateCampaign(campaign);

    expect(result.errors.some((error) => error.message.includes('duplicate test ID'))).toBe(true);
  });

  it('requires a traceable SHA-256 digest for every tested package', () => {
    const campaign = buildCampaign();
    campaign.runs[1].artifactSha256 = 'not-a-digest';

    const result = validateCampaign(campaign);

    expect(result.errors.some((error) => error.path.endsWith('.artifactSha256'))).toBe(true);
  });

  it('requires HTTPS evidence for every PASS record', () => {
    const campaign = buildCampaign();
    campaign.runs[0].records[0].evidenceUrls = [];

    const result = validateCampaign(campaign);

    expect(result.errors.some((error) => error.path.endsWith('.evidenceUrls'))).toBe(true);
  });

  it('requires a justification for NOT_APPLICABLE and does not count it as PASS', () => {
    const campaign = buildCampaign();
    const record = campaign.runs[0].records[0];
    record.status = 'NOT_APPLICABLE';

    const missingReason = validateCampaign(campaign);
    expect(missingReason.errors.some((error) => error.path.endsWith('.reason'))).toBe(true);

    record.reason = 'This OS does not expose this specific capture integration.';
    expect(validateCampaign(campaign).errors).toEqual([]);
  });

  it('blocks FAIL and BLOCKED records from final sign-off but permits collection mode', () => {
    const campaign = buildCampaign();
    const record = campaign.runs[0].records[0];
    record.status = 'BLOCKED';
    record.actualResult = 'The OS permission dialog did not appear on this build.';
    record.reason = 'Blocked by the device permission state; retest required.';

    const finalResult = validateCampaign(campaign);
    const collectionResult = validateCampaign(campaign, { allowIncomplete: true });

    expect(finalResult.errors.some((error) => error.message.includes('PASS or justified'))).toBe(true);
    expect(collectionResult.errors).toEqual([]);
    expect(collectionResult.pendingRecordCount).toBe(1);
  });

  it('allows NOT_RUN records only in collection mode', () => {
    const campaign = buildCampaign();
    campaign.runs[2].records[0] = { testId: 'A-01', status: 'NOT_RUN' };

    expect(validateCampaign(campaign).errors.some((error) => error.message.includes('NOT_RUN'))).toBe(true);
    expect(validateCampaign(campaign, { allowIncomplete: true }).errors).toEqual([]);
  });

  it('rejects non-HTTPS evidence links and missing owner sign-off', () => {
    const campaign = buildCampaign();
    campaign.runs[0].records[0].evidenceUrls = ['http://example.com/evidence'];
    delete campaign.signOff;

    const result = validateCampaign(campaign);

    expect(result.errors.some((error) => error.message.includes('HTTPS URL'))).toBe(true);
    expect(result.errors.some((error) => error.path === 'signOff')).toBe(true);
  });
});
