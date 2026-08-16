// 端到端：真实走 agent → LLM 调用，看 resolveApiKey 到底报什么
process.env.DSH_HOME = 'C:/Users/Administrator/.dsh';
const dshAppBoot = await import('@deepseek-ai/dsh-app-boot');
const profileBoot = await import(`@deepseek-ai/dsh/lib/profile-boot-BnJoK_kl.js`);
const { SessionId } = await import('@deepseek-ai/dsh-session');
const { installModelSelection } = await import('@deepseek-ai/dsh-agent');
const { createUserMessage } = await import('@deepseek-ai/dsh-llm');
const result = await profileBoot.runProfile({
  environment: dshAppBoot.loadLayeredEnv('dsh'),
  profile: 'web',
  patchFiles: [],
  args: ['--port', '33260', '--host', '127.0.0.1'],
  exit: (code) => process.exit(code ?? 0),
});
const { ctx } = result;
await new Promise((s) => setTimeout(s, 4000));

// 直接查 credentials + llm-deepseek 的 resolveApiKey 路径
const credentials = ctx.get('credentials');
const hit = credentials ? await credentials.resolve('DEEPSEEK_API_KEY') : undefined;
console.log('[e2e] credentials resolve:', hit ? hit.source + '=' + String(hit.value).slice(0,6) : 'UNDEFINED');

// 创建 agent（模拟 im-gateway 的 ensureSession + installModelSelection）
const sid = SessionId('e2e-' + Date.now().toString(36));
const defaults = ctx.get('agentDefaultModel');
const selection = { get current() { return defaults.currentSelection(); }, set current(v) {}, assembled: undefined };
const handle = await ctx.agents.create({ sessionId: sid, meta: { cwd: 'C://Project//dsh-desktop' } });
installModelSelection(handle.agent.ctx, selection);

ctx.on('session/event', (session, event) => {
  if (event.type === 'turn/end') {
    const reason = event.data?.reason;
    console.log('[e2e] turn/end:', reason?.kind, '|', String(reason?.error?.message ?? '').slice(0, 160));
  }
});
console.log('[e2e] followup...');
handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } }));
await new Promise((s) => setTimeout(s, 8000));
await ctx.fiber.dispose();
process.exit(0);
