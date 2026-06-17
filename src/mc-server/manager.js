import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';

export const SERVER_STATE = Object.freeze({
  STOPPED:  'stopped',
  STARTING: 'starting',
  RUNNING:  'running',
  STOPPING: 'stopping',
});

export class MinecraftServerManager extends EventEmitter {
  constructor({ serverDir, jarPath, javaArgs = [] }) {
    super();
    this.serverDir  = serverDir;
    this.jarPath    = jarPath;
    this.javaArgs   = javaArgs;
    this.state      = SERVER_STATE.STOPPED;
    this._process   = null;
    this._error     = null;
    this._logs      = [];
    this._maxLogs   = 200;
  }

  get logs() { return [...this._logs]; }

  toJSON() {
    return {
      state: this.state,
      error: this._error,
      logs:  this._logs.slice(-50),
    };
  }

  async start() {
    if (this.state !== SERVER_STATE.STOPPED) return;

    try {
      await fs.access(this.jarPath);
    } catch {
      this._error = 'server.jar not found — run: node scripts/setup-server.js';
      this.emit('change');
      return;
    }

    this._error = null;
    this._setState(SERVER_STATE.STARTING);

    const args = [...this.javaArgs, '-jar', this.jarPath, '--nogui'];
    const proc = spawn('java', args, { cwd: this.serverDir, stdio: ['pipe', 'pipe', 'pipe'] });
    this._process = proc;

    this._pipeLines(proc.stdout);
    this._pipeLines(proc.stderr);

    // Use 'close' (not 'exit') so all stdout/stderr data events have fired
    // before we mark stopped and end the session log stream.
    proc.on('close', () => {
      this._process = null;
      this._setState(SERVER_STATE.STOPPED);
    });
  }

  stop() {
    if (!this._process || this.state === SERVER_STATE.STOPPED) return;
    this._setState(SERVER_STATE.STOPPING);
    try { this._process.stdin.write('stop\n'); } catch { /* noop */ }
    setTimeout(() => {
      if (this._process) try { this._process.kill('SIGTERM'); } catch { /* noop */ }
    }, 12_000).unref();
  }

  sendCommand(cmd) {
    if (this.state !== SERVER_STATE.RUNNING || !this._process) return;
    try { this._process.stdin.write(cmd + '\n'); } catch { /* noop */ }
  }

  _pipeLines(stream) {
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        this._pushLog(trimmed);
        if (this.state === SERVER_STATE.STARTING && trimmed.includes('Done (') && trimmed.includes('help')) {
          this._setState(SERVER_STATE.RUNNING);
        }
      }
    });
    // flush any partial line left in the buffer when the stream closes
    stream.on('end', () => {
      const trimmed = buf.trim();
      if (trimmed) this._pushLog(trimmed);
      buf = '';
    });
  }

  _pushLog(line) {
    const entry = { ts: new Date().toISOString(), line };
    this._logs.push(entry);
    if (this._logs.length > this._maxLogs) this._logs.shift();
    this.emit('log', entry);
  }

  _setState(state) {
    this.state = state;
    this.emit('change');
  }
}
