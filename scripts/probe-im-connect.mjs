process.env.DSH_HOME = 'C:/Users/Administrator/.dsh';
const dshAppBoot = await import('@deepseek-ai/dsh-app-boot');
const profileBoot = await import(`@deepseek-ai/dsh/lib/profile-boot-BnJoK_kl.js`);
const { runProfile } = profileBoot;
const { loadLayeredEnv } = dshAppBoot;
const result = await runProfile({
  environment: loadLayeredEnv('dsh'),
  profile: 'web',
  patchFiles: [],
  args: ['--port', '33170', '--host', '127.0.0.1'],
  exit: (code) => process.exit(code ?? 0),
});
const { ctx } = result;
await new Promise((r) => setTimeout(r, 4000));
const gw = ctx.get('imGateway');
console.log('[probe] registered channels:', JSON.stringify(gw?.listChannels?.() ?? 'imGateway missing'));
for (const id of gw?.listChannels?.() ?? []) {
  const ch = gw.getChannel(id);
  console.log('[probe] ' + id + ': label=' + ch.label + ' active=' + ch.isActive() + ' hasStart=' + typeof ch.start);
}
await new Promise((r) => setTimeout(r, 6000));
for (const id of gw?.listChannels?.() ?? []) {
  const ch = gw.getChannel(id);
  console.log('[probe] ' + id + ' after 6s: active=' + ch.isActive());
}
await ctx.fiber.dispose();
process.exit(0);
