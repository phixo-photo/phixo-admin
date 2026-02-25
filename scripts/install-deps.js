#!/usr/bin/env node
// Runs after npm install - downloads yt-dlp binary
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

const binDir = path.join(__dirname, '..', 'bin');
const ytdlpPath = path.join(binDir, 'yt-dlp');

if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });

// Check if already installed and working
try {
  const ver = execSync(`"${ytdlpPath}" --version 2>/dev/null`, { encoding: 'utf8' }).trim();
  console.log(`[postinstall] yt-dlp already at ${ytdlpPath} (${ver})`);
  process.exit(0);
} catch(e) {}

console.log('[postinstall] Downloading yt-dlp...');
const url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';

const file = fs.createWriteStream(ytdlpPath);
function download(url, dest, cb) {
  https.get(url, (res) => {
    if (res.statusCode === 301 || res.statusCode === 302) {
      return download(res.headers.location, dest, cb);
    }
    res.pipe(file);
    file.on('finish', () => { file.close(cb); });
  }).on('error', (err) => {
    fs.unlink(dest, () => {});
    cb(err);
  });
}

download(url, ytdlpPath, (err) => {
  if (err) {
    console.error('[postinstall] yt-dlp download failed:', err.message);
    console.log('[postinstall] Will try pip3 at runtime');
    process.exit(0); // Don't fail the build
  }
  try {
    fs.chmodSync(ytdlpPath, '755');
    const ver = execSync(`"${ytdlpPath}" --version`, { encoding: 'utf8' }).trim();
    console.log(`[postinstall] yt-dlp installed: ${ver}`);
  } catch(e) {
    console.error('[postinstall] yt-dlp installed but failed to run:', e.message);
  }
});
