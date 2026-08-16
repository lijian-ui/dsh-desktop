// 模拟用户桌面壳：不设 DSH_HOME，看 credentials 能否读到 key
const dshAppBoot = await import('@deepseek-ai/dsh-app-boot');
const profileBoot = await import(`@deepseek-ai/dsh/lib/profile-boot-BnJoK_kl.js`);
const hp = await import('@deepseek-ai/dsh-home-paths');
console.log('[probe] process.env.DSH_HOME =', process.env.DSH_HOME ?? '(未设)');
console.log('[probe] resolveDshHome() =', hp.resolveDshHome());

const result = await profileBoot.runProfile({
  environment: dshAppBoot.loadLayeredEnv('dsh'),
  profile: 'web',
  patchFiles: [],
  args: ['--port', '33251', '--host', '127.0.0.1'],
  exit: (code) => process.exit(code ?? 0),
});
const { ctx } = result;
await new Promise((s) => setTimeout(s, 4000));

const credentials = ctx.get('credentials');
console.log('[probe] credentials service:', credentials ? 'present' : 'MISSING');
if (credentials) {
  const hit = await credentials.resolve('DEEPSEEK_API_KEY');
  console.log('[probe] resolve(DEEPSEEK_API_KEY):', hit ? 'source=' + hit.source + ' value=' + String(hit.value).slice(0,6) + '...' : 'UNDEFINED');
}
await ctx.fiber.dispose();
process.exit(0);
