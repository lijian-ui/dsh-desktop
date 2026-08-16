// Programmatic probe: boot dsh in-process with web profile and dump loader entries.
// Uses dsh's own runProfile — same path the CLI uses.
import { resolve as pathResolve } from 'node:path';

process.env.DSH_HOME = 'C:/Users/Administrator/.dsh';

const dshAppBoot = await import('@deepseek-ai/dsh-app-boot');
const profileBoot = await import(`@deepseek-ai/dsh/lib/profile-boot-BnJoK_kl.js`);

const { runProfile } = profileBoot;
const { loadLayeredEnv } = dshAppBoot;

const start = Date.now();
const result = await runProfile({
  environment: loadLayeredEnv('dsh'),
  profile: 'web',
  patchFiles: [],
  args: [],          // cmdline args the booted profile's app receives
  exit: (code) => process.exit(code ?? 0),
});

// result is a settled root ctx — wait a moment for loader, then enumerate.
await new Promise((r) => setTimeout(r, 1500));

const { ctx } = result;

// Wait a moment for loader, then enumerate.
await new Promise((r) => setTimeout(r, 1500));

const loader = ctx.get('loader');
if (!loader) {
  console.error('no loader service found');
  process.exit(1);
}

const fib = ctx.fiber;
console.log(`[probe] boot took ${Date.now() - start}ms; root fiber state=${fib?.state}`);
console.log(`[probe] loader entries: ${[...loader.entries()].length}`);
console.log('[probe] im-* entries:');
for (const entry of loader.entries()) {
  if (entry.id.includes(':im-gateway') || entry.id.endsWith(':im-channel-dingtalk') || entry.id.endsWith(':im-channel-qq') || entry.id.endsWith(':im-channel-weixiu')) {
    console.log(`  - id=${entry.id}  name=${entry.options.name}  disabled=${entry.disabled}  fiber=${entry.fiber?.state}`);
  }
}

// Match exactly what the inventory gateway returns
console.log('\n[probe] full inventory-list() snapshot:');
const entries = [];
for (const entry of loader.entries()) {
  if (entry.options.group) continue;
  entries.push({
    entryId: entry.id,
    moduleName: entry.options.name,
    enabled: !entry.disabled,
    fiberPhase: entry.fiber === undefined ? null : entry.fiber.state,
  });
}
console.log(`  total=${entries.length}`);
console.log('  im-* entries (filtered by name):');
for (const e of entries) {
  if (e.moduleName && e.moduleName.includes('/im-gateway') || e.entryId.includes('/im-channel-')) {
    console.log(`    - id="${e.entryId}"  name=${e.moduleName}  enabled=${e.enabled}  phase=${e.fiberPhase}`);
  }
}

// Stop the world
await ctx.fiber.dispose();
process.exit(0);
