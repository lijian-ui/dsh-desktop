// Probe: boot dsh with web profile and verify the client bundle is served.
import { resolve as pathResolve } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

process.env.DSH_HOME = 'C:/Users/Administrator/.dsh';

const dshAppBoot = await import('@deepseek-ai/dsh-app-boot');
const profileBoot = await import(`@deepseek-ai/dsh/lib/profile-boot-BnJoK_kl.js`);
const { runProfile } = profileBoot;
const { loadLayeredEnv } = dshAppBoot;

const result = await runProfile({
  environment: loadLayeredEnv('dsh'),
  profile: 'web',
  patchFiles: [],
  args: ['--port', '33090', '--host', '127.0.0.1'],
  exit: (code) => process.exit(code ?? 0),
});
const { ctx } = result;

// Wait for the web server to be up and client-modules to register its route.
await new Promise((r) => setTimeout(r, 3000));

const webServer = ctx.get('webServer');
const port = webServer?.listenedPort;
console.log(`[probe] webServer port = ${port}`);

if (!port) {
  console.error('[probe] no web server port — abort');
  await ctx.fiber.dispose();
  process.exit(1);
}

// 1. client-modules graph — what does it know about our package?
const clientModules = ctx.get('clientModules');
if (clientModules) {
  const graph = clientModules.graph?.() ?? null;
  const entry = graph?.entries?.find?.((e) => e.id === '@dsh/im-gateway') ?? null;
  console.log(`[probe] clientModules graph entry for @dsh/im-gateway: ${entry ? JSON.stringify(entry) : 'NOT FOUND'}`);
  if (!entry) {
    console.log('[probe] graph entries:', (graph?.entries ?? []).map((e) => e.id).join(', '));
  }
} else {
  console.log('[probe] no clientModules service');
}

// 2. HTTP GET the client bundle route.
const url = `http://127.0.0.1:${port}/plugins/@dsh/im-gateway/client.js`;
const res = await new Promise((resolve) => {
  const req = createServer((r) => resolve(r));
  req.listen(0);
  const clientPort = req.address().port;
  req.close();
  const http = import('node:http');
  http.then((h) => {
    const r = h.request(url, (resp) => resolve(resp));
    r.on('error', (e) => resolve({ statusCode: 0, message: e.message }));
    r.end();
  });
});
const status = res.statusCode;
let body = '';
for await (const chunk of res) body += chunk;
console.log(`[probe] GET ${url} → ${status}, ${body.length} bytes`);
if (status === 200) {
  const head = body.slice(0, 80).replace(/\n/g, ' ');
  console.log(`[probe] body head: ${head}`);
}

await ctx.fiber.dispose();
process.exit(status === 200 ? 0 : 2);
