import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { CLOUDFLARE_TUNNEL_TOKEN, PORT, DATA_DIR } from '../config.js';

class TunnelManager {
  constructor() {
    this.process = null;
  }

  hasBinary(cmd) {
    try {
      const isWin = process.platform === 'win32';
      execSync(isWin ? `where ${cmd}` : `which ${cmd}`, { stdio: 'ignore' });
      return true;
    } catch (e) {
      return false;
    }
  }

  async ensureCloudflaredBinary() {
    if (this.hasBinary('cloudflared')) {
      return 'cloudflared';
    }

    const binDir = path.join(DATA_DIR, 'bin');
    if (!fs.existsSync(binDir)) {
      fs.mkdirSync(binDir, { recursive: true });
    }

    const isWin = process.platform === 'win32';
    const binName = isWin ? 'cloudflared.exe' : 'cloudflared';
    const binPath = path.join(binDir, binName);

    if (fs.existsSync(binPath)) {
      return binPath;
    }

    // Auto-download cloudflared on Linux if not present
    if (process.platform === 'linux') {
      const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
      const downloadUrl = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}`;
      console.log(`[TunnelManager] Downloading cloudflared binary for linux-${arch}...`);

      const downloadFile = (url, target, redirectCount = 0) => {
        if (redirectCount > 5) return Promise.reject(new Error('Too many redirects'));
        return new Promise((resolve, reject) => {
          https.get(url, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
              return resolve(downloadFile(res.headers.location, target, redirectCount + 1));
            }
            if (res.statusCode !== 200) {
              return reject(new Error(`Failed to download binary: HTTP ${res.statusCode}`));
            }
            const fileStream = fs.createWriteStream(target);
            res.pipe(fileStream);
            fileStream.on('finish', () => {
              fileStream.close();
              fs.chmodSync(target, 0o755);
              resolve();
            });
            fileStream.on('error', reject);
          }).on('error', reject);
        });
      };

      try {
        await downloadFile(downloadUrl, binPath);
        console.log(`[TunnelManager] cloudflared downloaded and verified at ${binPath}`);
        return binPath;
      } catch (err) {
        console.error(`[TunnelManager] Failed to auto-download cloudflared: ${err.message}`);
        return null;
      }
    }

    return null;
  }

  async start() {
    if (!CLOUDFLARE_TUNNEL_TOKEN) {
      console.log('[TunnelManager] No CLOUDFLARE_TUNNEL_TOKEN provided. Running in direct HTTP mode.');
      return;
    }

    const bin = await this.ensureCloudflaredBinary();
    if (!bin) {
      console.warn('[TunnelManager] cloudflared binary not found and cannot auto-download on this platform.');
      return;
    }

    console.log(`[TunnelManager] Starting Cloudflare Tunnel using token...`);

    // In token mode, route incoming traffic to local Express server port
    const child = spawn(bin, [
      'tunnel',
      '--no-autoupdate',
      'run',
      '--url',
      `http://127.0.0.1:${PORT}`,
      '--token',
      CLOUDFLARE_TUNNEL_TOKEN
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });

    this.process = child;

    child.stdout.on('data', (d) => {
      const msg = d.toString().trim();
      if (msg) console.log(`[Cloudflared] ${msg}`);
    });

    child.stderr.on('data', (d) => {
      const msg = d.toString().trim();
      if (msg && !msg.includes('WRN Your version')) {
        console.log(`[Cloudflared] ${msg}`);
      }
    });

    child.on('close', (code) => {
      console.log(`[TunnelManager] cloudflared process exited with code ${code}`);
      this.process = null;
    });
  }

  stop() {
    if (this.process) {
      console.log('[TunnelManager] Stopping cloudflared tunnel process...');
      this.process.kill();
      this.process = null;
    }
  }
}

export const tunnelManager = new TunnelManager();
