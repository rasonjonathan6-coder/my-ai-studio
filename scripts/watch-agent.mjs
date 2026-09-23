// Streams live agent/build/terminal events for a project over the WebSocket so
// a run can be observed as it happens instead of polled from the database.
//
// Usage: node scripts/watch-agent.mjs <projectId> <token> [seconds]
// Run with NODE_PATH=$(pwd)/backend/node_modules so `ws` resolves.
import WebSocket from 'ws';

const [projectId, token, seconds = '120'] = process.argv.slice(2);
if (!projectId || !token) {
  console.error('usage: node scripts/watch-agent.mjs <projectId> <token> [seconds]');
  process.exit(2);
}

const url = `ws://127.0.0.1:8080/ws?projectId=${projectId}&token=${token}`;
const ws = new WebSocket(url);
const seen = new Map();

const timer = setTimeout(() => {
  console.log(`\n[timeout after ${seconds}s]`);
  ws.close();
}, Number(seconds) * 1000);

ws.on('open', () => console.log(`connected to ${url.replace(token, '***')}`));
ws.on('message', (data) => {
  let msg;
  try { msg = JSON.parse(data.toString()); } catch { console.log('raw', data.toString().slice(0, 160)); return; }
  seen.set(msg.type, (seen.get(msg.type) ?? 0) + 1);
  const detail = msg.message ?? msg.phase ?? msg.level ?? '';
  console.log(`${msg.type.padEnd(14)} ${String(detail).replace(/sk-or-v1-[A-Za-z0-9]+/g, '[REDACTED]').slice(0, 140)}`);
});
ws.on('error', (e) => console.log('error:', e.message));
ws.on('close', () => {
  clearTimeout(timer);
  console.log('\nevent counts:', [...seen.entries()].map(([k, v]) => `${k}=${v}`).join(' '));
  process.exit(0);
});
