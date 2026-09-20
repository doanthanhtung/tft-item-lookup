const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const owner = process.env.TFT_GITHUB_OWNER || '';
const repo = process.env.TFT_GITHUB_REPO || '';
const publishMode = process.env.TFT_PUBLISH || 'always';
const tag = process.env.TFT_RELEASE_TAG || process.env.GITHUB_REF_NAME || 'v' + packageJson.version;
const configPath = path.join(root, 'electron', 'update-config.json');
const distDir = path.join(root, 'dist');
const artifactName = 'TFT-Item-Lookup-' + packageJson.version + '-portable.exe';
const artifactPath = path.join(distDir, artifactName);
const manifestPath = path.join(distDir, 'latest.json');

function fail(message) {
  throw new Error('[release] ' + message);
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: process.env, windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(command + ' exited with code ' + result.status);
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const input = fs.createReadStream(filePath);
  for await (const chunk of input) hash.update(chunk);
  return hash.digest('hex');
}

function publishRelease(manifest) {
  const releaseArgs = ['release', 'view', tag, '--repo', owner + '/' + repo];
  const existing = spawnSync('gh', releaseArgs, { cwd: root, stdio: 'ignore', env: process.env, windowsHide: true });
  if (existing.status !== 0) {
    run('gh', [
      'release', 'create', tag,
      '--repo', owner + '/' + repo,
      '--title', 'TFT Item Lookup ' + tag,
      '--notes', 'Portable Windows build. Chạy trực tiếp, không cần cài đặt.',
      '--latest',
      artifactPath,
      manifestPath,
    ]);
    return;
  }
  run('gh', ['release', 'upload', tag, artifactPath, manifestPath, '--repo', owner + '/' + repo, '--clobber']);
  run('gh', ['release', 'edit', tag, '--repo', owner + '/' + repo, '--draft=false', '--latest', '--title', 'TFT Item Lookup ' + tag]);
}

async function main() {
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
    fail('Cần TFT_GITHUB_OWNER và TFT_GITHUB_REPO hợp lệ.');
  }
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) fail('TFT_RELEASE_TAG không hợp lệ.');
  if (!process.env.CSC_LINK) fail('Thiếu CSC_LINK. Bản release phải được ký số Authenticode.');
  if (publishMode === 'always' && !process.env.GH_TOKEN) fail('Thiếu GH_TOKEN để publish GitHub Release.');

  const previous = fs.readFileSync(configPath, 'utf8');
  const updateConfig = {
    enabled: true,
    distribution: 'portable',
    provider: 'github',
    owner,
    repo,
    private: process.env.TFT_GITHUB_PRIVATE === '1',
    manifestUrl: 'https://github.com/' + owner + '/' + repo + '/releases/latest/download/latest.json',
    releaseUrl: 'https://github.com/' + owner + '/' + repo + '/releases',
  };
  fs.writeFileSync(configPath, JSON.stringify(updateConfig, null, 2) + '\n', 'utf8');

  try {
    const cliPath = require.resolve('electron-builder/cli');
    run(process.execPath, [cliPath, '--win', 'portable', '--publish', 'never']);
    if (!fs.existsSync(artifactPath)) fail('Không tìm thấy artifact portable: ' + artifactPath);
    const stat = fs.statSync(artifactPath);
    const manifest = {
      schemaVersion: 1,
      version: packageJson.version,
      platform: 'win32-x64',
      assetName: artifactName,
      downloadUrl: 'https://github.com/' + owner + '/' + repo + '/releases/download/' + tag + '/' + artifactName,
      sha256: await sha256File(artifactPath),
      size: stat.size,
      releaseUrl: 'https://github.com/' + owner + '/' + repo + '/releases/tag/' + tag,
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    if (publishMode === 'always') publishRelease(manifest);
  } finally {
    fs.writeFileSync(configPath, previous, 'utf8');
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
