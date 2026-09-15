const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#a78bfa"/>
      <stop offset="1" stop-color="#5b21b6"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.22" r="0.8">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.22"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <rect width="512" height="512" rx="112" fill="url(#bg)"/>
  <rect width="512" height="512" rx="112" fill="url(#glow)"/>
  <rect x="6" y="6" width="500" height="500" rx="106" fill="none" stroke="#ffffff" stroke-opacity="0.16" stroke-width="8"/>

  <ellipse cx="270" cy="426" rx="150" ry="16" fill="#1e1b4b" opacity="0.18"/>

  <path d="M256 112
    C 160 112 144 196 144 252
    L 144 372
    C 144 392 156 404 172 404
    C 186 404 194 390 202 372
    C 210 352 220 352 228 372
    C 236 392 248 392 256 372
    C 264 352 274 352 282 372
    C 290 392 302 392 310 372
    C 318 352 328 352 336 372
    C 344 390 352 404 366 404
    C 384 404 396 392 396 372
    L 396 252
    C 396 196 352 112 256 112 Z"
    fill="#ffffff"/>

  <ellipse cx="210" cy="224" rx="17" ry="24" fill="#4c1d95"/>
  <ellipse cx="302" cy="224" rx="17" ry="24" fill="#4c1d95"/>

  <circle cx="164" cy="276" r="14" fill="#f5d0fe" opacity="0.9"/>
  <circle cx="348" cy="276" r="14" fill="#f5d0fe" opacity="0.9"/>

  <path d="M236 284 C 246 296, 266 296, 276 284" fill="none" stroke="#4c1d95" stroke-width="8" stroke-linecap="round"/>

  <rect x="312" y="44" width="150" height="104" rx="32" fill="#ffffff"/>
  <path d="M330 148 L 370 148 L 346 182 Z" fill="#ffffff"/>

  <path d="M 377 64 C 377 50 391 44 401 44 C 415 44 425 52 425 66 C 425 78 417 86 407 92 C 399 97 395 102 395 110 L 395 116"
    fill="none" stroke="#8a5cf6" stroke-width="12" stroke-linecap="round"/>
  <circle cx="395" cy="142" r="7" fill="#8a5cf6"/>

  <path d="M90 137 Q90 150 103 150 Q90 150 90 163 Q90 150 77 150 Q90 150 90 137 Z" fill="#ffffff" opacity="0.92"/>
  <path d="M130 401 Q130 410 139 410 Q130 410 130 419 Q130 410 121 410 Q130 410 130 401 Z" fill="#ffffff" opacity="0.8"/>
  <path d="M452 210 Q452 220 462 220 Q452 220 452 230 Q452 220 442 220 Q452 220 452 210 Z" fill="#ffffff" opacity="0.85"/>
</svg>`;

const sizes = [16, 24, 32, 48, 64, 128, 256];

function buildIco(pngBuffers) {
  const count = pngBuffers.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);
  const entries = [];
  let offset = 6 + 16 * count;
  pngBuffers.forEach((buf, index) => {
    const size = sizes[index];
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(buf.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += buf.length;
  });
  return Buffer.concat([header, ...entries, ...pngBuffers]);
}

async function main() {
  const root = path.join(__dirname, '..');
  const buildDir = path.join(root, 'build');
  fs.mkdirSync(buildDir, { recursive: true });

  const pngBuffers = [];
  for (const size of sizes) {
    const buf = await sharp(Buffer.from(SVG)).resize(size, size).png().toBuffer();
    pngBuffers.push(buf);
  }

  const iconPng512 = await sharp(Buffer.from(SVG)).resize(512, 512).png().toBuffer();
  const iconIco = buildIco(pngBuffers);
  const avatar512 = await sharp(Buffer.from(SVG)).resize(512, 512).png().toBuffer();
  const avatar1024 = await sharp(Buffer.from(SVG)).resize(1024, 1024).png().toBuffer();

  fs.writeFileSync(path.join(buildDir, 'icon.png'), iconPng512);
  fs.writeFileSync(path.join(buildDir, 'icon.ico'), iconIco);
  fs.writeFileSync(path.join(buildDir, 'avatar.png'), avatar512);
  fs.writeFileSync(path.join(buildDir, 'avatar-1024.png'), avatar1024);
  fs.writeFileSync(path.join(root, 'avatar.png'), avatar512);

  console.log('OK:');
  console.log('  build/icon.png       ' + iconPng512.length + ' bytes');
  console.log('  build/icon.ico       ' + iconIco.length + ' bytes (' + sizes.join(',') + ' px)');
  console.log('  build/avatar.png     ' + avatar512.length + ' bytes');
  console.log('  build/avatar-1024.png ' + avatar1024.length + ' bytes');
  console.log('  avatar.png (корень)  ' + avatar512.length + ' bytes');
}

main().catch((error) => {
  console.error('FAILED:', error.message);
  process.exit(1);
});