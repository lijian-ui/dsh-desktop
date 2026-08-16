process.env.DSH_HOME = 'C:/Users/Administrator/.dsh';
const dshAppBoot = await import('@deepseek-ai/dsh-app-boot');
const profileBoot = await import(`@deepseek-ai/dsh/lib/profile-boot-BnJoK_kl.js`);
const { runProfile } = profileBoot;
const { loadLayeredEnv } = dshAppBoot;
const result = await runProfile({
  environment: loadLayeredEnv('dsh'),
  profile: 'web',
  patchFiles: [],
  args: ['--port', '33112', '--host', '127.0.0.1'],
  exit: (code) => process.exit(code ?? 0),
});
const { ctx } = result;
await new Promise((r) => setTimeout(r, 2500));
const loader = ctx.get('loader');
const entries = [...loader.entries()];
console.log('total entries:', entries.length);
const byScope = {};
for (const e of entries) {
  const name = String(e.options?.name ?? '?');
  const scope = e.options?.scope ?? '?';
  byScope[scope] = byScope[scope] ?? { count: 0, samples: [] };
  byScope[scope].count++;
  if (byScope[scope].samples.length < 5) byScope[scope].samples.push(name);
}
console.log('--- by scope ---');
for (const s of Object.keys(byScope)) {
  const v = byScope[s];
  console.log(s + ': ' + v.count + '  e.g. ' + v.samples.join(', '));
}
const fam = {};
for (const e of entries) {
  const name = String(e.options?.name ?? '?');
  const m = name.match(/^(@?[^/]+\/[^/]+|\S+)/);
  const pkg = m ? m[1] : name;
  fam[pkg] = (fam[pkg] ?? 0) + 1;
}
const sorted = Object.entries(fam).sort((a, b) => b[1] - a[1]);
console.log('--- top 30 package families ---');
for (const p of sorted.slice(0, 30)) console.log(p[1] + '\t' + p[0]);
await ctx.fiber.dispose();
process.exit(0);
