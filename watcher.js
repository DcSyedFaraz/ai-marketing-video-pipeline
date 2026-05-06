/**
 * Dev watcher — spawns server.js and restarts it whenever JS source files change.
 * Watches: server.js, routes/*.js, lib/*.js
 * Run via: node watcher.js  (or npm start / npm run gui)
 */

import { watch, existsSync } from 'fs';
import { spawn } from 'child_process';
import { resolve, join } from 'path';

const SERVER_SCRIPT = resolve('server.js');
const WATCH_DIRS    = ['routes', 'lib'];
const DEBOUNCE_MS   = 300; // wait 300ms after last change before restarting

let serverProcess = null;
let restartTimer  = null;

function spawnServer() {
  serverProcess = spawn(process.execPath, [SERVER_SCRIPT], {
    stdio: 'inherit',
    env: process.env,
  });

  serverProcess.on('close', (code) => {
    // Only log non-zero exits (zero means we killed it ourselves for restart)
    if (code !== null && code !== 0 && code !== null) {
      console.error(`\n[Watcher] Server exited with code ${code}`);
    }
  });
}

function scheduleRestart(changedFile) {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    console.log(`\n[Watcher] 🔄 ${changedFile} changed — restarting server...\n`);
    if (serverProcess) {
      serverProcess.kill();
      serverProcess = null;
    }
    setTimeout(spawnServer, 100);
  }, DEBOUNCE_MS);
}

// Watch server.js itself
if (existsSync(SERVER_SCRIPT)) {
  watch(SERVER_SCRIPT, () => scheduleRestart('server.js'));
}

// Watch routes/ and lib/ directories (non-recursive, catches direct .js file changes)
for (const dir of WATCH_DIRS) {
  const dirPath = resolve(dir);
  if (existsSync(dirPath)) {
    watch(dirPath, (event, filename) => {
      if (filename?.endsWith('.js')) {
        scheduleRestart(`${dir}/${filename}`);
      }
    });
    console.log(`[Watcher] 👁  Watching ${dir}/`);
  }
}
console.log('[Watcher] 👁  Watching server.js');
console.log('[Watcher] Starting server...\n');

// Forward Ctrl+C / SIGTERM to child so it can shut down cleanly
process.on('SIGINT', () => {
  if (serverProcess) serverProcess.kill('SIGINT');
  process.exit(0);
});
process.on('SIGTERM', () => {
  if (serverProcess) serverProcess.kill('SIGTERM');
  process.exit(0);
});

spawnServer();
