// Log-only placeholder receiver of the couli Alertmanager (B1-25a). Listens on 127.0.0.1 only and
// writes one JSON line per alert of each webhook it receives to stdout: the receiver (the URL
// path), status, alertname, fund, severity, app_id and startsAt. Nothing is forwarded anywhere.
// Node built-in modules only. Usage: node log-sink.mjs [port] (default 9096).
import { createServer } from 'node:http';
import { resolve } from 'node:path';

const PORT = Number(process.argv[2] ?? '9096');
const MAX_BYTES = 1024 * 1024;
const RECEIVERS = new Set(['finance', 'oncall']);

/** The log lines of one Alertmanager webhook body (version 4), or null when it is not one. */
export function linesOf(receiver, body, now) {
  let doc;
  try {
    doc = JSON.parse(body);
  } catch {
    return null;
  }
  if (doc === null || typeof doc !== 'object' || !Array.isArray(doc.alerts)) return null;
  return doc.alerts.map((a) => {
    const labels =
      a && typeof a === 'object' && a.labels && typeof a.labels === 'object' ? a.labels : {};
    return JSON.stringify({
      at: now.toISOString(),
      receiver,
      status: typeof a?.status === 'string' ? a.status : null,
      alertname: labels.alertname ?? null,
      fund: labels.fund ?? null,
      severity: labels.severity ?? null,
      app_id: labels.app_id ?? null,
      startsAt: typeof a?.startsAt === 'string' ? a.startsAt : null,
    });
  });
}

function main() {
  const server = createServer((req, res) => {
    const receiver = (req.url ?? '').replace(/^\//, '').split('?')[0];
    if (req.method !== 'POST' || !RECEIVERS.has(receiver)) {
      res.writeHead(404).end();
      return;
    }
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BYTES) {
        res.writeHead(413).end();
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (size > MAX_BYTES) return;
      const lines = linesOf(receiver, Buffer.concat(chunks).toString('utf8'), new Date());
      if (lines === null) {
        res.writeHead(400).end();
        return;
      }
      for (const line of lines) process.stdout.write(line + '\n');
      res.writeHead(200).end();
    });
  });
  server.listen(PORT, '127.0.0.1');
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) main();
