// run.js - supervisor for stream.js
// Restarts stream.js if it crashes OR freezes (no heartbeat/output for SILENCE_MS).
const { spawn, execSync } = require('child_process');
const path = require('path');

const SILENCE_MS = 60000;      // stream.js sends a silent heartbeat every 5s once streaming
const RESTART_DELAY_MS = 3000;
const MAX_QUICK_FAILS = 5;     // stop if it keeps dying right at startup (bad config)

let child = null;
let timer = null;
let last = Date.now();
let startedAt = 0;
let quickFails = 0;
let stopping = false;

function killTree(c) {
  if (!c || !c.pid) return;
  try {
    if (process.platform === 'win32') execSync(`taskkill /pid ${c.pid} /T /F`, { stdio: 'ignore' });
    else c.kill('SIGKILL');
  } catch (e) { /* already dead */ }
}

function start() {
  last = Date.now();
  startedAt = Date.now();
  child = spawn(process.execPath, [path.join(__dirname, 'stream.js')], {
    stdio: ['inherit', 'pipe', 'pipe', 'ipc'],
    env: process.env,
  });

  child.on('message', () => { last = Date.now(); });
  child.stdout.on('data', d => { last = Date.now(); process.stdout.write(d); });
  child.stderr.on('data', d => { last = Date.now(); process.stderr.write(d); });

  child.on('exit', code => {
    clearInterval(timer);
    if (stopping) return process.exit(0);
    quickFails = Date.now() - startedAt < 15000 ? quickFails + 1 : 0;
    if (quickFails >= MAX_QUICK_FAILS) {
      console.error('❌ stream.js keeps failing at startup - check your .env / files. Stopping.');
      return process.exit(1);
    }
    console.log(`🔁 stream.js exited (code ${code}). Restarting in ${RESTART_DELAY_MS / 1000}s...`);
    setTimeout(start, RESTART_DELAY_MS);
  });

  timer = setInterval(() => {
    if (Date.now() - last > SILENCE_MS) {
      console.error(`🐢 stream.js frozen (no heartbeat for ${SILENCE_MS / 1000}s) - killing and restarting`);
      last = Date.now();
      killTree(child);
    }
  }, 5000);
}

process.on('SIGINT', () => {
  stopping = true;
  killTree(child);
  setTimeout(() => process.exit(0), 500);
});

start();
