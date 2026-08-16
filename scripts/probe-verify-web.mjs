// 验证官方 web profile + @dsh/im-gateway（对齐 dsh-skill-viewer 的标准做法）。
// 不设 DSH_HOME（用官方默认 ~/.dsh），profile=web。
const dshAppBoot = await import('@deepseek-ai/dsh-app-boot');
const profileBoot = await import(`@deepseek-ai/dsh/lib/profile-boot-BnJoK_kl.js`);
const result = await profileBoot.runProfile({
  environment: dshAppBoot.loadLayeredEnv('dsh'),
  profile: 'web',
  patchFiles: [],
  args: ['--port', '33230', '--host', '127.0.0.1'],
  exit: (code) => process.exit(code ?? 0),
});
const { ctx } = result;
await new Promise((s) => setTimeout(s, 4000));

const loader = ctx.get('loader');
const imEntries = [...loader.entries()].filter((e) => String(e.options?.name ?? '').includes('im-gateway'));
console.log('[verify] im-gateway loader entries:', imEntries.length, imEntries.map((e) => e.id + ':' + e.fiber?.state).join(', '));

const gw = ctx.get('imGateway');
console.log('[verify] imGateway service:', gw ? 'present' : 'MISSING');

const adm = ctx.get('agentDefaultModel');
console.log('[verify] agentDefaultModel:', JSON.stringify(adm?.source()));

const settings = ctx.get('settings');
const list = settings.describe({ redactSecrets: true });
console.log('[verify] im-gateway ns:', list.some((n) => n.ns === 'im-gateway') ? 'EXISTS' : 'MISSING');

await ctx.fiber.dispose();
process.exit(0);
