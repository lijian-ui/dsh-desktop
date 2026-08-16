// Verify the Typert Remote config service: registration + method calls.
process.env.DSH_HOME = 'C:/Users/Administrator/.dsh';
const dshAppBoot = await import('@deepseek-ai/dsh-app-boot');
const profileBoot = await import(`@deepseek-ai/dsh/lib/profile-boot-BnJoK_kl.js`);
const { runProfile } = profileBoot;
const { loadLayeredEnv } = dshAppBoot;
const result = await runProfile({
  environment: loadLayeredEnv('dsh'),
  profile: 'web',
  patchFiles: [],
  args: ['--port', '33150', '--host', '127.0.0.1'],
  exit: (code) => process.exit(code ?? 0),
});
const { ctx } = result;
await new Promise((r) => setTimeout(r, 3000));

// 1. service registered?
const api = ctx.get('imGatewayRemote');
console.log('[1] imGatewayRemote service:', api ? 'registered (' + api.constructor.name + ')' : 'MISSING');

// 2. typert contribution registered?
const typert = ctx.get('typert');
console.log('[2] typert service:', typert ? 'present' : 'MISSING');
// check registry has our package (via typert.local registry if exposed)
try {
  const reg = typert.local;
  console.log('[2b] typert.local type:', reg ? typeof reg : 'n/a');
} catch (e) {
  console.log('[2b] typert.local inspect:', e.message.slice(0, 80));
}

// 3. getConfig call
const view = api.getConfig();
console.log('[3] getConfig:', 'channels=' + JSON.stringify(view.channels?.map((c) => c.id) ?? []), 'revision=' + view.revision);

// 4. conflict branch (saveConfig with stale revision → SettingsConflictError before persist)
try {
  await api.saveConfig([], 99999);
  console.log('[4] saveConfig stale revision: NO ERROR (unexpected)');
} catch (e) {
  console.log('[4] saveConfig stale revision:', e.code === 'SETTINGS_CONFLICT' ? 'CONFLICT OK' : 'err=' + e.code + ' ' + String(e.message).slice(0, 60));
}

// 5. validation branch (non-array channels → rejected by boundary schema)
try {
  await api.saveConfig('nope', undefined);
  console.log('[5] saveConfig non-array: NO ERROR (unexpected)');
} catch (e) {
  console.log('[5] saveConfig non-array: rejected (' + String(e.message).slice(0, 60) + ')');
}

await ctx.fiber.dispose();
process.exit(0);
