import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { makeTempDir } from './helpers.js';

// Real server process (network listener + file database), stopped through the
// graceful path via its IPC "shutdown" message — not a hard kill.
describe('graceful shutdown (real process)', () => {
  const tmp = makeTempDir();
  const dbPath = join(tmp.dir, 'sim.sqlite');
  let child: ChildProcess | undefined;
  after(() => {
    if (child && child.exitCode === null) child.kill();
    tmp.cleanup();
  });

  it('closes the HTTP server and the database, then exits 0', async () => {
    child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
      env: { ...process.env, PORT: '0', HOST: '127.0.0.1', DATABASE_PATH: dbPath },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let out = '';
    child.stdout?.on('data', (b: Buffer) => { out += b.toString(); });
    child.stderr?.on('data', (b: Buffer) => { out += b.toString(); });
    const exited = new Promise<number | null>((resolve) => child?.once('exit', (code) => resolve(code)));

    const port = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 20000);
      const poll = setInterval(() => {
        const m = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
        if (m?.[1]) { clearInterval(poll); clearTimeout(timer); resolve(m[1]); }
      }, 50);
    });

    const health = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
    assert.equal(health.status, 200);
    const inv = await fetch(`http://127.0.0.1:${port}/api/v1/inventory`);
    assert.equal(inv.status, 200); // unseeded: startup migrates but never seeds
    assert.deepEqual(((await inv.json()) as { data: unknown }).data, { rooms: [], devices: [], policies: [] });
    assert.equal(existsSync(`${dbPath}-wal`), true); // WAL open while running

    child.send('shutdown');
    assert.equal(await exited, 0, out);
    assert.match(out, /shutdown message received; closing server/);
    assert.match(out, /database closed; exiting/);
    assert.equal(existsSync(`${dbPath}-wal`), false); // clean close checkpointed and removed the WAL
  });
});
