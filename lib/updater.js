const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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
  const count = Math.max(a.length, b.length, 3);
  for (let i = 0; i < count; i++) {
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
  const setup = exes.find((a) => /setup/i.test(a.name));
  const version = String(release.tag_name || '').replace(/^v/i, '');
  return {
    version,
    hasUpdate: isNewer(version, currentVersion),
    url: String(asset.browser_download_url || ''),
    name: String(asset.name || ''),
    size: Number(asset.size) || 0,
    digest: String(asset.digest || '').toLowerCase(),
    setupUrl: setup ? String(setup.browser_download_url || '') : '',
    setupName: setup ? String(setup.name || '') : '',
    setupSize: setup ? Number(setup.size) || 0 : 0,
    setupDigest: setup ? String(setup.digest || '').toLowerCase() : '',
    page: String(release.html_url || '')
  };
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function downloadUpdate(url, destFile, onProgress, expectedDigest) {
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
          out.close(async () => {
            const expected = String(expectedDigest || '').replace(/^sha256:/i, '').toLowerCase();
            if (expected) {
              try {
                const actual = await sha256File(tmpFile);
                if (actual !== expected) {
                  fs.unlink(tmpFile, () => {});
                  return reject(new Error('Не совпала контрольная сумма обновления'));
                }
              } catch (error) {
                fs.unlink(tmpFile, () => {});
                return reject(error);
              }
            }
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
    '    try { fs.unlinkSync(logPath); } catch {}',
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

// Хелпер установки для NSIS-сборки. Запускается через wscript.exe (GUI-подсистема:
// консольного окна не бывает даже при detached) — cmd.exe в 0.2.8 показывал чёрный
// терминал и мог зависнуть, апдейт не доезжал. Логика: ждём выход приложения по
// точному PID (WMI, максимум ~90 с), снимаем оставшиеся процессы (STT-воркер тоже
// держит exe), ставим Setup /S скрыто, перезапускаем приложение и самоудаляемся.
// Аргументы передаются только через командную строку (кириллица/пробелы в путях).
const SETUP_HELPER_VBS = [
  'Option Explicit',
  'Dim fso, sh, wmi, pid, setupPath, appPath, logPath, exeName, i, col, rc',
  'Set fso = CreateObject("Scripting.FileSystemObject")',
  'Set sh = CreateObject("WScript.Shell")',
  'pid = CLng(WScript.Arguments(0))',
  'setupPath = WScript.Arguments(1)',
  'appPath = WScript.Arguments(2)',
  'logPath = WScript.Arguments(3)',
  'exeName = fso.GetFileName(appPath)',
  'On Error Resume Next',
  'Set wmi = GetObject("winmgmts:\\\\.\\root\\cimv2")',
  'On Error GoTo 0',
  'If IsObject(wmi) Then',
  '  For i = 1 To 90',
  '    Set col = wmi.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE ProcessId=" & pid)',
  '    If col.Count = 0 Then Exit For',
  '    WScript.Sleep 1000',
  '  Next',
  'End If',
  'On Error Resume Next',
  'sh.Run "taskkill /IM " & exeName & " /T /F", 0, True',
  'On Error GoTo 0',
  'WScript.Sleep 1500',
  'rc = sh.Run("""" & setupPath & """ /S", 0, True)',
  'If rc <> 0 Then LogIt "setup_failed rc=" & rc',
  'If Not IsRunning(exeName) Then',
  '  On Error Resume Next',
  '  sh.Run """" & appPath & """", 1, False',
  '  On Error GoTo 0',
  'End If',
  'If rc = 0 Then',
  '  On Error Resume Next',
  '  fso.DeleteFile setupPath, True',
  '  On Error GoTo 0',
  'End If',
  'On Error Resume Next',
  'fso.DeleteFile WScript.ScriptFullName, True',
  'On Error GoTo 0',
  '',
  'Sub LogIt(msg)',
  '  On Error Resume Next',
  '  Dim f',
  '  Set f = fso.OpenTextFile(logPath, 8, True)',
  '  f.WriteLine Now & " " & msg',
  '  f.Close',
  'End Sub',
  '',
  'Function IsRunning(name)',
  '  IsRunning = False',
  '  If Not IsObject(wmi) Then Exit Function',
  '  Dim q',
  '  On Error Resume Next',
  '  Set q = wmi.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE Name=\x27" & name & "\x27")',
  '  If q.Count > 0 Then IsRunning = True',
  'End Function'
].join('\r\n');

function installSetupLocal(setupFile, appExePath, dir) {
  const logPath = path.join(dir, 'ghostit-update.log');
  const helper = path.join(dir, 'ghostit-update-helper.vbs');
  try { fs.rmSync(logPath, { force: true }); } catch {}
  try { fs.rmSync(helper, { force: true }); } catch {}
  try {
    fs.writeFileSync(helper, SETUP_HELPER_VBS, 'ascii');
  } catch {
    return runSetupFallback(setupFile);
  }
  try {
    const child = spawn('wscript.exe', ['//B', '//NoLogo', helper, String(process.pid), setupFile, appExePath, logPath], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore'
    });
    child.unref();
    return true;
  } catch {
    return runSetupFallback(setupFile);
  }
}

// Крайний случай (WScript отключён политикой): Setup запускается напрямую —
// GUI-процесс, консольного окна нет; приложение выходит сразу после вызова.
function runSetupFallback(setupFile) {
  try {
    const child = spawn(setupFile, ['/S'], { detached: true, windowsHide: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

module.exports = { checkLatest, downloadUpdate, installUpdate, installSetupLocal, currentExePath, RELEASES_PAGE, parseVersion, isNewer, SETUP_HELPER_VBS };
