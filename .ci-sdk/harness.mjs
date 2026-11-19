// Runs inside the benchmark workflow: one CI job of a real repo, its own commands ("base") vs the same job through ci-sdk
// ("ci"), on one runner, alternating which goes first. Each variant keeps its own caches between runs; nothing else carries over.
// usage: node .ci-sdk/harness.mjs .ci-sdk/config.json <job>
// Prints one `BENCH_RESULT {json}` line. Never fails the job: a failed job skips the cache save and leaves the next run cold.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { plan } from './action/plan.mjs';
import { pin } from './action/mtime.mjs';

const [configPath, jobName] = process.argv.slice(2);
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const job = config.jobs[jobName];
const CLI = `node ${process.env.RUNNER_TEMP}/ci-sdk/node_modules/ci-sdk/dist/cli.js`;
const STORE = '.bench-cache';
const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 1 << 28 });
const untracked = () => git('ls-files', '-o', '-z', '--', '.', `:(exclude)${STORE}`, ':(exclude,glob)**/node_modules/**').split('\0').filter(Boolean);
const now = () => performance.now() / 1000;
const round = (s) => +s.toFixed(2);

// What each variant keeps between runs. ci: exactly what the ci-sdk Action restores. base: the caches the repo's own CI keeps
// (e.g. a turbo remote cache), listed in the config; most repos keep none.
const dirs = [...new Set(git('ls-files', 'package.json', '**/package.json').split('\n').filter(Boolean).map((f) => (dirname(f) === '.' ? '' : dirname(f))))];
const caches = {
  base: job.baseCache ?? config.baseCache ?? [],
  ci: plan({ dirs, tree: '', job: '', matrix: '', os: '', arch: '', node: '', event: '', runId: '', home: '' }).tools_paths.split('\n'),
};
const everyCache = [...new Set([...caches.base, ...caches.ci])];

const sh = (cmd, capture = false) => {
  const p = spawnSync('bash', ['-c', cmd.replaceAll('CI_SDK', CLI)], { stdio: ['ignore', capture ? 'pipe' : 'inherit', 'pipe'], encoding: 'utf8', maxBuffer: 1 << 28, env: { ...process.env, ...config.env, ...job.env } });
  process.stderr.write(p.stderr ?? '');
  return p;
};

// Shared setup (both variants need it, e.g. `cp .env.example .env`): timed but not part of either variant.
const res = { job: jobName, base: {}, ci: {}, setup_s: 0 };
let t = now();
for (const cmd of job.setup ?? []) {
  console.log(`::group::setup: ${cmd}`);
  const p = sh(cmd);
  console.log('::endgroup::');
  if (p.status) res.setup_failed = cmd;
}
res.setup_s = round(now() - t);

// Start every variant from the same tree: outputs any variant leaves behind are deleted, and every cache path is moved out.
const pre = new Set(untracked());
const clean = () => {
  for (const f of untracked()) if (!pre.has(f) && statSync(f, { throwIfNoEntry: false })?.isFile()) rmSync(f, { force: true });
};
const stash = (variant) => {
  for (const p of everyCache) {
    if (!existsSync(p)) continue;
    if (caches[variant].includes(p)) {
      const to = join(STORE, variant, p);
      rmSync(to, { recursive: true, force: true });
      mkdirSync(dirname(to), { recursive: true });
      renameSync(p, to);
    } else rmSync(p, { recursive: true, force: true });
  }
};
const unstash = (variant) => {
  for (const p of caches[variant]) {
    const from = join(STORE, variant, p);
    if (!existsSync(from)) continue;
    rmSync(p, { recursive: true, force: true });
    mkdirSync(dirname(p), { recursive: true });
    renameSync(from, p);
  }
};
const size = (p) => (existsSync(p) ? Number(execFileSync('du', ['-sb', p], { encoding: 'utf8' }).split('\t')[0]) : 0);

// Caches restored by an earlier step may sit in place already (setup can create some); start clean.
for (const p of everyCache) if (existsSync(p)) rmSync(p, { recursive: true, force: true });

const order = Number(process.env.GITHUB_RUN_NUMBER) % 2 ? ['ci', 'base'] : ['base', 'ci'];
res.order = order.join(',');
for (const variant of order) {
  unstash(variant);
  if (variant === 'ci') {
    // What the Action does before the job's own steps.
    t = now();
    pin(process.cwd());
    res.ci['(pin file times)'] = { s: round(now() - t), rc: 0 };
  }
  for (const [name, cmd] of job[variant]) {
    console.log(`::group::${variant}: ${name}`);
    t = now();
    const p = sh(cmd);
    const s = round(now() - t);
    console.log('::endgroup::');
    const summary = (p.stderr ?? '').split('\n').filter((l) => /^ci-sdk: (\S+: \d+ packages|\d+ changed files|All affected|Some affected|No changes|.*can't run|.*running the full suite)/.test(l));
    res[variant][name] = { s, rc: p.status, ...(summary.length && { ci: summary.join(' | ') }), ...(p.status && { tail: (p.stderr ?? '').slice(-1500) }) };
  }
  stash(variant);
  res[`${variant}_cache_bytes`] = size(join(STORE, variant));
  clean();
}

// Probes: recorded for the report (e.g. how many test files a change reaches), timed in neither variant.
res.probes = (job.probe ?? []).map((cmd) => {
  const p = sh(cmd, true);
  return { cmd, out: (p.stdout ?? '').trim().slice(-500), ci: (p.stderr ?? '').split('\n').filter((l) => l.startsWith('ci-sdk: ')).join(' | ').slice(0, 500) };
});

const total = (v) => round(Object.values(res[v]).reduce((a, s) => a + s.s, 0));
const passed = (v) => Object.values(res[v]).every((s) => s.rc === 0);
res.base_s = total('base');
res.ci_s = total('ci');
res.base_passed = passed('base');
res.ci_passed = passed('ci');
// The outcome that matters: the job passes or fails the same way. Steps with the same name are compared too.
res.same_outcome = res.base_passed === res.ci_passed;
res.step_mismatches = Object.keys(res.base).filter((k) => k in res.ci && (res.base[k].rc === 0) !== (res.ci[k].rc === 0));
res.cpu = readFileSync('/proc/cpuinfo', 'utf8').match(/model name\s*:\s*(.*)/)?.[1];
res.cores = Number(execFileSync('nproc', { encoding: 'utf8' }));
console.log(`BENCH_RESULT ${JSON.stringify(res)}`);
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${jobName}\nbase ${res.base_s}s (${res.base_passed ? 'pass' : 'FAIL'}) · ci-sdk ${res.ci_s}s (${res.ci_passed ? 'pass' : 'FAIL'}) · order ${res.order}\n`);
