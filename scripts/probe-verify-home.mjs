// 验证：不设 DSH_HOME（用官方默认 ~/.dsh），跑 web profile。
// 确认 profile 通过 junction 解析到仓库、agent-default-model 正确、im-gateway 加载。
// 注意：这里故意 NOT 设 process.env.DSH_HOME。
const dshAppBoot = await import('@deepseek-ai/dsh-app-boot');
const profileBoot = await import(`@deepseek-ai/dsh/lib/profile-boot-BnJoK_kl.js`);
const result = await profileBoot.runProfile({
  environment: dshAppBoot.loadLayeredEnv('dsh'),
  profile: 'web',
  patchFiles: [],
  args: ['--port', '33220', '--host', '127.0.0.1'],
  exit: (code) => process.exit(code ?? 0),
});
const { ctx } = result;
await new Promise((s) => setTimeout(s, 3500));

// 1. DSH_HOME 实际解析到哪
const hp = await import('@deepseek-ai/dsh-home-paths');
console.log('[verify] resolveDshHome():', hp.resolveDshHome());

// 2. agent-default-model 配置
const adm = ctx.get('agentDefaultModel');
console.log('[verify] agentDefaultModel source():', JSON.stringify(adm?.source()));

// 3. im-gateway 是否加载（settings namespace + service）
const settings = ctx.get('settings');
const list = settings.describe({ redactSecrets: true });
console.log('[verify] im-gateway ns:', list.some((n) => n.ns === 'im-gateway') ? 'EXISTS' : 'MISSING');
console.log('[verify] agent-default-model ns value:', JSON.stringify(list.find((n) => n.ns === 'agent-default-model')?.value));
const gw = ctx.get('imGateway');
console.log('[verify] imGateway service:', gw ? 'present' : 'MISSING');

// 4. loader 里 im-gateway entry
const loader = ctx.get('loader');
let imCount = 0;
for (const e of loader.entries()) {
  if (String(e.options?.name ?? '').includes('im-gateway')) imCount++;
}
console.log('[verify] loader im-gateway entries:', imCount);

await ctx.fiber.dispose();
process.exit(0);
