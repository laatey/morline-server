#!/usr/bin/env node
// Morline deploy wizard: package -> S3 -> SSM -> poll, exactly the flow in the deploy notes.
// Standalone: no dependencies, nothing outside this folder is read from or changed
// (only a temporary tarball and params file in the OS temp directory, deleted afterwards).
// Remove the whole deploy-wizard/ folder at any time.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FOLDER = path.basename(HERE);
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const option = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };

if (flag('help') || flag('h')) {
  console.log(`Morline deploy wizard

  node ${FOLDER}/wizard.mjs              deploy the current commit (asks before it does anything)
  node ${FOLDER}/wizard.mjs --yes        no questions (uncommitted changes are only warned about)
  node ${FOLDER}/wizard.mjs --dry-run    package the commit and show the plan, upload nothing
  node ${FOLDER}/wizard.mjs --rollback   put /opt/morline/morline-server-old back and rebuild
  node ${FOLDER}/wizard.mjs --no-wait    send the deploy and return without waiting for the result
  --profile NAME   --region NAME         override config.json for one run`);
  process.exit(0);
}

const cfg = JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8'));
if (option('profile')) cfg.profile = option('profile');
if (option('region')) cfg.region = option('region');
const yes = flag('yes');
const dryRun = flag('dry-run');
const rollback = flag('rollback');
const interactive = process.stdin.isTTY && !yes;

// ---------------------------------------------------------------- output
const paint = (code) => (text) => (process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = paint('1'); const dim = paint('2'); const red = paint('31'); const green = paint('32'); const yellow = paint('33'); const cyan = paint('36');
let stepNo = 0;
const TOTAL = rollback ? 5 : 7;
const step = (title) => console.log(`\n${cyan(`[${++stepNo}/${TOTAL}]`)} ${bold(title)}`);
const ok = (text) => console.log(`  ${green('✔')} ${text}`);
const warn = (text) => console.log(`  ${yellow('!')} ${text}`);
function fail(text, hint) {
  console.error(`\n${red('✖')} ${text}`);
  if (hint) console.error(dim(hint));
  cleanup();
  process.exit(1);
}

// ---------------------------------------------------------------- helpers
const temp = [];
function cleanup() { for (const f of temp) fs.rmSync(f, { force: true }); }
process.on('SIGINT', () => { console.log('\nCancelled.'); cleanup(); process.exit(130); });

function run(cmd, args, { cwd, inherit = false } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  if (r.error) return { code: 127, stdout: '', stderr: r.error.code === 'ENOENT' ? `${cmd}: command not found` : String(r.error.message) };
  return { code: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' };
}
const aws = (args, opts) => run('aws', [...args, '--profile', cfg.profile, '--region', cfg.region], opts);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function confirm(question) {
  if (!interactive) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question} ${dim('[y/N]')} `)).trim().toLowerCase();
  rl.close();
  return answer === 'y' || answer === 'yes';
}

// ---------------------------------------------------------------- 1. tools and repository
if (!yes && !process.stdin.isTTY) {
  console.error('This is not an interactive terminal, so the wizard cannot ask for confirmation. Pass --yes to deploy without questions.');
  process.exit(1);
}
console.log(bold(`Morline deploy${rollback ? ' (rollback)' : ''}`) + dim(`  profile ${cfg.profile} · ${cfg.region} · ${cfg.instanceId}`));
step('Checking tools');
const gitVersion = run('git', ['--version']);
if (gitVersion.code) fail('git was not found on your PATH.');
if (run('aws', ['--version']).code) fail('The AWS CLI was not found on your PATH.', 'Install it from https://aws.amazon.com/cli/ and run this again.');
ok('git and aws are available');

const top = run('git', ['-C', HERE, 'rev-parse', '--show-toplevel']);
if (top.code && !rollback) fail(`${FOLDER}/ is not inside a git repository.`);
const repo = top.stdout.trim();
let commit = 'rollback'; let branch = '';
if (!rollback) {
  commit = run('git', ['-C', repo, 'rev-parse', '--short', 'HEAD']).stdout.trim();
  branch = run('git', ['-C', repo, 'rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
  const subject = run('git', ['-C', repo, 'log', '-1', '--pretty=%s']).stdout.trim();
  ok(`Deploying ${bold(commit)} on ${branch}: ${subject}`);
  const dirty = run('git', ['-C', repo, 'status', '--porcelain', '--', '.', `:(exclude)${FOLDER}`]).stdout.split('\n').filter(Boolean);
  if (dirty.length) {
    warn(`${dirty.length} uncommitted change(s). The deploy uses the last commit, so these will NOT be included:`);
    dirty.slice(0, 8).forEach((l) => console.log(`      ${dim(l)}`));
    if (dirty.length > 8) console.log(`      ${dim(`...and ${dirty.length - 8} more`)}`);
    if (!(await confirm('Deploy the last commit anyway?'))) fail('Stopped. Commit your changes and run the wizard again.');
  }
}

// ---------------------------------------------------------------- 2. AWS session
step('Checking your AWS session');
let who = aws(['sts', 'get-caller-identity', '--output', 'json']);
if (who.code) {
  warn('Not signed in (or the session expired).');
  if (!interactive) fail('Run `aws login --profile ' + cfg.profile + '` and try again.');
  if (!(await confirm(`Run \`aws login --profile ${cfg.profile}\` now? A browser window will open.`))) fail('Stopped. Sign in and run the wizard again.');
  run('aws', ['login', '--profile', cfg.profile], { inherit: true });
  who = aws(['sts', 'get-caller-identity', '--output', 'json']);
  if (who.code) fail('Still not signed in.', who.stderr.trim());
}
ok(`Signed in as ${JSON.parse(who.stdout).Arn}`);

step('Checking the server is reachable');
const info = aws(['ssm', 'describe-instance-information', '--filters', `Key=InstanceIds,Values=${cfg.instanceId}`, '--output', 'json']);
if (info.code) fail('Could not ask SSM about the instance.', info.stderr.trim());
const ping = JSON.parse(info.stdout).InstanceInformationList?.[0]?.PingStatus;
if (ping !== 'Online') fail(`The instance ${cfg.instanceId} is not online in SSM (status: ${ping || 'not registered'}).`, 'Check that the instance is running and the SSM agent is up.');
ok('Instance is online');

// ---------------------------------------------------------------- scripts that run on the server
const UNPACK = `${cfg.deployRoot}/morline-server`;
const COMPOSE = `cd ${UNPACK} && DOCKER_GID=$(stat -c '%g' /var/run/docker.sock) docker compose -f ${cfg.composeFile} up --build -d`;
const deployCommands = [
  '#!/bin/bash', 'set -euo pipefail',
  `BUCKET=${cfg.bucket}`, `REGION=${cfg.region}`,
  "echo '[1/5] Downloading new source...'",
  'aws s3 cp s3://${BUCKET}/releases/morline-server-source.tar.gz /tmp/morline-source-new.tar.gz --region $REGION',
  "echo '[2/5] Extracting...'",
  'rm -rf /tmp/morline-unpack && mkdir -p /tmp/morline-unpack && tar -xzf /tmp/morline-source-new.tar.gz -C /tmp/morline-unpack',
  "echo '[3/5] Swapping source...'",
  `rm -rf ${UNPACK}-old`, `mv ${UNPACK} ${UNPACK}-old`, `mv /tmp/morline-unpack/morline-server ${UNPACK}`,
  "echo '[4/5] Rebuilding and restarting containers...'",
  COMPOSE,
  "echo '[5/5] Deploy complete!'",
  'rm -rf /tmp/morline-source-new.tar.gz /tmp/morline-unpack'
];
const rollbackCommands = [
  '#!/bin/bash', 'set -euo pipefail',
  `[ -d ${UNPACK}-old ] || { echo 'There is no previous version to roll back to.'; exit 1; }`,
  "echo '[1/3] Setting the failed version aside...'",
  `rm -rf ${UNPACK}-failed && mv ${UNPACK} ${UNPACK}-failed`,
  "echo '[2/3] Restoring the previous version...'",
  `mv ${UNPACK}-old ${UNPACK}`,
  "echo '[3/3] Rebuilding and restarting containers...'",
  COMPOSE,
  "echo 'Rollback complete!'"
];

// ---------------------------------------------------------------- 3. package and upload (not for rollback)
if (!rollback) {
  step('Packaging the commit');
  const tarball = path.join(os.tmpdir(), `morline-server-${commit}-source.tar.gz`);
  temp.push(tarball);
  // --prefix is required: the server unpacks into a morline-server/ folder. The wizard itself is left out.
  const pack = run('git', ['-C', repo, 'archive', '--format=tar.gz', '--prefix=morline-server/', 'HEAD', '-o', tarball, '--', '.', `:(exclude)${FOLDER}`]);
  if (pack.code) fail('git archive failed.', pack.stderr.trim());
  const size = fs.statSync(tarball).size;
  if (!size) fail('The package is empty.');
  ok(`${path.basename(tarball)}  ${dim(`${(size / 1024 / 1024).toFixed(1)} MB`)}`);

  if (dryRun) {
    console.log(`\n${yellow('Dry run:')} nothing was uploaded or deployed. The server would run:\n`);
    deployCommands.forEach((c) => console.log(dim(`  ${c}`)));
    cleanup();
    process.exit(0);
  }

  step('Uploading to S3');
  const base = `s3://${cfg.bucket}/releases`;
  for (const target of [`morline-server-${commit}-source.tar.gz`, 'morline-server-source.tar.gz']) {
    const up = aws(['s3', 'cp', tarball, `${base}/${target}`]);
    if (up.code) fail(`Upload of ${target} failed.`, up.stderr.trim());
    ok(target);
  }
}

// ---------------------------------------------------------------- confirm, send, wait
if (dryRun && rollback) { console.log(`\n${yellow('Dry run:')} the server would run:\n`); rollbackCommands.forEach((c) => console.log(dim(`  ${c}`))); process.exit(0); }
if (!(await confirm(rollback ? `Roll ${cfg.instanceId} back to the previous version?` : `Deploy ${commit} to ${cfg.instanceId}? The site restarts while it rebuilds.`))) {
  fail('Stopped before touching the server. (The upload, if any, is harmless.)');
}

step(rollback ? 'Sending the rollback' : 'Sending the deploy command');
const paramsFile = path.join(os.tmpdir(), `morline-ssm-${Date.now()}.json`);
temp.push(paramsFile);
fs.writeFileSync(paramsFile, JSON.stringify({ commands: rollback ? rollbackCommands : deployCommands }, null, 2));
const sent = aws(['ssm', 'send-command', '--instance-ids', cfg.instanceId, '--document-name', 'AWS-RunShellScript',
  '--parameters', `file://${paramsFile.replace(/\\/g, '/')}`, '--output', 'json']);
if (sent.code) fail('SSM refused the command.', sent.stderr.trim());
const commandId = JSON.parse(sent.stdout).Command.CommandId;
ok(`Command ${commandId}`);

if (flag('no-wait')) {
  console.log(`\nSent. Check it with:\n  aws ssm get-command-invocation --profile ${cfg.profile} --region ${cfg.region} --command-id ${commandId} --instance-id ${cfg.instanceId}`);
  cleanup();
  process.exit(0);
}

step('Waiting for the server');
const started = Date.now();
const deadline = started + cfg.timeoutMinutes * 60_000;
let printed = 0; let result = null; let misses = 0;
while (Date.now() < deadline) {
  await sleep(cfg.pollSeconds * 1000);
  const poll = aws(['ssm', 'get-command-invocation', '--command-id', commandId, '--instance-id', cfg.instanceId, '--output', 'json']);
  if (poll.code) {
    // Right after sending, the invocation may not exist yet.
    if (/InvocationDoesNotExist/.test(poll.stderr) && ++misses < 10) continue;
    fail('Lost track of the command.', poll.stderr.trim());
  }
  const inv = JSON.parse(poll.stdout);
  const out = inv.StandardOutputContent || '';
  if (out.length > printed) { process.stdout.write(out.slice(printed).split('\n').map((l) => (l ? `  ${dim('│')} ${l}` : l)).join('\n')); printed = out.length; }
  if (['Success', 'Failed', 'Cancelled', 'TimedOut'].includes(inv.Status)) { result = inv; break; }
}
if (!result) fail(`Gave up after ${cfg.timeoutMinutes} minutes. The command may still be running on the server.`, `Command id: ${commandId}`);

const seconds = Math.round((Date.now() - started) / 1000);
if (result.Status !== 'Success') {
  if (result.StandardErrorContent) console.error(`\n${dim(result.StandardErrorContent.trim().split('\n').slice(-25).join('\n'))}`);
  fail(`${rollback ? 'Rollback' : 'Deploy'} ${result.Status.toLowerCase()} after ${seconds}s.`,
    rollback ? 'The server may be in a partial state. Check /opt/morline on the instance.'
      : `The previous version is kept at ${UNPACK}-old.\nTo go back:  node ${FOLDER}/wizard.mjs --rollback`);
}

if (cfg.healthUrl) {
  step('Checking the site responds');
  let healthy = false;
  for (let i = 0; i < 12 && !healthy; i++) {
    try { healthy = (await fetch(cfg.healthUrl, { signal: AbortSignal.timeout(8000) })).status < 500; } catch { /* retry */ }
    if (!healthy) await sleep(5000);
  }
  if (!healthy) fail(`${cfg.healthUrl} is not answering after the deploy.`, `To go back:  node ${FOLDER}/wizard.mjs --rollback`);
  ok(`${cfg.healthUrl} is up`);
}

cleanup();
console.log(`\n${green('✔')} ${bold(rollback ? 'Rolled back' : `Deployed ${commit}`)} in ${seconds}s.`);
