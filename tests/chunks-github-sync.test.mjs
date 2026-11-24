import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const script = await readFile(new URL('../nai-chunks-github-sync.user.js', import.meta.url), 'utf8');
const rows = [{ id: 'root', categoryOrder: ['c'], childOrder: [] },
  { id: 'c', label: '角色', isCategory: true, childOrder: ['a'] },
  { id: 'a', label: '复用', expansion: '原文🌈\n', color: '#abc', remoteId: 'omit' }];
async function start({ records = rows, existing, readStatus = 200, userStatus = 401, responseHeaders = '', state = {} } = {}) {
  const calls = [];
  const scope = { TextEncoder, TextDecoder, btoa, atob, console: { warn(...args) { state.warning = args.join(' '); } },
    location: { pathname: '/image' }, setTimeout() {}, setInterval() {}, GM_setValue() {}, GM_registerMenuCommand() {},
    GM_getValue: k => k === 'config' ? { repo: 'test/private' } : 'test-token',
    GM_deleteValue: k => { state.deleted = k; },
    unsafeWindow: { document: { querySelector: () => ({ '__reactFiber$test': {
      type: function Page() { client.getImagePromptMacros(); },
      memoizedState: { memoizedState: [records, { get: () => records }, {}] },
    } }) } },
    GM_xmlhttpRequest(req) {
      calls.push(req);
      const [status, data] = req.url === 'https://api.github.com/user' ? [userStatus, { login: 'test' }]
        : req.method === 'PUT' ? [201, {}]
        : readStatus !== 200 ? [readStatus, {}]
        : existing ? [200, { type: 'file', encoding: 'base64', sha: 'last', content: existing }] : [404, {}];
      req.onload({ status, responseText: JSON.stringify(data), responseHeaders });
    },
  };
  vm.runInNewContext(script, scope);
  await new Promise(resolve => setImmediate(resolve));
  return calls;
}

test('page open creates a UTF-8 backup on the default branch without querying repository metadata, skips unchanged content and updates by SHA', async () => {
  const calls = await start();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'https://api.github.com/repos/test/private/contents/novelai/prompt-chunks.json');
  const body = JSON.parse(calls[1].data);
  assert.equal(body.branch, undefined);
  const file = JSON.parse(Buffer.from(body.content, 'base64').toString());
  assert.equal(file.records[2].expansion, rows[2].expansion);
  assert.equal(file.records[2].remoteId, undefined);
  assert.deepEqual(file.records[0].categoryOrder, ['c']);
  assert.equal((await start({ existing: body.content })).length, 1);
  const changed = await start({ existing: body.content, records: rows.map(r => r.id === 'a' ? { ...r, label: 'new' } : r) });
  assert.equal(JSON.parse(changed[1].data).sha, 'last');
});

test('no overwrite of unrelated files or upload of empty/incomplete data', async () => {
  assert.equal((await start({ existing: btoa('unrelated') })).length, 1);
  for (const records of [[], rows.slice(0, 2)]) assert.equal((await start({ records })).length, 0);
});

test('a 401 automatically checks the same credential without reading or writing backup files', async () => {
  const state = {};
  const calls = await start({ readStatus: 401, state });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'https://api.github.com/user');
  assert.equal(calls[1].headers.Authorization, calls[0].headers.Authorization);
  assert.equal(calls[0].method, 'GET');
  assert.equal(state.deleted, undefined);
  assert.equal(calls[0].headers.Authorization, 'Bearer test-token');
  assert.match(state.warning, /仓库和用户接口均返回 401/);
  assert.ok(!state.warning.includes('test-token'));
});

test('successful automatic user authentication isolates a repository failure', async () => {
  const state = {};
  const calls = await start({ readStatus: 401, userStatus: 200, state });
  assert.equal(calls.length, 2);
  assert.match(state.warning, /用户认证成功/);
  assert.equal(state.deleted, undefined);
});

test('401 diagnostics retain a GitHub response identifier without dumping raw headers', async () => {
  const state = {};
  await start({ readStatus: 401, responseHeaders: 'X-GitHub-Request-Id: ABCD:1234\r\nX-Other: private-value', state });
  assert.match(state.warning, /ABCD:1234/);
  assert.ok(!state.warning.includes('private-value'));
});


