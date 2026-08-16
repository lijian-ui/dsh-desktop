// Two "restarts" against the SAME dingtalk conversation (fixed conversationId).
// Run 1 creates the session (persists a log); run 2 must RESUME it — no id
// collision, history kept, reply flows.
process.env.DSH_HOME = 'C:/Users/Administrator/.dsh';
process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY ?? 'sk-fake-for-verify';
const FIXED_CONV = 'resume-test-conv-001';

async function boot(port) {
  const dshAppBoot = await import('@deepseek-ai/dsh-app-boot');
  const profileBoot = await import(`@deepseek-ai/dsh/lib/profile-boot-BnJoK_kl.js`);
  return profileBoot.runProfile({
    environment: dshAppBoot.loadLayeredEnv('dsh'),
    profile: 'web',
    patchFiles: [],
    args: ['--port', String(port), '--host', '127.0.0.1'],
    exit: (code) => process.exit(code ?? 0),
  });
}

async function oneRun(port, label) {
  const r = await boot(port);
  await new Promise((s) => setTimeout(s, 3500));
  const gw = r.ctx.get('imGateway');
  const stub = {
    id: 'stub-r', label: 'StubR', start() {}, stop() {},
    isActive() { return true },
    async sendText(convId, text) { console.log('[' + label + '-SEND]', String(text).slice(0, 110)); },
  };
  gw.registerChannel(stub);
  try {
    await gw.handleInbound({ channelId: 'stub-r', conversationId: FIXED_CONV, userId: 'u1', text: '你好' });
    console.log('[' + label + '] handleInbound OK');
  } catch (e) {
    console.log('[' + label + '] THREW:', String(e.message).slice(0, 160));
  }
  await new Promise((s) => setTimeout(s, 5000));
  await r.ctx.fiber.dispose();
}

console.log('=== run 1 (create + persist) ===');
await oneRun(33201, 'R1');
console.log('=== run 2 (restart, must resume) ===');
await oneRun(33202, 'R2');
process.exit(0);
