// Скачивает движок Piper (сборка 2023.11.14-2, тогда MIT) и голос dmitri (CC0-датасет)
// в vendor/piper. Нужен для сборки: бинарники в git не хранятся (vendor/piper в .gitignore).
// Запуск: node scripts/fetch-piper.js
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const vendor = path.join(root, 'vendor', 'piper');
const voices = path.join(vendor, 'voices');

const ENGINE_URL = 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip';
const MODEL_URL = 'https://media.githubusercontent.com/media/smseagle/piper-voices/downloads/ru/ru_RU/dmitri/medium/ru_RU-dmitri-medium.onnx';
const MODEL_JSON_URL = 'https://raw.githubusercontent.com/smseagle/piper-voices/downloads/ru/ru_RU/dmitri/medium/ru_RU-dmitri-medium.onnx.json';

function download(url, dest) {
  console.log('Скачиваю: ' + url);
  const res = execFileSync('curl.exe', ['-L', '-s', '-o', dest, url, '-w', '%{http_code}'], { encoding: 'utf8' });
  if (String(res).trim() !== '200') throw new Error('HTTP ' + res + ' для ' + url);
  console.log('  -> ' + dest + ' (' + Math.round(fs.statSync(dest).size / 1024 / 1024) + ' МБ)');
}

fs.mkdirSync(voices, { recursive: true });

if (fs.existsSync(path.join(vendor, 'piper.exe')) && fs.existsSync(path.join(voices, 'dmitri.onnx'))) {
  console.log('vendor/piper уже на месте — ничего не качаю.');
  process.exit(0);
}

const zip = path.join(vendor, 'piper_windows_amd64.zip');
download(ENGINE_URL, zip);
execFileSync('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${vendor}' -Force`], { stdio: 'inherit' });
fs.rmSync(zip, { force: true });

download(MODEL_URL, path.join(voices, 'dmitri.onnx'));
download(MODEL_JSON_URL, path.join(voices, 'dmitri.onnx.json'));

console.log('Готово: ' + vendor);
