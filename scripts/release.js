const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkgPath = path.join(root, 'package.json');
const lockPath = path.join(root, 'node_modules', '.ghostit-build-lock');

const args = process.argv.slice(2);
const newVersion = args.find((a) => /^\d+\.\d+\.\d+/.test(a)) || null;
const doPull = args.includes('--pull');

function fail(message) {
  console.error('❌ ' + message);
  process.exit(1);
}

if (fs.existsSync(lockPath)) {
  fail('Идёт другая сборка (node_modules/.ghostit-build-lock существует). Дождись её завершения и не запускай electron-builder параллельно.');
}

fs.writeFileSync(lockPath, String(process.pid));

function releaseLock() {
  try { fs.rmSync(lockPath, { force: true }); } catch {}
}
process.on('exit', releaseLock);
process.on('SIGINT', () => { releaseLock(); process.exit(130); });

try {
  if (newVersion) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    pkg.version = newVersion;
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
    console.log('📦 Версия зафиксирована: ' + newVersion);
  } else {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    console.log('📦 Версия из package.json: ' + pkg.version);
    console.log('   Совет: передай новую версию, например: npm run release -- 0.2.0');
  }

  if (doPull) {
    try {
      execSync('git pull --ff-only', { cwd: root, stdio: 'inherit' });
      console.log('🔄 git pull выполнен');
    } catch (e) {
      console.warn('⚠️ git pull не удался (возможно, незакоммиченные изменения). Продолжаю со сборочным деревом как есть.');
    }
  }

  console.log('🧹 Чищу dist перед сборкой…');
  fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });

  console.log('🔨 Сборка (electron-builder)…');
  execSync('npm run dist', { cwd: root, stdio: 'inherit' });

  console.log('✅ Сборка завершена: dist/GhostIT.exe');
} catch (e) {
  const msg = e && e.message ? e.message.split('\n')[0] : String(e);
  fail('Сборка упала: ' + msg);
}