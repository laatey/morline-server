// Isolation defaults for customer containers. Everything here can be switched off with
// MORLINE_HARDEN=0, and limits can be tuned with MORLINE_DEFAULT_MEMORY_MB / MORLINE_DEFAULT_CPUS /
// MORLINE_PIDS_LIMIT. A service's own memory_limit_mb / cpu_limit always win.

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export function hardeningArgs(settings = {}, env = process.env) {
  const args = [];
  const harden = env.MORLINE_HARDEN !== '0';

  const memory = settings.memory_limit_mb || (harden ? num(env.MORLINE_DEFAULT_MEMORY_MB, 2048) : null);
  const cpus = settings.cpu_limit || (harden ? num(env.MORLINE_DEFAULT_CPUS, 2) : null);
  if (memory) args.push('--memory', `${memory}m`);
  if (cpus) args.push('--cpus', String(cpus));

  if (harden) {
    args.push('--pids-limit', String(num(env.MORLINE_PIDS_LIMIT, 1024)));
    args.push('--security-opt', 'no-new-privileges');
    // Capabilities customer code almost never needs and that widen the attack surface.
    for (const cap of ['NET_RAW', 'MKNOD', 'AUDIT_WRITE', 'SETFCAP']) args.push('--cap-drop', cap);
  }
  return args;
}
