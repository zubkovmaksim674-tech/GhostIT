const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const OWNER = 'zubkovmaksim674-tech';
// репо переименован ghostqa -> ghostit; держим актуальное имя: 301-редирект GitHub
// временный (сломается, если кто-то займёт имя ghostqa)
const REPO = 'ghostit';
const API_URL = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${OWNER}/${REPO}/releases/latest`;

function getJson(url, redirects) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Слишком много редиректов'));
    https.get(url, {
      headers: {
        'User-Agent': 'GhostIT-updater',
        'Accept': 'application/vnd.github+json'
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(getJson(res.headers.location, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('GitHub API: HTTP ' + res.statusCode));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (error) { reject(error); }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

function parseVersion(tag) {
  return String(tag || '').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
}

function isNewer(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return false;
}

async function checkLatest(currentVersion) {
  const release = await getJson(API_URL, 0);
  const exes = (release.assets || []).filter((a) => /\.exe$/i.test(a.name));
  const asset = exes.find((a) => !/setup/i.test(a.name)) || exes[0];
  if (!asset) throw new Error('В релизе нет exe-файла');
  const version = String(release.tag_name || '').replace(/^v/i, '');
  return {
    version,
    hasUpdate: isNewer(version, currentVersion),
    url: String(asset.browser_download_url || ''),
    name: String(asset.name || ''),
    size: Number(asset.size) || 0,
    page: String(release.html_url || '')
  };
}

function downloadUpdate(url, destFile, onProgress) {
  return new Promise((resolve, reject) => {
    const tmpFile = destFile + '.part';
    const doDownload = (currentUrl, redirects) => {
      if (redirects > 6) return reject(new Error('Слишком много редиректов при скачивании'));
      https.get(currentUrl, { headers: { 'User-Agent': 'GhostIT-updater' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return doDownload(new URL(res.headers.location, currentUrl).href, redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('HTTP ' + res.statusCode + ' при скачивании'));
        }
        const total = Number(res.headers['content-length']) || 0;
        let received = 0;
        const out = fs.createWriteStream(tmpFile);
        res.on('data', (chunk) => {
          received += chunk.length;
          if (onProgress && total) {
            onProgress(Math.min(100, Math.round((received / total) * 100)), received, total);
          }
        });
        res.on('error', (error) => { out.close(); fs.unlink(tmpFile, () => {}); reject(error); });
        out.on('error', (error) => { fs.unlink(tmpFile, () => {}); reject(error); });
        out.on('finish', () => {
          out.close(() => {
            fs.rename(tmpFile, destFile, (error) => error ? reject(error) : resolve(destFile));
          });
        });
        res.pipe(out);
      }).on('error', reject);
    };
    doDownload(url, 0);
  });
}

function currentExePath() {
  return process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
}

function installUpdate(downloadedFile) {
  const target = currentExePath();
  const dir = path.dirname(downloadedFile);
  const helper = path.join(dir, 'ghostit-update-helper.js');
  const logPath = path.join(dir, 'ghostit-update.log');
  const helperSrc = [
    'const fs = require("fs");',
    'const { spawn } = require("child_process");',
    'const [downloaded, tgt, logPath] = process.argv.slice(2);',
    'const log = (m) => { try { fs.appendFileSync(logPath, new Date().toISOString() + " " + m + "\\n"); } catch {} };',
    'let tries = 0;',
    'function attempt() {',
    '  try {',
    '    fs.copyFileSync(downloaded, tgt);',
    '    log("OK copied, tries=" + tries);',
    '    const child = spawn(tgt, [], { detached: true, stdio: "ignore" });',
    '    child.unref();',
    '    try { fs.unlinkSync(downloaded); } catch {}',
    '    try { fs.unlinkSync(process.argv[1]); } catch {}',
    '    process.exit(0);',
    '  } catch (e) {',
    '    tries++;',
    '    log("try " + tries + ": " + e.message);',
    '    if (tries > 90) { log("giving up"); process.exit(1); }',
    '    setTimeout(attempt, 1000);',
    '  }',
    '}',
    'setTimeout(attempt, 1500);'
  ].join('\n');
  fs.writeFileSync(helper, helperSrc, 'utf8');
  // same Electron binary runs helper as plain Node — no console window at all
  const child = spawn(process.execPath, [helper, downloadedFile, target, logPath], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' })
  });
  child.unref();
  return true;
}

module.exports = { checkLatest, downloadUpdate, installUpdate, currentExePath, RELEASES_PAGE };
