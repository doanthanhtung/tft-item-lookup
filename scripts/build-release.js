const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const owner = process.env.TFT_GITHUB_OWNER || '';
const repo = process.env.TFT_GITHUB_REPO || '';
const publishMode = process.env.TFT_PUBLISH || 'always';
const configPath = path.join(__dirname, '..', 'electron', 'update-config.json');

function fail(message) {
  console.error(`[release] ${message}`);
  process.exit(1);
}

if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
  fail('Cần TFT_GITHUB_OWNER và TFT_GITHUB_REPO hợp lệ.');
}
if (!process.env.CSC_LINK) fail('Thiếu CSC_LINK. Bản release phải được ký số Authenticode.');
if (publishMode === 'always' && !process.env.GH_TOKEN) fail('Thiếu GH_TOKEN để publish GitHub Release.');

const previous = fs.readFileSync(configPath, 'utf8');
const updateConfig = {
  enabled: true,
  provider: 'github',
  owner,
  repo,
  private: process.env.TFT_GITHUB_PRIVATE === '1',
};
fs.writeFileSync(configPath, `${JSON.stringify(updateConfig, null, 2)}\n`, 'utf8');

try {
  const cliPath = require.resolve('electron-builder/cli');
  const args = [cliPath, '--win', 'nsis', '--publish', publishMode, '-c.publish.provider=github', `-c.publish.owner=${owner}`, `-c.publish.repo=${repo}`];
  if (updateConfig.private) args.push('-c.publish.private=true');
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', env: process.env });
  process.exitCode = result.status ?? 1;
} finally {
  fs.writeFileSync(configPath, previous, 'utf8');
}
