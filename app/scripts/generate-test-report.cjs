const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const appDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(appDir, '..');
const resultsPath = path.join(repoRoot, 'docs', 'testing', 'TEST_RESULTS.md');

function replaceRequired(content, pattern, replacement, label) {
  if (!pattern.test(content)) {
    throw new Error(`Could not synchronize ${label}; its expected source text was not found.`);
  }
  return content.replace(pattern, replacement);
}

console.log('Generating automated test evidence report from real test runners...');

// 1. Run Vitest with JSON reporter.
//
// Vitest 5 writes JSON reports to a file by default (rather than stdout).
// Use an explicit path so the parser consumes the report produced by this run,
// even when Vitest exits non-zero because one or more assertions failed.
const vitestJsonFile = '.vitest-json-results.json';
const vitestJsonPath = path.join(appDir, vitestJsonFile);
const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';

fs.rmSync(vitestJsonPath, { force: true });
let vitestCommandError = null;
try {
  execSync(`${npxCmd} vitest run --reporter=json --outputFile=${vitestJsonFile}`, {
    cwd: appDir,
    encoding: 'utf8',
    env: { ...process.env, CI: 'true' },
    maxBuffer: 10 * 1024 * 1024,
  });
} catch (err) {
  // A non-zero exit is expected when tests fail. Vitest still writes its JSON
  // report, which is the authoritative source for the pass/fail counts.
  vitestCommandError = err;
}

let vitestData;
try {
  vitestData = JSON.parse(fs.readFileSync(vitestJsonPath, 'utf8'));
} catch (e) {
  console.error('Failed to read or parse Vitest JSON report:', e);
  if (vitestCommandError) {
    console.error('Vitest command diagnostics:', {
      message: vitestCommandError.message,
      stdout: vitestCommandError.stdout?.toString().slice(-4000),
      stderr: vitestCommandError.stderr?.toString().slice(-4000),
    });
  }
  process.exit(1);
} finally {
  fs.rmSync(vitestJsonPath, { force: true });
}

// 2. Run Verified Electron Smoke Test
console.log('Executing verified Electron desktop runtime smoke test...');
const smokeResult = spawnSync(process.execPath, ['tests/electron-smoke.cjs'], {
  cwd: appDir,
  encoding: 'utf8',
  env: { ...process.env, CI: 'true' },
  timeout: 90000,
  maxBuffer: 10 * 1024 * 1024,
  windowsHide: true,
});

const smokeStdout = smokeResult.stdout || '';
const smokeStderr = smokeResult.stderr || '';
const smokePassed = smokeResult.status === 0 &&
  smokeStdout.includes('[APP_READY]') &&
  smokeStdout.includes('[E2E_COMPLETE]');

console.log(`Smoke test passed: ${smokePassed}`);
if (!smokePassed) {
  console.error('Electron smoke runner diagnostics:', JSON.stringify({
    status: smokeResult.status,
    signal: smokeResult.signal,
    error: smokeResult.error ? {
      name: smokeResult.error.name,
      code: smokeResult.error.code,
      message: smokeResult.error.message,
    } : null,
    stdout: smokeStdout.slice(-8000),
    stderr: smokeStderr.slice(-8000),
  }, null, 2));
}

// 3. Aggregate Test Statistics
const totalSuites = vitestData.testResults.length;
const totalUnitTests = vitestData.numTotalTests;
const passedUnitTests = vitestData.numPassedTests;
const failedUnitTests = vitestData.numFailedTests;

const grandTotalTests = totalUnitTests + 1;
const grandPassedTests = passedUnitTests + (smokePassed ? 1 : 0);
const grandFailedTests = failedUnitTests + (smokePassed ? 0 : 1);
const passRate = grandTotalTests > 0 ? Math.round((grandPassedTests / grandTotalTests) * 100) : 0;

// Identify the exact source revision and workflow run that produced this report.
// These fields make downloaded CI evidence independently traceable to its source.
const sourceRevision = process.env.GITHUB_SHA || (() => {
  try { return execSync('git rev-parse HEAD', { cwd: repoRoot, encoding: 'utf8' }).trim(); }
  catch { return 'unknown'; }
})();
const workflowRunId = process.env.GITHUB_RUN_ID || '';
const workflowName = process.env.GITHUB_WORKFLOW || 'GitHub Actions';
const githubServerUrl = (process.env.GITHUB_SERVER_URL || 'https://github.com').replace(/\/$/, '');
const repositoryName = process.env.GITHUB_REPOSITORY || '';
const sourceUrl = repositoryName && sourceRevision !== "unknown"
  ? `${githubServerUrl}/${repositoryName}/commit/${sourceRevision}`
  : null;
const workflowUrl = repositoryName && workflowRunId
  ? `${githubServerUrl}/${repositoryName}/actions/runs/${workflowRunId}`
  : null;
// Build Markdown Output
let md = `# Test Execution Log & Results\n\n`;
md += `**Target Environment**: ${os.type()} ${os.release()} (${os.arch()})  \n`;
md += `**Node Version**: ${process.version}  \n`;
md += `**Test Framework**: Vitest JSON Reporter & Electron UI/IPC E2E Smoke Runner  \n`;
md += `**Test Status**: ${grandPassedTests}/${grandTotalTests} Passing (${passRate}% Pass Rate)  \n`;
md += `**Evidence Source**: Generated directly from automated runner JSON output and process exit verification  \n`;
md += `**Source revision**: ${sourceUrl ? `[${sourceRevision}](${sourceUrl})` : `\`${sourceRevision}\``}  \n`;
md += `**Workflow run**: ${workflowUrl ? `[${workflowName} — run ${workflowRunId}](${workflowUrl})` : 'Local execution'}  \n`;
md += `**Verification Date**: ${new Date().toISOString().split('T')[0]}  \n\n`;
md += `---\n\n`;
md += `## Execution Summary\n\n`;
md += `| Test Suite File | Subsystem / Feature Area | Total Tests | Passed | Failed | Status |\n`;
md += `|---|---|---|---|---|---|\n`;

for (const suite of vitestData.testResults) {
  const fileName = path.basename(suite.name);
  const total = suite.assertionResults.length;
  const passed = suite.assertionResults.filter(a => a.status === 'passed').length;
  const failed = total - passed;
  const status = failed === 0 ? '**PASSED**' : '**FAILED**';
  const subName = suite.assertionResults[0]?.ancestorTitles[0] || fileName;
  md += `| \`${fileName}\` | ${subName} | ${total} | ${passed} | ${failed} | ${status} |\n`;
}

md += `| \`electron-smoke.cjs\` | Electron Dashboard UI/IPC E2E Verification | 1 | ${smokePassed ? 1 : 0} | ${smokePassed ? 0 : 1} | ${smokePassed ? '**PASSED**' : '**FAILED**'} |\n`;
md += `| **Total** | **All Core Domains & Electron UI/IPC E2E Verification** | **${grandTotalTests}** | **${grandPassedTests}** | **${grandFailedTests}** | **${passRate}% PASS** |\n\n`;
md += `---\n\n`;
md += `## Detailed Verified Test Logs\n\n`;

for (let i = 0; i < vitestData.testResults.length; i++) {
  const suite = vitestData.testResults[i];
  const fileName = path.basename(suite.name);
  const subName = suite.assertionResults[0]?.ancestorTitles[0] || fileName;
  md += `### ${i + 1}. ${subName} (\`tests/${fileName}\`)\n`;
  md += `\`\`\`text\n`;
  for (const t of suite.assertionResults) {
    const mark = t.status === 'passed' ? '✓' : '✗';
    md += `${mark} ${t.title}\n`;
  }
  md += `\`\`\`\n\n`;
}

const smokeMark = smokePassed ? '✓' : '✗';
md += `### ${vitestData.testResults.length + 1}. Electron UI/IPC E2E Verification (\`tests/electron-smoke.cjs\`)\n`;
md += `\`\`\`text\n`;
md += `${smokeMark} Spawns Electron with ELECTRON_RUN_AS_NODE removed\n`;
md += `${smokeMark} Loads the control/chat windows and mounts the real Dashboard renderer\n`;
md += `${smokeMark} Exercises credential save/delete and native purge-all-data through the Dashboard/preload/IPC path (vault check when safeStorage is available)\n`;
md += `${smokeMark} Exercises session save/list/get/delete and archive purge against the disk-backed repository\n`;
md += `${smokeMark} Verifies graceful shutdown lifecycle ([APP_CLEAN_SHUTDOWN], [APP_BEFORE_QUIT], [APP_WILL_QUIT])\n`;
md += `${smokeMark} Confirms [E2E_COMPLETE] and a normal exit (code 0, signal null)\n`;
md += `⚠ Physical microphone, system-audio loopback, active-display capture, and live provider networking remain manual/device-dependent tests\n`;
md += `\`\`\`\n`;
if (!smokePassed && (smokeStdout || smokeStderr || smokeResult.error)) {
  md += `\nSmoke runner output:\n\n\`\`\`text\n${(smokeStdout + '\n' + smokeStderr + '\n' + (smokeResult.error?.message || '')).slice(-6000)}\n\`\`\`\n`;
}


fs.writeFileSync(resultsPath, md, 'utf8');
console.log(`Successfully generated verified test report at: ${resultsPath}`);

// 4. Synchronize the README suite table and verification totals.
//
// The README has had more than one documented table layout. Update the
// existing table in place and preserve its schema instead of relying on a
// specific callout or heading immediately after it.
const readmePath = path.join(repoRoot, 'README.md');
if (fs.existsSync(readmePath)) {
  let readme = fs.readFileSync(readmePath, 'utf8').replace(/\r\n/g, '\n');
  const lines = readme.split('\n');
  const headerIndex = lines.findIndex(line => /^\|\s*Test Suite(?: File)?\s*\|/.test(line));
  if (headerIndex < 0) {
    throw new Error('README test suite table is missing; refusing to publish stale test evidence.');
  }

  const headerCells = lines[headerIndex].split('|').slice(1, -1).map(cell => cell.trim());
  const separatorIndex = headerIndex + 1;
  if (separatorIndex >= lines.length || !/^\|\s*:?-{3,}/.test(lines[separatorIndex])) {
    throw new Error('README test suite table has no valid Markdown separator row.');
  }

  let tableEnd = separatorIndex + 1;
  while (tableEnd < lines.length && /^\|/.test(lines[tableEnd])) tableEnd++;

  const descriptions = new Map();
  for (const row of lines.slice(separatorIndex + 1, tableEnd)) {
    const cells = row.split('|').slice(1, -1).map(cell => cell.trim());
    const codeMatch = cells[0]?.match(/`([^`]+)`/);
    const linkMatch = cells[0]?.match(/\]\(app\/tests\/([^)]+)\)/);
    const fileName = codeMatch?.[1] || linkMatch?.[1];
    if (fileName && cells[1] && fileName !== 'Total') {
      descriptions.set(fileName, cells[1]);
    }
  }

  const generatedRows = [];
  for (const suite of vitestData.testResults) {
    const fileName = path.basename(suite.name);
    const total = suite.assertionResults.length;
    const passed = suite.assertionResults.filter(a => a.status === 'passed').length;
    const status = passed === total ? 'PASSED' : 'FAILED';
    const fallbackDescription = suite.assertionResults[0]?.ancestorTitles[0] || fileName;
    const description = descriptions.get(fileName) ||
      (fileName === 'window-coordinator.test.ts'
        ? 'Window lifecycle and macOS close-all recovery'
        : fallbackDescription);

    if (headerCells.length === 3) {
      generatedRows.push(`| \`${fileName}\` | ${description} | ${passed} |`);
    } else if (headerCells.length === 5) {
      generatedRows.push(`| [\`${fileName}\`](app/tests/${fileName}) | ${description} | ${total} | ${passed} | **${status}** |`);
    } else {
      throw new Error(`Unsupported README test table schema: expected 3 or 5 columns, found ${headerCells.length}.`);
    }
  }

  const smokeDescription = 'Electron Dashboard, preload/IPC persistence and shutdown';
  if (headerCells.length === 3) {
    generatedRows.push(`| \`electron-smoke.cjs\` | ${smokeDescription} | ${smokePassed ? 1 : 0} |`);
    generatedRows.push(`| **Total** | **${totalSuites} Vitest suites + 1 Electron smoke check** | **${grandPassedTests}** |`);
  } else {
    generatedRows.push(`| [\`electron-smoke.cjs\`](app/tests/electron-smoke.cjs) | ${smokeDescription} | 1 | ${smokePassed ? 1 : 0} | **${smokePassed ? 'PASSED' : 'FAILED'}** |`);
    generatedRows.push(`| **Total** | **All Core Domains & Electron UI/IPC E2E Verification** | **${grandTotalTests}** | **${grandPassedTests}** | **${passRate}% PASS** |`);
  }

  lines.splice(headerIndex + 2, tableEnd - (headerIndex + 2), ...generatedRows);
  readme = lines.join('\n');

  const headingPattern = /Automated Verification & Test Suites \(\d+\/\d+ Passing\)/g;
  if (!headingPattern.test(readme)) {
    throw new Error('README automated-verification heading is missing its generated pass-count marker.');
  }
  readme = readme.replace(
    headingPattern,
    `Automated Verification & Test Suites (${grandPassedTests}/${grandTotalTests} Passing)`
  );

  // Keep the narrative count aligned when the README uses the current summary
  // paragraph; older layouts may not contain this paragraph.
  const latestSummary = /The latest verified CI run recorded \*\*\d+ passing automated checks\*\*: \d+ Vitest tests across \d+ suites and one Electron UI\/preload\/IPC smoke test\./;
  if (latestSummary.test(readme)) {
    readme = readme.replace(
      latestSummary,
      `The latest verified CI run recorded **${grandPassedTests} passing automated checks**: ${passedUnitTests} Vitest tests across ${totalSuites} suites and one Electron UI/preload/IPC smoke test.`
    );
  }

  // Update older README command comments only when those comments exist.
  readme = readme.replace(
    /# Run the \d+ Vitest unit & integration tests/g,
    `# Run the ${totalUnitTests} Vitest unit & integration tests`
  );
  readme = readme.replace(
    /# Generate the automated test results markdown report \(\d+ total verified (?:tests|checks)\)/g,
    `# Generate the automated test results markdown report (${grandTotalTests} total verified checks)`
  );

  fs.writeFileSync(readmePath, readme, 'utf8');
  console.log(`Synchronized README test table and totals (${grandPassedTests}/${grandTotalTests}).`);
}

// 5. Synchronize the production-readiness counts and suite breakdown.
const prodDocPath = path.join(repoRoot, 'docs', 'production', 'PRODUCTION_READINESS.md');
if (fs.existsSync(prodDocPath)) {
  // Normalize line endings so row parsing is consistent on Windows and Unix runners.
  let prodDoc = fs.readFileSync(prodDocPath, 'utf8').replace(/\r\n/g, '\n');

  prodDoc = replaceRequired(
    prodDoc,
    /\*\*(?:\d+ automated checks passing \(\d+ Vitest tests \+ 1 Electron UI\/preload\/IPC E2E smoke test\)|\d+\/\d+ automated checks passing \(\d+\/\d+ Vitest tests \+ \d+\/1 Electron UI\/preload\/IPC E2E smoke test\)) with \d+% pass rate\*\*/,
    `**${grandPassedTests}/${grandTotalTests} automated checks passing (${passedUnitTests}/${totalUnitTests} Vitest tests + ${smokePassed ? 1 : 0}/1 Electron UI/preload/IPC E2E smoke test) with ${passRate}% pass rate**`,
    'production readiness summary'
  );
  prodDoc = replaceRequired(
    prodDoc,
    /consists of \*\*\d+ automated checks\*\* across \d+ test files \([^)]*Electron UI(?:\/preload)?\/IPC E2E smoke runner\)/,
    `consists of **${grandTotalTests} automated checks** across ${totalSuites + 1} test files (${totalSuites} Vitest suites + 1 Electron UI/preload/IPC E2E smoke runner)`,
    'production readiness test count'
  );
  prodDoc = replaceRequired(
    prodDoc,
    /npm test.*?— \d+ automated tests across \d+ suites/,
    `npm test — ${totalUnitTests} automated tests across ${totalSuites} suites`,
    'production readiness Vitest command count'
  );
  prodDoc = replaceRequired(
    prodDoc,
    /npm run test:report.*?— \d+ total checks: \d+ Vitest \+ 1 Electron E2E smoke/,
    `npm run test:report — ${grandTotalTests} total checks: ${totalUnitTests} Vitest + 1 Electron E2E smoke`,
    'production readiness report command count'
  );

  const breakdownMarker = '============================== TEST EXECUTION BREAKDOWN ==============================';
  const breakdownStart = prodDoc.indexOf(breakdownMarker);
  const separator = '======================================================================================';
  const breakdownEnd = breakdownStart >= 0
    ? prodDoc.indexOf(separator, breakdownStart + breakdownMarker.length)
    : -1;
  if (breakdownStart < 0 || breakdownEnd < 0) {
    throw new Error('PRODUCTION_READINESS test breakdown markers changed; refusing to skip synchronization.');
  }

  const currentBreakdown = prodDoc.slice(breakdownStart + breakdownMarker.length, breakdownEnd);
  const descriptions = new Map();
  for (const line of currentBreakdown.split('\n')) {
    const match = line.match(/^\s*\d+\.\s+tests\/([^\s]+)\s+\d+(?:\/\d+)? passed \((.*)\)\s*$/);
    if (match) descriptions.set(match[1], match[2]);
  }

  const rows = vitestData.testResults.map((suite, index) => {
    const fileName = path.basename(suite.name);
    const total = suite.assertionResults.length;
    const passed = suite.assertionResults.filter(a => a.status === 'passed').length;
    const description = descriptions.get(fileName) ||
      (fileName === 'window-coordinator.test.ts'
        ? 'Window close recovery, macOS reinitialization & listener idempotency'
        : (suite.assertionResults[0]?.ancestorTitles[0] || fileName));
    const passSummary = passed === total ? `${passed} passed` : `${passed}/${total} passed`;
    return `${index + 1}.  tests/${fileName.padEnd(30)} ${passSummary} (${description})`;
  });
  rows.push(`${totalSuites + 1}.  tests/electron-smoke.cjs         ${smokePassed ? '1/1' : '0/1'} passed (Electron Dashboard UI/IPC E2E, native purge, persistence & normal process exit)`);

  const breakdown = [
    breakdownMarker,
    ...rows,
    '--------------------------------------------------------------------------------------',
    `Subtotal (Vitest Test Suites):      ${passedUnitTests} passing unit & integration tests`,
    `Grand Total:                        ${grandPassedTests} passing checks / ${grandTotalTests} total (${passRate}% Pass Rate)`,
    separator,
  ].join('\n');
  prodDoc = prodDoc.slice(0, breakdownStart) + breakdown +
    prodDoc.slice(breakdownEnd + separator.length);

  fs.writeFileSync(prodDocPath, prodDoc, 'utf8');
  console.log(`Synchronized PRODUCTION_READINESS counts and suite breakdown (${grandPassedTests}/${grandTotalTests}).`);
}

if (grandFailedTests > 0) {
  console.error(`Test report verification FAILED: ${grandFailedTests} test(s) failed.`);
  process.exit(1);
}

