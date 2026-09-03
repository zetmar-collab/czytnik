// Sterowanie wbudowanym (i doinstalowanym) silnikiem mowy Windows (SAPI, System.Speech)
// przez długożyjący proces PowerShell komunikujący się poleceniami/zdarzeniami JSON.
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const SUPPORTED = process.platform === 'win32';
const SCRIPT = path.join(__dirname, 'tts-engine.ps1');
const START_TIMEOUT = 8000;

class TtsEngine extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.ready = null;
    this.buf = '';
    this.pendingSpeak = null; // { resolve, reject }
  }

  ensureStarted() {
    if (!SUPPORTED) return Promise.reject(new Error('Czytanie na głos jest dostępne tylko w Windows.'));
    if (this.ready) return this.ready;

    this.ready = new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) { settled = true; this._teardown(); reject(new Error('Silnik mowy nie odpowiedział na czas.')); }
      }, START_TIMEOUT);

      let proc;
      try {
        proc = spawn('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT,
        ], { windowsHide: true });
      } catch (err) {
        clearTimeout(timer);
        reject(err);
        return;
      }
      this.proc = proc;

      proc.on('error', (err) => {
        if (!settled) { settled = true; clearTimeout(timer); reject(err); }
        this.emit('error', err);
      });
      proc.on('exit', () => {
        this.ready = null;
        this.proc = null;
        if (this.pendingSpeak) {
          this.pendingSpeak.reject(new Error('Silnik mowy zakończył działanie.'));
          this.pendingSpeak = null;
        }
      });

      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (chunk) => {
        this.buf += chunk;
        let idx;
        while ((idx = this.buf.indexOf('\n')) >= 0) {
          const line = this.buf.slice(0, idx).trim();
          this.buf = this.buf.slice(idx + 1);
          if (!line) continue;
          this._handleLine(line, () => {
            if (!settled) { settled = true; clearTimeout(timer); resolve(); }
          }, (err) => {
            if (!settled) { settled = true; clearTimeout(timer); reject(err); }
          });
        }
      });
    });

    return this.ready;
  }

  _handleLine(line, onReady, onFatal) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; } // pomiń nie-JSON-owe linie (np. banery PowerShell)
    switch (msg.event) {
      case 'ready':
        onReady();
        break;
      case 'fatal':
        onFatal(new Error(msg.message || 'Silnik mowy zgłosił błąd krytyczny.'));
        break;
      case 'voices':
        this.emit('voices', msg.voices || []);
        break;
      case 'done':
        if (this.pendingSpeak) {
          const p = this.pendingSpeak;
          this.pendingSpeak = null;
          if (msg.error) p.reject(new Error(msg.error));
          else p.resolve({ cancelled: !!msg.cancelled });
        }
        break;
      case 'error':
        this.emit('error', new Error(msg.message || 'Błąd silnika mowy'));
        break;
      default:
        break;
    }
  }

  _send(obj) {
    if (!this.proc || !this.proc.stdin.writable) throw new Error('Silnik mowy nie działa.');
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  async listVoices() {
    await this.ensureStarted();
    return new Promise((resolve, reject) => {
      const onVoices = (voices) => { cleanup(); resolve(voices); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('Brak odpowiedzi z listą głosów.')); }, 6000);
      const cleanup = () => { clearTimeout(timer); this.off('voices', onVoices); };
      this.once('voices', onVoices);
      try { this._send({ cmd: 'listVoices' }); } catch (err) { cleanup(); reject(err); }
    });
  }

  // Mówi jeden fragment tekstu; obietnica rozwiązuje się, gdy silnik skończy
  // (naturalnie albo przez stop()) — { cancelled: bool }.
  async speak(text, { voice, rate, volume } = {}) {
    await this.ensureStarted();
    if (this.pendingSpeak) {
      this.pendingSpeak.reject(new Error('Przerwano poprzedni fragment.'));
      this.pendingSpeak = null;
    }
    if (voice) this._send({ cmd: 'setVoice', voice });
    if (typeof rate === 'number') this._send({ cmd: 'setRate', rate });
    if (typeof volume === 'number') this._send({ cmd: 'setVolume', volume });
    return new Promise((resolve, reject) => {
      this.pendingSpeak = { resolve, reject };
      try { this._send({ cmd: 'speak', text }); } catch (err) {
        this.pendingSpeak = null;
        reject(err);
      }
    });
  }

  pause() { if (this.proc) this._send({ cmd: 'pause' }); }
  resume() { if (this.proc) this._send({ cmd: 'resume' }); }
  stop() { if (this.proc) { try { this._send({ cmd: 'stop' }); } catch { /* proces już nie żyje */ } } }

  _teardown() {
    if (this.proc) {
      try { this.proc.kill(); } catch { /* ignoruj */ }
    }
    this.proc = null;
    this.ready = null;
  }

  dispose() {
    if (this.proc) {
      try { this._send({ cmd: 'quit' }); } catch { /* ignoruj */ }
      const p = this.proc;
      setTimeout(() => { try { p.kill(); } catch { /* ignoruj */ } }, 300);
    }
    this.proc = null;
    this.ready = null;
    this.pendingSpeak = null;
  }
}

const engine = new TtsEngine();

module.exports = {
  supported: SUPPORTED,
  listVoices: () => engine.listVoices(),
  speak: (text, opts) => engine.speak(text, opts),
  pause: () => engine.pause(),
  resume: () => engine.resume(),
  stop: () => engine.stop(),
  dispose: () => engine.dispose(),
};
