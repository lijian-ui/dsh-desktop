process.env.DSH_HOME = 'C:/Users/Administrator/.dsh';
const dshAppBoot = await import('@deepseek-ai/dsh-app-boot');
const profileBoot = await import(`@deepseek-ai/dsh/lib/profile-boot-BnJoK_kl.js`);
const { runProfile } = profileBoot;
const { loadLayeredEnv } = dshAppBoot;
const result = await runProfile({
  environment: loadLayeredEnv('dsh'),
  profile: 'web',
  patchFiles: [],
  args: ['--port', '33162', '--host', '127.0.0.1'],
  exit: (code) => process.exit(code ?? 0),
});
const { ctx } = result;
await new Promise((r) => setTimeout(r, 3000));

const stub = {
  id: 'stub3', label: 'Stub3', start() {}, stop() {},
  isActive() { return true },
  async sendText(convId, text) { console.log('[STUB-SEND]', convId, '=>', String(text).slice(0, 120)); },
};
ctx.get('imGateway').registerChannel(stub);

ctx.on('session/event', (session, event) => {
  if (event.type === 'turn/end') {
    console.log('[GATEWAY-VIEW turn/end data]:', JSON.stringify(event.data).slice(0, 160));
  }
});

// unique conv id per run to avoid persisted-log collision
const convId = 'conv-' + Date.now().toString(36);
try {
  await ctx.get('imGateway').handleInbound({ channelId: 'stub3', conversationId: convId, userId: 'u1', text: '你好' });
} catch (e) {
  console.log('[handleInbound threw]', e.message.slice(0, 150));
}
await new Promise((r) => setTimeout(r, 6000));
console.log('[done] conv =', convId);
await ctx.fiber.dispose();
process.exit(0);
