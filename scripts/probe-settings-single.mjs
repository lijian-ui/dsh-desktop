// Probe: verify the single im-gateway settings namespace with nested channels.
process.env.DSH_HOME = 'C:/Users/Administrator/.dsh';

const dshAppBoot = await import('@deepseek-ai/dsh-app-boot');
const profileBoot = await import(`@deepseek-ai/dsh/lib/profile-boot-BnJoK_kl.js`);
const { runProfile } = profileBoot;
const { loadLayeredEnv } = dshAppBoot;

const result = await runProfile({
  environment: loadLayeredEnv('dsh'),
  profile: 'web',
  patchFiles: [],
  args: ['--port', '33095', '--host', '127.0.0.1'],
  exit: (code) => process.exit(code ?? 0),
});
const { ctx } = result;
await new Promise((r) => setTimeout(r, 3000));

const settings = ctx.get('settings');
const list = settings.describe({ redactSecrets: true });
const im = list.filter((n) => n.ns.startsWith('im-'));
console.log(`[probe] im-* namespaces: ${im.map((n) => n.ns).join(', ') || '(none)'}`);

const ns = list.find((n) => n.ns === 'im-gateway');
if (!ns) {
  console.error('[probe] im-gateway namespace missing');
  process.exit(2);
}
const schema = ns.schema;
const refs = schema?.refs ?? {};
const rootRef = refs[String(schema?.uid)];
const channelsDict = rootRef?.dict?.['channels'];
const channelsRef = channelsDict !== undefined ? refs[String(channelsDict)] : null;
console.log(`[probe] im-gateway top dict: ${JSON.stringify(rootRef?.dict ?? null)}`);
console.log(`[probe] im-gateway channels dict: ${JSON.stringify(channelsRef?.dict ?? null)}`);
console.log(`[probe] redacted value: ${JSON.stringify(ns.value)}`);

// Secret roles inside nested channel objects.
for (const [k, uid] of Object.entries(channelsRef?.dict ?? {})) {
  const chRef = refs[String(uid)];
  const secretFields = Object.entries(chRef?.dict ?? {})
    .filter(([, cUid]) => refs[String(cUid)]?.meta?.role === 'secret')
    .map(([name]) => name);
  console.log(`  channels.${k}: secrets=${JSON.stringify(secretFields)}`);
}

await ctx.fiber.dispose();
process.exit(0);
