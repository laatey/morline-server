import assert from 'node:assert/strict';
import test from 'node:test';
import { hardeningArgs } from '../src/engine/container-hardening.js';

const flagValues = (args, flag) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));

test('applies default limits and isolation flags', () => {
  const args = hardeningArgs({}, {});
  assert.deepEqual(flagValues(args, '--memory'), ['1024m']);
  assert.deepEqual(flagValues(args, '--cpus'), ['1']);
  assert.deepEqual(flagValues(args, '--pids-limit'), ['1024']);
  assert.deepEqual(flagValues(args, '--security-opt'), ['no-new-privileges']);
  assert.ok(flagValues(args, '--cap-drop').includes('NET_RAW'));
});

test('service settings override default limits', () => {
  const args = hardeningArgs({ memory_limit_mb: 512, cpu_limit: 0.5 }, {});
  assert.deepEqual(flagValues(args, '--memory'), ['512m']);
  assert.deepEqual(flagValues(args, '--cpus'), ['0.5']);
});

test('env tunes the defaults', () => {
  const args = hardeningArgs({}, { MORLINE_DEFAULT_MEMORY_MB: '4096', MORLINE_PIDS_LIMIT: '256' });
  assert.deepEqual(flagValues(args, '--memory'), ['4096m']);
  assert.deepEqual(flagValues(args, '--pids-limit'), ['256']);
});

test('MORLINE_HARDEN=0 only passes explicit limits', () => {
  assert.deepEqual(hardeningArgs({}, { MORLINE_HARDEN: '0' }), []);
  assert.deepEqual(hardeningArgs({ memory_limit_mb: 256 }, { MORLINE_HARDEN: '0' }), ['--memory', '256m']);
});
