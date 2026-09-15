const fs = require('fs');

const MOJIBAKE_MARKERS = new Set(
  '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ¤¦§¨©ª«¬®¯°±²³´µ¶·¸¹º»¼½¾¿' +
  'ЂЃѓєѕіїјљњћќўџЉЊЌЋЏЎЈҐґђ'
);

const TABLE = {};
(function buildTable() {
  const entries = [
    [0x80,'Ђ'],[0x81,'Ѓ'],[0x82,'‚'],[0x83,'ѓ'],[0x84,'„'],[0x85,'…'],[0x86,'†'],[0x87,'‡'],
    [0x88,'€'],[0x89,'‰'],[0x8A,'Љ'],[0x8B,'‹'],[0x8C,'Њ'],[0x8D,'Ќ'],[0x8E,'Ћ'],[0x8F,'Џ'],
    [0x90,'ђ'],[0x91,'‘'],[0x92,'’'],[0x93,'“'],[0x94,'”'],[0x95,'•'],[0x96,'–'],[0x97,'—'],
    [0x98,'˜'],[0x99,'™'],[0x9A,'љ'],[0x9B,'›'],[0x9C,'њ'],[0x9D,'ќ'],[0x9E,'ћ'],[0x9F,'џ'],
    [0xA0,'\u00A0'],[0xA1,'Ў'],[0xA2,'ў'],[0xA3,'Ј'],[0xA4,'¤'],[0xA5,'Ґ'],[0xA6,'¦'],[0xA7,'§'],
    [0xA8,'Ё'],[0xA9,'©'],[0xAA,'Є'],[0xAB,'«'],[0xAC,'¬'],[0xAD,'\u00AD'],[0xAE,'®'],[0xAF,'Ї'],
    [0xB0,'°'],[0xB1,'±'],[0xB2,'І'],[0xB3,'і'],[0xB4,'ґ'],[0xB5,'µ'],[0xB6,'¶'],[0xB7,'·'],
    [0xB8,'ё'],[0xB9,'№'],[0xBA,'є'],[0xBB,'»'],[0xBC,'ј'],[0xBD,'Ѕ'],[0xBE,'ѕ'],[0xBF,'ї']
  ];
  for (let b = 0xC0; b <= 0xDF; b++) entries.push([b, String.fromCharCode(0x410 + (b - 0xC0))]);
  for (let b = 0xE0; b <= 0xFF; b++) entries.push([b, String.fromCharCode(0x430 + (b - 0xE0))]);
  for (const [b, ch] of entries) TABLE[ch] = b;
})();

function decodeMojibake(s) {
  const bytes = [];
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (code < 0x80) { bytes.push(code); continue; }
    const b = TABLE[ch];
    if (b === undefined) return null;
    bytes.push(b);
  }
  const decoded = Buffer.from(bytes).toString('utf8');
  const cyr = (decoded.match(/[а-яА-ЯёЁ]/g) || []).length;
  if (cyr === 0) return null;
  if (decoded.includes('\uFFFD')) return null;
  return decoded;
}

function looksMojibake(s) {
  let markers = 0;
  for (const ch of s) {
    if (MOJIBAKE_MARKERS.has(ch)) markers++;
  }
  return markers >= 1;
}

const targets = process.argv.slice(2);
let changedFiles = 0;
let changedLines = 0;

for (const file of targets) {
  if (!fs.existsSync(file)) continue;
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split('\n');
  let anyChange = false;
  const out = lines.map((line) => {
    if (!looksMojibake(line)) return line;
    if (!/[а-яА-ЯёЁ]/.test(line)) return line;
    const fixed = decodeMojibake(line);
    if (!fixed || fixed === line) return line;
    anyChange = true;
    changedLines++;
    console.log(`FIX ${file}:`);
    console.log(`  OLD: ${line.trim().slice(0, 160)}`);
    console.log(`  NEW: ${fixed.trim().slice(0, 160)}`);
    return fixed;
  });
  if (anyChange) {
    fs.writeFileSync(file, out.join('\n'), 'utf8');
    changedFiles++;
  }
}

console.log(`\nИсправлено файлов: ${changedFiles}, строк: ${changedLines}`);