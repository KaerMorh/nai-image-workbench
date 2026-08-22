import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../nai-image-workbench.user.js', import.meta.url), 'utf8');
const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('keeps the public name and release version aligned', () => {
  assert.match(source, /@name\s+NAI Image Workbench/);
  assert.match(source, new RegExp(`@version\\s+${packageJson.version.replaceAll('.', '\\.')}`));
  assert.match(source, new RegExp(`SCRIPT_VERSION = '${packageJson.version.replaceAll('.', '\\.')}'`));
  assert.match(readme, /^# NAI Image Workbench$/m);
});

test('targets only the NovelAI image page and runs in the main world', () => {
  assert.match(source, /@match\s+https:\/\/novelai\.net\/image\*/);
  assert.match(source, /@run-at\s+document-start/);
  assert.match(source, /@sandbox\s+raw/);
  assert.match(source, /@grant\s+none/);
});

test('never refreshes or navigates the page', () => {
  assert.doesNotMatch(source, /location\s*\.\s*reload\s*\(/);
  assert.doesNotMatch(source, /location\s*\.\s*replace\s*\(/);
  assert.doesNotMatch(source, /history\s*\.\s*go\s*\(\s*0\s*\)/);
  assert.doesNotMatch(source, /location\s*\.\s*href\s*=/);
});

test('contains the agreed retry and retention policy', () => {
  assert.match(source, /const MAX_FINISHED = 100;/);
  assert.match(source, /const QUEUE_RETRY_DELAYS_MS = \[5_000, 15_000, 30_000\];/);
  assert.match(source, /response\.status !== 429/);
  assert.match(source, /response\.status >= 500/);
  assert.match(source, /QueueTimeoutError/);
});

test('does not load external code or use privileged userscript APIs', () => {
  assert.doesNotMatch(source, /@require\b/);
  assert.doesNotMatch(source, /GM_(?:xmlhttpRequest|setValue|getValue|download)/);
});

test('keeps results in NovelAI by resolving the original fetch promise', () => {
  assert.match(source, /deferred\.resolve\(response\)/);
  assert.doesNotMatch(source, /download\s*\(/i);
  assert.doesNotMatch(source, /delete image/i);
});

test('uses the agreed queue hitbox color and restores NovelAI disabled state for carrier dispatch', () => {
  assert.match(source, /class="generate-hitbox"/);
  assert.match(source, /addEventListener\('click', onGenerateOverlayClick\)/);
  assert.match(source, /background: rgb\(112, 119, 194\) !important/);
  assert.match(source, /overlay\.textContent = shouldCaptureGenerateClick\(\) \? '加入队列'/);
  assert.match(source, /const domDisabled = button\.disabled/);
  assert.match(source, /if \(domDisabled\) button\.disabled = true/);
  assert.doesNotMatch(source, /removeAttribute\('disabled'\)/);
  assert.doesNotMatch(source, /setAttribute\('disabled'/);
});

test('captures current React generation parameters without sending in parallel', () => {
  assert.match(source, /root\.stateNode\?\.current === root \? attached : attached\.alternate/);
  assert.match(source, /captureLowLevelGeneration/);
  assert.match(source, /pendingSnapshotCaptures/);
  assert.match(source, /invocation\.originalMethod\.apply\(invocation\.thisArg, invocation\.args\)/);
  assert.match(source, /activation: invocation\.activate/);
});

test('parses multipart request JSON and preserves NovelAI request seeds across retries', () => {
  assert.match(source, /splitMultipartRequestJson/);
  assert.match(source, /multipart-json-ref/);
  assert.match(source, /fetchWithTimeout\(prepared, execution\)/);
  assert.doesNotMatch(source, /withRandomSeed/);
  assert.doesNotMatch(source, /function randomSeed/);
  assert.match(source, /requestHeaders: prepared\.headers/);
  assert.match(source, /headers: job\.requestHeaders \|\| prepared\.headers/);
});

test('runs NovelAI validation immediately and only queues a produced request', () => {
  assert.match(source, /session\.type === 'enqueue'/);
  assert.match(source, /session\.capturePromise/);
  assert.match(source, /const validationPassed = await Promise\.race/);
  assert.match(source, /NovelAI 未通过当前参数校验，本次未加入队列/);
  assert.match(source, /runtime\.activation\(\)/);
  assert.match(source, /等待 NovelAI 校验/);
  assert.doesNotMatch(source, /drainSnapshotCaptures/);
});

test('allows every toast to be dismissed directly', () => {
  assert.match(source, /toast\.addEventListener\('click', dismiss\)/);
  assert.match(source, /toast\.addEventListener\('keydown', dismiss\)/);
  assert.match(source, /event\.target\.closest\('button'\)/);
});

test('supports bottom-right, top-right, or disabled workbench notifications', () => {
  assert.match(source, /toastPosition: 'top-right'/);
  assert.match(source, /\['bottom-right', 'top-right', 'off'\]/);
  assert.match(source, /data-position="top-right"/);
  assert.match(source, /cachedState\.settings\.toastPosition === 'off'/);
  assert.match(source, /name="toastPosition"/);
});

test('marks History images from NovelAI download state without changing History', () => {
  assert.match(source, /historySaveIndicator/);
  assert.match(source, /#historyContainer\.image-gen-history/);
  assert.match(source, /aria-label="choose image"/);
  assert.match(source, /maskImage/);
  assert.match(source, /opacity <= 0\.5/);
  assert.match(source, /isSelectedHistoryItem/);
  assert.match(source, /localGenerationRunning \? false : visualSaved/);
  assert.match(source, /downloadButton\.disabled \|\| props\?\.disabled/);
  assert.match(source, /Array\.isArray\(value\.downloaded\)/);
  assert.match(source, /data-nai-image-workbench-history-saved/);
  assert.match(source, /#39d98a/);
  assert.match(source, /#ff5d73/);
  assert.match(source, /\[data-nai-image-workbench-history-saved\]::after/);
  assert.match(source, /right: 5px/);
  assert.match(source, /bottom: 5px/);
  assert.match(source, /pointer-events: none !important/);
  assert.match(source, /historyInteractionUntil/);
  assert.match(source, /deferHistoryIndicatorDuringInteraction/);
  assert.doesNotMatch(source, /outline: 2px solid/);
  assert.doesNotMatch(source, /\.click\(\).*download/i);
});

test('persists configurable queue behavior behind a settings panel', () => {
  assert.match(source, /启用等待队列/);
  assert.match(source, /maxRetries/);
  assert.match(source, /interJobDelayMs/);
  assert.match(source, /maxFinished/);
  assert.match(source, /toastDurationMs/);
  assert.match(source, /toastPosition/);
  assert.match(source, /historySaveIndicator/);
  assert.match(source, /!state\.settings\.queueEnabled/);
  assert.match(source, /settingsPosition/);
  assert.match(source, /settingsHeader\.addEventListener\('pointermove'/);
  assert.match(source, /<legend>队列设置<\/legend>/);
  assert.match(source, /<legend>使用体验<\/legend>/);
  assert.match(source, /队列禁用/);
  assert.match(source, /队列启用/);
  assert.match(source, /toggleQueueControl/);
  assert.match(source, /input\[name="queueEnabled"\].*addEventListener\('change'/);
  assert.match(source, /与外部按钮功能相同/);
  assert.match(source, /<small class="settings-credit">by KaerMorh<\/small>/);
  assert.match(source, /historySaveIndicator: true/);
  assert.match(source, /toastDurationMs: 2_000/);
  assert.match(source, /\.tabs button span \{ margin-left: 9px; \}/);
  assert.doesNotMatch(source, /\.panel\.collapsed \{ width:/);
});

test('supports one named prompt placeholder and newline-separated replacement units', () => {
  assert.match(source, /const MAX_BATCH_ITEMS = 500;/);
  assert.match(source, /function inspectPromptTemplate/);
  assert.match(source, /source\.matchAll\(\/{{\\s\*\(\[\^{}\\r\\n\]\+\?\)\\s\*}}\/g\)/);
  assert.match(source, /names\.length !== 1/);
  assert.match(source, /function replacePromptTemplate/);
  assert.match(source, /split\(\/\\r\?\\n\/\)/);
  assert.match(source, /\.map\(\(item\) => item\.trim\(\)\)/);
});

test('freezes the complete request template while changing only the Base Prompt', () => {
  assert.match(source, /saveBatchRequestTemplate/);
  assert.match(source, /loadBatchRequestTemplate/);
  assert.match(source, /withBasePrompt\(template\.body \|\| '\{}', prompt\)/);
  assert.match(source, /v4_prompt\?\.caption/);
  assert.match(source, /parameters\?\.v4_prompt\?\.caption/);
  assert.match(source, /collectBlobRefsFromStoredBody\(batchTemplate \|\| \{}\)/);
  assert.doesNotMatch(source, /withRandomSeed/);
});

test('runs batch replacement as a single current item and consumes it only on success', () => {
  assert.match(source, /items: items\.slice\(1\)/);
  assert.match(source, /current: null,\s*completed: batch\.completed \+ 1/);
  assert.match(source, /status: 'failed',\s*current: \{ \.\.\.batch\.current/);
  assert.match(source, /scheduleBatchController/);
  assert.match(source, /if \(jobs\.length \|\| cachedBusy/);
  assert.match(source, /source: 'batch-replace'/);
});

test('warns before starting adjacent duplicate batch items with a fixed Seed', () => {
  assert.match(source, /function findAdjacentDuplicateBatchItems/);
  assert.match(source, /function readNativeFixedSeed/);
  assert.match(source, /control instanceof HTMLInputElement \? control\.value : control\.textContent/);
  assert.match(source, /fixedSeed: readNativeFixedSeed\(\)/);
  assert.match(source, /plan\.fixedSeed !== null && adjacentDuplicates\.length/);
  assert.match(source, /window\.confirm\(/);
  assert.match(source, /选择“确定”继续执行；选择“取消”返回修改列表/);
  assert.match(source, /已取消启动批量替换，请修改相邻重复项后再试/);
});

test('provides a dedicated editable batch UI with pause, stop, retry, skip, and refresh controls', () => {
  assert.match(source, /data-tab="batch"/);
  assert.match(source, /class="batch-items"/);
  assert.match(source, /开始特殊生成/);
  assert.match(source, /重新读取配置/);
  assert.match(source, /重试当前项/);
  assert.match(source, /跳过并删除当前项/);
  assert.match(source, /完成后丢弃记录并停止/);
  assert.match(source, /batch\.status === 'running' \|\| batch\.status === 'capturing'/);
});

test('persists batch work but pauses it after a page reload to prevent duplicates', () => {
  assert.match(source, /batch: normalizeBatchState\(stored\?\.batch\)/);
  assert.match(source, /\['capturing', 'running'\]\.includes\(cachedState\.batch\.status\)/);
  assert.match(source, /为避免重复生成/);
  assert.match(source, /paused: true/);
});
