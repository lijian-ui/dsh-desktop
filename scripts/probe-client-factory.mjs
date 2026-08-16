// Simulate the browser __ModuleLoader__ to execute lib/client.js and verify
// the factory body runs + registers without throwing. Uses node:vm with a
// sandbox that provides window/require/module/exports like the real browser.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const requireFromDesktop = createRequire('C:/Project/dsh-desktop/package.json');

const bundleSrc = readFileSync('C:/Project/dsh-desktop/extensions/im-gateway/lib/client.js', 'utf8');

const platformModules = ['react', '@deepseek-ai/dsh-client-schema-form'];

const sandbox = {
  window: {},
  console,
  setTimeout,
  clearTimeout,
};
sandbox.window.__ModuleLoader__ = {
  load(handoff) {
    sandbox.__registeredId = handoff.id;
    sandbox.__registeredFactory = handoff.factory;
  },
};

// Provide `require` resolving the platform modules from the desktop tree.
sandbox.require = (spec) => {
  if (platformModules.includes(spec)) {
    try {
      return requireFromDesktop(spec);
    } catch {
      // react is CJS and loads; schema-form may be ESM-only — its factory value
      // is only used when a component renders, which this probe does not do.
      return {};
    }
  }
  throw new Error(`[sandbox] unhandled module: ${spec}`);
};
sandbox.module = { exports: {} };
sandbox.exports = sandbox.module.exports;

vm.createContext(sandbox);
try {
  vm.runInContext(bundleSrc, sandbox, { filename: 'lib/client.js' });
} catch (err) {
  console.error('[sandbox] bundle evaluation failed:', err.message);
  process.exit(1);
}

const id = sandbox.__registeredId;
const factory = sandbox.__registeredFactory;
console.log('[sandbox] registered factory id:', id);
if (!factory) {
  console.error('[sandbox] no factory registered');
  process.exit(1);
}

// Run the factory: `(require) => { var module = {...}; ... return module.exports; }`
const pluginModule = { exports: {} };
try {
  const result = factory(sandbox.require);
  console.log('[sandbox] factory returned keys:', Object.keys(result ?? {}));
  console.log('[sandbox] inject:', JSON.stringify(result?.inject));
  console.log('[sandbox] apply type:', typeof result?.apply);
} catch (err) {
  console.error('[sandbox] factory execution failed:', err.message);
  console.error(err.stack?.split('\n').slice(0, 6).join('\n'));
  process.exit(1);
}

console.log('[sandbox] OK — bundle factory executes cleanly');
