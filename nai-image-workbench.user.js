// ==UserScript==
// @name         NAI Image Workbench
// @namespace    https://novelai.net/
// @version      0.6.5
// @description  Queue generations, run prompt replacement batches, and track History saves in NovelAI Image Generation.
// @author       Local
// @match        https://novelai.net/image*
// @run-at       document-start
// @sandbox      raw
// @noframes
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  if (window.__NAI_IMAGE_WORKBENCH_LOADED__) return;
  window.__NAI_IMAGE_WORKBENCH_LOADED__ = true;

  const SCRIPT_VERSION = '0.6.5';
  const DB_NAME = 'nai-image-workbench';
  const DB_VERSION = 1;
  const JOB_STORE = 'jobs';
  const META_STORE = 'meta';
  const BLOB_STORE = 'blobs';
  const CHANNEL_NAME = 'nai-image-workbench-channel-v1';
  const EXECUTION_LOCK = 'nai-image-workbench-execution-v1';
  const BATCH_CONTROLLER_LOCK = 'nai-image-workbench-batch-controller-v1';
  const MAX_FINISHED = 100;
  const MAX_BATCH_ITEMS = 500;
  const GENERATION_TIMEOUT_MS = 120_000;
  const OWNER_STALE_MS = 150_000;
  const INTER_JOB_DELAY_MS = 1_000;
  const SITE_RETRY_GRACE_MS = 4_000;
  const QUEUE_RETRY_DELAYS_MS = [5_000, 15_000, 30_000];
  const GENERATION_ENDPOINT_RE = /https:\/\/image\.novelai\.net\/ai\/generate-image(?:-stream)?(?:\?|$)/i;
  const LARGE_BINARY_MIN_LENGTH = 16_384;
  const BLOB_REF_KEY = '$naiImageWorkbenchBlobRef';
  const TAB_ID = crypto.randomUUID();

  const nativeFetch = window.fetch.bind(window);
  const nativeSetTimeout = window.setTimeout.bind(window);
  const nativeClearTimeout = window.clearTimeout.bind(window);
  const nativeSetInterval = window.setInterval.bind(window);
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL_NAME) : null;

  let dbPromise;
  let uiHost;
  let shadow;
  let schedulerRunning = false;
  let refreshTimer = null;
  let kickTimer = null;
  let heartbeatTimer = null;
  let historyHighlightTimer = null;
  let historyInteractionUntil = 0;
  let batchEditTimer = null;
  let batchControllerTimer = null;
  let batchControllerRunning = false;
  let batchRuntimePlan = null;
  let currentExecution = null;
  let cachedJobs = [];
  let cachedState = defaultState();
  let cachedBusy = null;
  let idleJotaiBooleanAtoms = [];
  let snapshotProbeChain = Promise.resolve();
  let captureSequence = 0;
  const captureSessions = [];
  const pendingSnapshotCaptures = [];
  const runtimeJobs = new Map();
  const pendingDeleteTimers = new Map();
  const historySavedStates = new WeakMap();

  class QueueTimeoutError extends Error {
    constructor(message = 'Generation timed out after 120 seconds.') {
      super(message);
      this.name = 'QueueTimeoutError';
      this.statusCode = 0;
    }
  }

  function defaultState() {
    return {
      paused: false,
      collapsed: false,
      activeTab: 'queue',
      position: null,
      settingsPosition: null,
      revision: 0,
      batch: defaultBatchState(),
      settings: {
        queueEnabled: true,
        maxRetries: QUEUE_RETRY_DELAYS_MS.length,
        interJobDelayMs: INTER_JOB_DELAY_MS,
        maxFinished: MAX_FINISHED,
        toastDurationMs: 2_000,
        toastPosition: 'top-right',
        historySaveIndicator: true,
      },
    };
  }

  function defaultBatchState() {
    return {
      id: null,
      status: 'idle',
      templatePrompt: '',
      variableName: '',
      items: [],
      current: null,
      completed: 0,
      total: 0,
      error: null,
      configCapturedAt: null,
      discardCurrentRecord: false,
      updatedAt: null,
    };
  }

  function normalizeBatchState(value = {}) {
    const allowedStatuses = ['idle', 'capturing', 'running', 'paused', 'stopped', 'failed', 'completed'];
    const status = allowedStatuses.includes(value.status) ? value.status : 'idle';
    const items = Array.isArray(value.items)
      ? value.items.filter((item) => typeof item === 'string').slice(0, MAX_BATCH_ITEMS)
      : [];
    const current = value.current && typeof value.current.value === 'string'
      ? {
          id: String(value.current.id || crypto.randomUUID()),
          value: value.current.value,
          jobId: value.current.jobId ? String(value.current.jobId) : null,
          prompt: String(value.current.prompt || ''),
          status: String(value.current.status || 'waiting'),
        }
      : null;
    return {
      ...defaultBatchState(),
      ...value,
      status,
      items,
      current,
      completed: Math.max(0, Number(value.completed) || 0),
      total: Math.max(items.length + (current ? 1 : 0), Number(value.total) || 0),
      discardCurrentRecord: value.discardCurrentRecord === true,
    };
  }

  function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
  }

  function normalizeQueueSettings(value = {}) {
    const toastPosition = ['bottom-right', 'top-right', 'off'].includes(value.toastPosition)
      ? value.toastPosition
      : 'top-right';
    return {
      queueEnabled: value.queueEnabled !== false,
      maxRetries: Math.round(clampNumber(value.maxRetries, 0, QUEUE_RETRY_DELAYS_MS.length, QUEUE_RETRY_DELAYS_MS.length)),
      interJobDelayMs: Math.round(clampNumber(value.interJobDelayMs, 500, 10_000, INTER_JOB_DELAY_MS)),
      maxFinished: Math.round(clampNumber(value.maxFinished, 10, MAX_FINISHED, MAX_FINISHED)),
      toastDurationMs: Math.round(clampNumber(value.toastDurationMs, 1_000, 30_000, 2_000)),
      toastPosition,
      historySaveIndicator: value.historySaveIndicator !== false,
    };
  }

  function sleep(ms) {
    return new Promise((resolve) => nativeSetTimeout(resolve, ms));
  }

  function now() {
    return Date.now();
  }

  function safeJsonParse(value) {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  function splitMultipartRequestJson(bodyText) {
    if (typeof bodyText !== 'string' || !bodyText.startsWith('--')) return null;
    const firstBreak = bodyText.indexOf('\r\n');
    if (firstBreak < 0) return null;
    const boundary = bodyText.slice(0, firstBreak);
    const requestHeader = bodyText.search(/Content-Disposition:[^\r\n]*name="request"/i);
    if (requestHeader < 0) return null;
    const separator = bodyText.indexOf('\r\n\r\n', requestHeader);
    if (separator < 0) return null;
    const jsonStart = separator + 4;
    const jsonEnd = bodyText.indexOf(`\r\n${boundary}`, jsonStart);
    if (jsonEnd < 0) return null;
    const payload = safeJsonParse(bodyText.slice(jsonStart, jsonEnd));
    return payload ? {
      payload,
      beforeJson: bodyText.slice(0, jsonStart),
      afterJson: bodyText.slice(jsonEnd),
    } : null;
  }

  function parseGenerationPayload(bodyText) {
    return safeJsonParse(bodyText) || splitMultipartRequestJson(bodyText)?.payload || null;
  }

  function parseBatchItemsText(value) {
    return String(value ?? '')
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function findAdjacentDuplicateBatchItems(items) {
    const duplicates = [];
    for (let index = 1; index < items.length; index += 1) {
      if (items[index] === items[index - 1]) {
        duplicates.push({ value: items[index], first: index, second: index + 1 });
      }
    }
    return duplicates;
  }

  function readNativeFixedSeed() {
    const parseSeed = (value) => {
      const text = String(value ?? '').trim();
      if (!/^\d+$/.test(text)) return null;
      const seed = Number(text);
      return Number.isSafeInteger(seed) ? seed : null;
    };
    const isVisible = (element) => {
      const style = window.getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
    };
    const inputs = Array.from(document.querySelectorAll('input')).filter(isVisible);
    for (const input of inputs) {
      const identity = [input.name, input.id, input.getAttribute('aria-label'), input.placeholder]
        .filter(Boolean)
        .join(' ');
      if (/\bseed\b/i.test(identity)) {
        const seed = parseSeed(input.value);
        if (seed !== null) return seed;
      }
    }
    const seedLabels = Array.from(document.querySelectorAll('label, span, div'))
      .filter((element) => isVisible(element) && element.textContent?.trim() === 'Seed');
    for (const label of seedLabels) {
      const container = label.parentElement;
      if (!container) continue;
      for (const control of container.querySelectorAll('input, button, [role="spinbutton"]')) {
        if (!isVisible(control)) continue;
        const seed = parseSeed(control instanceof HTMLInputElement ? control.value : control.textContent);
        if (seed !== null) return seed;
      }
    }
    return null;
  }

  function inspectPromptTemplate(prompt) {
    const source = String(prompt ?? '');
    const matches = Array.from(source.matchAll(/{{\s*([^{}\r\n]+?)\s*}}/g));
    if (!matches.length) return { valid: false, error: 'Base Prompt 中没有 {{变量}} 占位符。', source, variableName: '', count: 0 };
    const names = [...new Set(matches.map((match) => match[1].trim()))];
    if (names.length !== 1) return { valid: false, error: '一个批次只能使用一种占位符名称。', source, variableName: '', count: matches.length };
    if (!names[0] || names[0].length > 32) return { valid: false, error: '占位符名称长度必须为 1–32 个字符。', source, variableName: names[0] || '', count: matches.length };
    return { valid: true, error: null, source, variableName: names[0], count: matches.length };
  }

  function replacePromptTemplate(templatePrompt, variableName, value) {
    const inspected = inspectPromptTemplate(templatePrompt);
    if (!inspected.valid || inspected.variableName !== variableName) throw new Error(inspected.error || '占位符已经变化。');
    return inspected.source.replace(/{{\s*([^{}\r\n]+?)\s*}}/g, (match, name) => (
      String(name).trim() === variableName ? String(value) : match
    ));
  }

  function setPayloadBasePrompt(payload, prompt) {
    if (!payload || typeof payload !== 'object') return false;
    let changed = false;
    const assign = (object, key) => {
      if (!object || typeof object !== 'object' || typeof object[key] !== 'string') return;
      object[key] = prompt;
      changed = true;
    };
    assign(payload, 'prompt');
    assign(payload, 'input');
    assign(payload.parameters, 'prompt');
    assign(payload?.v4_prompt?.caption, 'base_caption');
    assign(payload?.parameters?.v4_prompt?.caption, 'base_caption');
    return changed;
  }

  function withBasePrompt(bodyText, prompt) {
    const multipart = splitMultipartRequestJson(bodyText);
    const payload = safeJsonParse(bodyText) || multipart?.payload;
    if (!payload || typeof payload !== 'object') throw new Error('无法解析 NovelAI 请求中的 Prompt。');
    const updated = structuredClone(payload);
    if (!setPayloadBasePrompt(updated, prompt)) throw new Error('无法定位 NovelAI 请求中的 Base Prompt。');
    const serialized = JSON.stringify(updated);
    return multipart ? `${multipart.beforeJson}${serialized}${multipart.afterJson}` : serialized;
  }

  function readNativeBasePrompt() {
    const editors = Array.from(document.querySelectorAll('.ProseMirror[contenteditable="true"]')).filter((editor) => {
      const rect = editor.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    return String(editors[0]?.innerText || editors[0]?.textContent || '').trim();
  }

  function normalizeWhitespace(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
  }

  function truncate(value, max = 80) {
    const normalized = normalizeWhitespace(value);
    return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
  }

  function isGenerationUrl(value) {
    try {
      return GENERATION_ENDPOINT_RE.test(new URL(String(value), location.href).href);
    } catch {
      return false;
    }
  }

  function openDatabase() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(JOB_STORE)) {
          const store = db.createObjectStore(JOB_STORE, { keyPath: 'id' });
          store.createIndex('status', 'status', { unique: false });
          store.createIndex('createdAt', 'createdAt', { unique: false });
          store.createIndex('endedAt', 'endedAt', { unique: false });
        }
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(BLOB_STORE)) {
          db.createObjectStore(BLOB_STORE, { keyPath: 'hash' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return dbPromise;
  }

  async function transaction(storeNames, mode, operation) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeNames, mode);
      let result;
      try {
        result = operation(tx);
      } catch (error) {
        reject(error);
        return;
      }
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted.'));
    });
  }

  function requestAsPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function getAllJobs() {
    const db = await openDatabase();
    const tx = db.transaction(JOB_STORE, 'readonly');
    return requestAsPromise(tx.objectStore(JOB_STORE).getAll());
  }

  async function getJob(id) {
    const db = await openDatabase();
    const tx = db.transaction(JOB_STORE, 'readonly');
    return requestAsPromise(tx.objectStore(JOB_STORE).get(id));
  }

  async function putJob(job, { broadcast = true } = {}) {
    await transaction([JOB_STORE], 'readwrite', (tx) => tx.objectStore(JOB_STORE).put(job));
    if (broadcast) notifyPeers('jobs-changed');
    scheduleRefresh();
    return job;
  }

  async function updateJob(id, updater, { broadcast = true } = {}) {
    const db = await openDatabase();
    const tx = db.transaction(JOB_STORE, 'readwrite');
    const store = tx.objectStore(JOB_STORE);
    const existing = await requestAsPromise(store.get(id));
    if (!existing) return null;
    const updated = updater({ ...existing });
    if (!updated) return existing;
    store.put(updated);
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted.'));
    });
    if (broadcast) notifyPeers('jobs-changed');
    scheduleRefresh();
    return updated;
  }

  async function deleteJobRecord(id, { broadcast = true } = {}) {
    await transaction([JOB_STORE], 'readwrite', (tx) => tx.objectStore(JOB_STORE).delete(id));
    if (broadcast) notifyPeers('jobs-changed');
    scheduleRefresh();
  }

  async function getMeta(key) {
    const db = await openDatabase();
    const tx = db.transaction(META_STORE, 'readonly');
    const row = await requestAsPromise(tx.objectStore(META_STORE).get(key));
    return row?.value;
  }

  async function setMeta(key, value, { broadcast = true } = {}) {
    await transaction([META_STORE], 'readwrite', (tx) => tx.objectStore(META_STORE).put({ key, value }));
    if (broadcast) notifyPeers('meta-changed', { key });
  }

  async function loadState() {
    const defaults = defaultState();
    const stored = await getMeta('state');
    return {
      ...defaults,
      ...stored,
      batch: normalizeBatchState(stored?.batch),
      settings: normalizeQueueSettings({ ...defaults.settings, ...(stored?.settings || {}) }),
    };
  }

  async function saveState(patch) {
    const state = { ...(await loadState()), ...patch };
    state.revision = (state.revision || 0) + 1;
    await setMeta('state', state);
    cachedState = state;
    return state;
  }

  function notifyPeers(type, extra = {}) {
    channel?.postMessage({ type, from: TAB_ID, at: now(), ...extra });
  }

  async function sha256(value) {
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  function pathLooksLikeImage(path) {
    return /(?:^|\.)(?:image|mask|reference_image|reference_images|reference_image_multiple|director_reference_images|character_reference|init_image)(?:\.|\[|$)/i.test(path);
  }

  function looksLikeLargeBinary(value, path) {
    if (typeof value !== 'string' || value.length < LARGE_BINARY_MIN_LENGTH) return false;
    if (/^data:image\//i.test(value)) return true;
    if (!pathLooksLikeImage(path)) return false;
    const sample = value.slice(0, Math.min(value.length, 4_096));
    return /^[A-Za-z0-9+/=_:\-;,\s]+$/.test(sample);
  }

  async function dehydrateRequestBody(bodyText) {
    const multipart = splitMultipartRequestJson(bodyText);
    const parsed = safeJsonParse(bodyText) || multipart?.payload;
    if (!parsed) return { storedBody: bodyText, format: 'raw', blobRefs: [] };
    const blobRefs = [];
    const visit = async (value, path) => {
      if (looksLikeLargeBinary(value, path)) {
        const hash = await sha256(value);
        await transaction([BLOB_STORE], 'readwrite', (tx) => {
          tx.objectStore(BLOB_STORE).put({ hash, value, updatedAt: now() });
        });
        blobRefs.push(hash);
        return { [BLOB_REF_KEY]: hash };
      }
      if (Array.isArray(value)) {
        const result = [];
        for (let index = 0; index < value.length; index += 1) {
          result.push(await visit(value[index], `${path}[${index}]`));
        }
        return result;
      }
      if (value && typeof value === 'object') {
        const result = {};
        for (const [key, child] of Object.entries(value)) {
          result[key] = await visit(child, path ? `${path}.${key}` : key);
        }
        return result;
      }
      return value;
    };
    const dehydrated = await visit(parsed, '');
    const serialized = JSON.stringify(dehydrated);
    return {
      storedBody: multipart ? `${multipart.beforeJson}${serialized}${multipart.afterJson}` : serialized,
      format: multipart ? 'multipart-json-ref' : 'json-ref',
      blobRefs: [...new Set(blobRefs)],
    };
  }

  async function hydrateRequestBody(job) {
    if (!['json-ref', 'multipart-json-ref'].includes(job.requestFormat)) return job.requestBody;
    const multipart = job.requestFormat === 'multipart-json-ref' ? splitMultipartRequestJson(job.requestBody) : null;
    const parsed = multipart?.payload || safeJsonParse(job.requestBody);
    if (!parsed) return job.requestBody;
    const cache = new Map();
    const visit = async (value) => {
      if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && value[BLOB_REF_KEY]) {
        const hash = value[BLOB_REF_KEY];
        if (!cache.has(hash)) {
          const db = await openDatabase();
          const tx = db.transaction(BLOB_STORE, 'readonly');
          const row = await requestAsPromise(tx.objectStore(BLOB_STORE).get(hash));
          if (!row) throw new Error(`Stored image data is missing (${hash.slice(0, 8)}).`);
          cache.set(hash, row.value);
        }
        return cache.get(hash);
      }
      if (Array.isArray(value)) {
        const result = [];
        for (const child of value) result.push(await visit(child));
        return result;
      }
      if (value && typeof value === 'object') {
        const result = {};
        for (const [key, child] of Object.entries(value)) result[key] = await visit(child);
        return result;
      }
      return value;
    };
    const serialized = JSON.stringify(await visit(parsed));
    return multipart ? `${multipart.beforeJson}${serialized}${multipart.afterJson}` : serialized;
  }

  function collectBlobRefsFromStoredBody(job) {
    if (!['json-ref', 'multipart-json-ref'].includes(job.requestFormat)) return [];
    const refs = [];
    const parsed = job.requestFormat === 'multipart-json-ref'
      ? splitMultipartRequestJson(job.requestBody)?.payload
      : safeJsonParse(job.requestBody);
    const visit = (value) => {
      if (!value || typeof value !== 'object') return;
      if (!Array.isArray(value) && value[BLOB_REF_KEY]) {
        refs.push(value[BLOB_REF_KEY]);
        return;
      }
      for (const child of Object.values(value)) visit(child);
    };
    visit(parsed);
    return refs;
  }

  async function saveBatchRequestTemplate(batchId, prepared, templatePrompt) {
    const templateBody = withBasePrompt(prepared.body || '{}', templatePrompt);
    const { storedBody, format, blobRefs } = await dehydrateRequestBody(templateBody);
    const record = {
      batchId,
      capturedAt: now(),
      requestUrl: prepared.url,
      requestMethod: prepared.method,
      requestHeaders: prepared.headers,
      requestBody: storedBody,
      requestFormat: format,
      blobRefs,
      cache: prepared.cache,
      credentials: prepared.credentials,
      integrity: prepared.integrity,
      keepalive: prepared.keepalive,
      mode: prepared.mode,
      redirect: prepared.redirect,
      referrer: prepared.referrer,
      referrerPolicy: prepared.referrerPolicy,
    };
    await setMeta('batch-template', record);
    return record;
  }

  async function loadBatchRequestTemplate(batchId) {
    const record = await getMeta('batch-template');
    if (!record || record.batchId !== batchId) return null;
    const body = await hydrateRequestBody(record);
    return {
      url: record.requestUrl,
      method: record.requestMethod,
      headers: record.requestHeaders,
      body,
      cache: record.cache,
      credentials: record.credentials,
      integrity: record.integrity,
      keepalive: record.keepalive,
      mode: record.mode,
      redirect: record.redirect,
      referrer: record.referrer,
      referrerPolicy: record.referrerPolicy,
    };
  }

  async function garbageCollectBlobs() {
    const jobs = await getAllJobs();
    const referenced = new Set(jobs.flatMap(collectBlobRefsFromStoredBody));
    const batchTemplate = await getMeta('batch-template');
    for (const ref of collectBlobRefsFromStoredBody(batchTemplate || {})) referenced.add(ref);
    const db = await openDatabase();
    const tx = db.transaction(BLOB_STORE, 'readwrite');
    const store = tx.objectStore(BLOB_STORE);
    const keys = await requestAsPromise(store.getAllKeys());
    for (const key of keys) if (!referenced.has(key)) store.delete(key);
  }

  function countMeaningfulImages(value) {
    if (!value) return 0;
    if (Array.isArray(value)) return value.filter(Boolean).length;
    return 1;
  }

  function extractImageFlags(payload) {
    const flags = [];
    const params = payload?.parameters || {};
    if (payload?.action === 'img2img' || params.image) flags.push({ label: 'I2I', count: 1 });

    const vibeCount = Math.max(
      countMeaningfulImages(params.reference_image_multiple),
      countMeaningfulImages(payload?.reference_image_multiple),
    );
    if (vibeCount) flags.push({ label: 'Vibe', count: vibeCount });

    const preciseCount = Math.max(
      countMeaningfulImages(params.director_reference_images),
      countMeaningfulImages(payload?.director_reference_images),
    );
    if (preciseCount) flags.push({ label: '精确参考', count: preciseCount });

    let characterImageCount = 0;
    const walk = (value, path = '') => {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        const childPath = path ? `${path}.${key}` : key;
        if (/char(?:acter)?/i.test(childPath) && /image/i.test(key)) {
          characterImageCount += countMeaningfulImages(child);
        } else if (child && typeof child === 'object') {
          walk(child, childPath);
        }
      }
    };
    walk(payload);
    characterImageCount = Math.max(0, characterImageCount - vibeCount - preciseCount);
    if (characterImageCount) flags.push({ label: '角色 I2I', count: characterImageCount });
    return flags;
  }

  function extractSummary(bodyText, costText = '') {
    const payload = parseGenerationPayload(bodyText) || {};
    const params = payload.parameters || {};
    const basePrompt =
      params?.v4_prompt?.caption?.base_caption ??
      payload?.v4_prompt?.caption?.base_caption ??
      params.prompt ??
      payload.prompt ??
      payload.input ??
      '(无法读取 Prompt)';
    const priceMatch = String(costText).match(/(?:^|\s)(\d+(?:\.\d+)?)\s*(?:Anlas|$)/i);
    return {
      promptPreview: truncate(basePrompt, 80),
      model: String(payload.model || '未知模型'),
      width: Number(params.width) || null,
      height: Number(params.height) || null,
      imageCount: Number(params.n_samples) || 1,
      imageFlags: extractImageFlags(payload),
      capturedPrice: priceMatch ? Number(priceMatch[1]) : null,
    };
  }

  async function prepareFetchCall(input, init, bodyOverride) {
    const request = new Request(input, init);
    const method = request.method.toUpperCase();
    const body = bodyOverride !== undefined
      ? bodyOverride
      : method === 'GET' || method === 'HEAD'
        ? null
        : await request.clone().text();
    return {
      url: request.url,
      method,
      headers: Array.from(request.headers.entries()),
      body,
      cache: request.cache,
      credentials: request.credentials,
      integrity: request.integrity,
      keepalive: request.keepalive,
      mode: request.mode,
      redirect: request.redirect,
      referrer: request.referrer,
      referrerPolicy: request.referrerPolicy,
    };
  }

  async function requestFingerprint(prepared) {
    return sha256(`${prepared.method}\n${prepared.url}\n${prepared.body ?? ''}`);
  }

  function combineAbortSignals(originalSignal, timeoutController) {
    if (!originalSignal) return timeoutController.signal;
    if (originalSignal.aborted) timeoutController.abort(originalSignal.reason);
    else originalSignal.addEventListener('abort', () => timeoutController.abort(originalSignal.reason), { once: true });
    return timeoutController.signal;
  }

  function buildRequest(prepared, controller) {
    const options = {
      method: prepared.method,
      headers: new Headers(prepared.headers),
      body: prepared.method === 'GET' || prepared.method === 'HEAD' ? undefined : prepared.body,
      cache: prepared.cache,
      credentials: prepared.credentials,
      integrity: prepared.integrity,
      keepalive: prepared.keepalive,
      mode: prepared.mode,
      redirect: prepared.redirect,
      referrer: prepared.referrer,
      referrerPolicy: prepared.referrerPolicy,
      signal: controller.signal,
    };
    return new Request(prepared.url, options);
  }

  async function fetchWithTimeout(prepared, execution) {
    const controller = new AbortController();
    execution.controllers.add(controller);
    const timeoutId = nativeSetTimeout(() => controller.abort(new QueueTimeoutError()), GENERATION_TIMEOUT_MS);
    try {
      const request = buildRequest(prepared, controller);
      return await nativeFetch(request);
    } catch (error) {
      if (controller.signal.aborted && controller.signal.reason instanceof QueueTimeoutError) {
        throw controller.signal.reason;
      }
      throw error;
    } finally {
      nativeClearTimeout(timeoutId);
      execution.controllers.delete(controller);
    }
  }

  async function readErrorResponse(response) {
    try {
      const text = await response.clone().text();
      const parsed = safeJsonParse(text);
      return normalizeWhitespace(parsed?.message || parsed?.details || text || response.statusText || `HTTP ${response.status}`);
    } catch {
      return response.statusText || `HTTP ${response.status}`;
    }
  }

  async function drainResponse(response) {
    try {
      await response.clone().arrayBuffer();
    } catch {
      // The page still owns the original response. A failed clone drain is not itself a page failure.
    }
  }

  async function updateBusy(value) {
    cachedBusy = value;
    await setMeta('busy', value, { broadcast: true });
    updateGenerateClickOverlay();
    scheduleHistorySaveIndicatorUpdate();
  }

  function isBusyFresh(value) {
    return Boolean(value && now() - Number(value.heartbeatAt || value.startedAt || 0) < OWNER_STALE_MS);
  }

  async function refreshBusyCache() {
    const busy = await getMeta('busy');
    cachedBusy = isBusyFresh(busy) ? busy : null;
    return cachedBusy;
  }

  async function beginBusy(kind, jobId = null) {
    const value = { tabId: TAB_ID, kind, jobId, startedAt: now(), heartbeatAt: now() };
    await updateBusy(value);
    if (heartbeatTimer) nativeClearTimeout(heartbeatTimer);
    const beat = async () => {
      if (!cachedBusy || cachedBusy.tabId !== TAB_ID) return;
      cachedBusy = { ...cachedBusy, heartbeatAt: now() };
      await setMeta('busy', cachedBusy, { broadcast: true });
      heartbeatTimer = nativeSetTimeout(beat, 2_000);
    };
    heartbeatTimer = nativeSetTimeout(beat, 2_000);
  }

  async function endBusy(jobId = null) {
    if (heartbeatTimer) nativeClearTimeout(heartbeatTimer);
    heartbeatTimer = null;
    const busy = await getMeta('busy');
    if (busy?.tabId === TAB_ID && (!jobId || busy.jobId === jobId)) await updateBusy(null);
  }

  async function markTabHeartbeat(gone = false) {
    await setMeta(`tab:${TAB_ID}`, { tabId: TAB_ID, heartbeatAt: now(), gone }, { broadcast: false });
  }

  async function isOwnerAlive(ownerTabId) {
    if (!ownerTabId) return false;
    if (ownerTabId === TAB_ID) return true;
    const heartbeat = await getMeta(`tab:${ownerTabId}`);
    return Boolean(heartbeat && !heartbeat.gone && now() - heartbeat.heartbeatAt < OWNER_STALE_MS);
  }

  function createDeferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject, settled: false };
  }

  function getReactProps(element) {
    const key = Object.keys(element || {}).find((candidate) => candidate.startsWith('__reactProps$'));
    return key ? element[key] : null;
  }

  function getReactFiber(element) {
    const key = Object.keys(element || {}).find((candidate) => candidate.startsWith('__reactFiber$'));
    const attached = key ? element[key] : null;
    if (!attached?.alternate) return attached;
    let root = attached;
    while (root.return) root = root.return;
    return root.stateNode?.current === root ? attached : attached.alternate;
  }

  function readDownloadedState(value, depth = 0, seen = new Set()) {
    if (!value || typeof value !== 'object' || depth > 4 || seen.has(value)) return null;
    seen.add(value);
    if (Array.isArray(value.downloaded) && value.downloaded.length
      && value.downloaded.every((item) => typeof item === 'boolean')) {
      return value.downloaded.every(Boolean);
    }
    const entries = Array.isArray(value)
      ? value.slice(0, 12).map((child, index) => [String(index), child])
      : Object.entries(value).slice(0, 30);
    for (const [key, child] of entries) {
      if (depth < 2 || ['children', 'image', 'images', 'item', 'entry', 'result', 'generation', 'data', 'value', 'props'].includes(key)
        || /image|history|download/i.test(key)) {
        const found = readDownloadedState(child, depth + 1, seen);
        if (found !== null) return found;
      }
    }
    return null;
  }

  function readHistoryImageSavedState(element) {
    let fiber = getReactFiber(element);
    for (let depth = 0; fiber && depth < 10; depth += 1, fiber = fiber.return) {
      for (const branch of [fiber, fiber.alternate]) {
        if (!branch) continue;
        for (const value of [branch.memoizedProps, branch.pendingProps, branch.memoizedState]) {
          const found = readDownloadedState(value);
          if (found !== null) return found;
        }
      }
    }
    return null;
  }

  function downloadButtonLabel(button) {
    return normalizeWhitespace([
      button.getAttribute('aria-label'),
      button.getAttribute('title'),
      button.getAttribute('data-tooltip'),
      button.textContent,
    ].filter(Boolean).join(' '));
  }

  function isSingleImageDownloadButton(button) {
    const label = downloadButtonLabel(button);
    return /download\s*(?:this\s*)?image|下载(?:此|该)?图片/i.test(label)
      && !/download\s*all|全部下载/i.test(label);
  }

  function readDownloadButtonVisualState() {
    const states = [];
    for (const button of document.querySelectorAll('button')) {
      const label = downloadButtonLabel(button);
      if (/download\s*all|全部下载/i.test(label)) continue;
      const icon = Array.from(button.querySelectorAll('*')).find((element) => {
        const mask = getComputedStyle(element).maskImage || getComputedStyle(element).webkitMaskImage || '';
        return /\/save(?:\.[^/"')]+)?\.svg/i.test(mask);
      });
      if (!icon && !isSingleImageDownloadButton(button)) continue;
      const rect = button.getBoundingClientRect();
      if (rect.width < 16 || rect.height < 16 || rect.right <= 0 || rect.bottom <= 0
        || rect.left >= window.innerWidth || rect.top >= window.innerHeight) continue;
      const props = getReactProps(button);
      const opacity = Number.parseFloat(getComputedStyle(icon || button).opacity);
      states.push(Boolean(button.disabled || props?.disabled || button.getAttribute('aria-disabled') === 'true'
        || (Number.isFinite(opacity) && opacity <= 0.5)));
    }
    return states.length ? states.every(Boolean) : null;
  }

  function isSelectedHistoryItem(item) {
    if (item.getAttribute('aria-selected') === 'true' || item.getAttribute('aria-pressed') === 'true'
      || item.getAttribute('data-selected') === 'true') return true;
    return getComputedStyle(item).boxShadow !== 'none';
  }

  function findHistoryRoot() {
    const directRoot = document.querySelector('#historyContainer.image-gen-history, #historyContainer, .image-gen-history');
    if (directRoot) return directRoot;
    const toggles = Array.from(document.querySelectorAll('button')).filter((button) => {
      const label = downloadButtonLabel(button);
      return /(?:collapse|expand)?\s*history|历史记录|历史/i.test(label);
    });
    for (const toggle of toggles) {
      let candidate = toggle.parentElement;
      for (let depth = 0; candidate && depth < 10; depth += 1, candidate = candidate.parentElement) {
        const rect = candidate.getBoundingClientRect();
        if (candidate.querySelector('img, [role="button"][aria-label="choose image"]') && rect.width > 80 && rect.width <= 560
          && rect.right >= window.innerWidth * 0.6) return candidate;
      }
    }
    return null;
  }

  function ensureHistoryIndicatorStyle() {
    if (document.getElementById('nai-image-workbench-history-save-style')) return;
    const style = document.createElement('style');
    style.id = 'nai-image-workbench-history-save-style';
    style.textContent = `
      [data-nai-image-workbench-history-saved]::after {
        content: "";
        position: absolute;
        right: 5px;
        bottom: 5px;
        z-index: 4;
        width: 10px;
        height: 10px;
        border: 1.5px solid rgba(12, 15, 34, .92);
        border-radius: 999px;
        box-shadow: 0 1px 4px rgba(0, 0, 0, .55);
        pointer-events: none !important;
      }
      [data-nai-image-workbench-history-saved="true"]::after { background: #39d98a; }
      [data-nai-image-workbench-history-saved="false"]::after { background: #ff5d73; }
    `;
    (document.head || document.documentElement).append(style);
  }

  function clearHistorySaveIndicators() {
    document.querySelectorAll('[data-nai-image-workbench-history-saved]').forEach((element) => {
      element.removeAttribute('data-nai-image-workbench-history-saved');
    });
  }

  function updateHistorySaveIndicators() {
    if (!cachedState.settings.historySaveIndicator) {
      clearHistorySaveIndicators();
      return;
    }
    const root = findHistoryRoot();
    if (!root) return;
    ensureHistoryIndicatorStyle();
    const choiceItems = Array.from(root.querySelectorAll('[role="button"][aria-label="choose image"]'));
    const historyItems = (choiceItems.length ? choiceItems : Array.from(root.querySelectorAll('img'))).filter((item) => {
      const rect = item.getBoundingClientRect();
      return rect.width >= 24 && rect.height >= 24;
    });
    const markedTargets = new Set();
    const visualSaved = readDownloadButtonVisualState();
    const localGenerationRunning = cachedBusy?.tabId === TAB_ID;
    for (const item of historyItems) {
      let target = item.matches('[role="button"][aria-label="choose image"]')
        ? item
        : item.closest('[role="button"][aria-label="choose image"], button') || item.parentElement || item;
      const stateKey = target;
      let scope = target;
      let downloadButton = null;
      for (let depth = 0; scope && scope !== root && depth < 6; depth += 1, scope = scope.parentElement) {
        downloadButton = Array.from(scope.querySelectorAll('button')).find(isSingleImageDownloadButton) || null;
        if (downloadButton) {
          target = scope;
          break;
        }
      }
      let saved = null;
      if (downloadButton) {
        const props = getReactProps(downloadButton);
        saved = Boolean(downloadButton.disabled || props?.disabled || downloadButton.getAttribute('aria-disabled') === 'true');
      }
      if (saved === null) saved = readHistoryImageSavedState(target) ?? readHistoryImageSavedState(item);
      if (saved !== null) historySavedStates.set(stateKey, saved);
      if (isSelectedHistoryItem(target) && (localGenerationRunning || visualSaved !== null)) {
        saved = localGenerationRunning ? false : visualSaved;
        historySavedStates.set(stateKey, saved);
      }
      if (saved === null) saved = historySavedStates.get(stateKey) ?? false;
      if (saved !== null) {
        const nextValue = String(saved);
        markedTargets.add(target);
        if (target.getAttribute('data-nai-image-workbench-history-saved') !== nextValue) {
          target.setAttribute('data-nai-image-workbench-history-saved', nextValue);
        }
      }
    }
    root.querySelectorAll('[data-nai-image-workbench-history-saved]').forEach((element) => {
      if (!markedTargets.has(element)) element.removeAttribute('data-nai-image-workbench-history-saved');
    });
  }

  function scheduleHistorySaveIndicatorUpdate() {
    if (historyHighlightTimer) nativeClearTimeout(historyHighlightTimer);
    const interactionDelay = Math.max(0, historyInteractionUntil - now());
    historyHighlightTimer = nativeSetTimeout(() => {
      historyHighlightTimer = null;
      updateHistorySaveIndicators();
    }, Math.max(120, interactionDelay));
  }

  function deferHistoryIndicatorDuringInteraction(event) {
    const root = findHistoryRoot();
    if (!root?.contains(event.target)) return;
    historyInteractionUntil = now() + 450;
    scheduleHistorySaveIndicatorUpdate();
  }

  function findGenerationComponentFiber(button) {
    let fiber = getReactFiber(button);
    for (let depth = 0; fiber && depth < 16; depth += 1, fiber = fiber.return) {
      const type = fiber.elementType || fiber.type;
      if (typeof type !== 'function') continue;
      const source = String(type);
      if (source.includes('generateImageNormal') && source.includes('generateImageGrid')) return fiber;
    }
    return null;
  }

  function readJotaiBooleanAtoms(button) {
    const fiber = findGenerationComponentFiber(button);
    const found = [];
    let hook = fiber?.memoizedState;
    for (let index = 0; hook && index < 260; index += 1, hook = hook.next) {
      const value = hook.memoizedState;
      if (!Array.isArray(value) || typeof value[0] !== 'boolean') continue;
      const store = value[1];
      const atom = value[2];
      if (!store || typeof store.get !== 'function' || typeof store.set !== 'function' || !atom) continue;
      let current;
      try {
        current = store.get(atom);
      } catch {
        continue;
      }
      if (typeof current === 'boolean') {
        const duplicate = found.find((candidate) => candidate.store === store && candidate.atom === atom);
        if (duplicate) duplicate.indices.push(index);
        else found.push({ index, indices: [index], store, atom, value: current });
      }
    }
    return found;
  }

  function rememberIdleJotaiAtoms(button) {
    if (!button || cachedBusy || button.disabled) return;
    const atoms = readJotaiBooleanAtoms(button);
    if (atoms.length) idleJotaiBooleanAtoms = atoms;
  }

  function temporarilyReleaseNovelAIBusy(button) {
    const current = readJotaiBooleanAtoms(button);
    const changed = current.filter((candidate) => {
      const idle = idleJotaiBooleanAtoms.find((saved) => saved.atom === candidate.atom && saved.store === candidate.store);
      return idle?.value === false && candidate.value === true;
    });
    if (uiHost) uiHost.dataset.naiBusyCandidates = JSON.stringify({ idle: idleJotaiBooleanAtoms.length, current: current.length, changed: changed.map((item) => item.indices) });
    if (changed.length > 1 || (!changed.length && !current.length)) return null;
    const selected = changed[0] || current[0];
    return {
      store: selected.store,
      atom: changed[0]?.atom || null,
      isBusy: () => Boolean(changed[0]?.atom && selected.store.get(changed[0].atom)),
    };
  }

  function prepareCurrentGenerationCallback(button, busyAccess, wantsGridOverride = null) {
    const fiber = findGenerationComponentFiber(button);
    let normalCallback = null;
    let gridCallback = null;
    let generationApi = null;
    const atomSnapshot = new Map();
    let hook = fiber?.memoizedState;
    for (let index = 0; hook && index < 260; index += 1, hook = hook.next) {
      const value = hook.memoizedState;
      if (Array.isArray(value) && typeof value[0] === 'function') {
        const candidate = value[0];
        const source = String(candidate);
        if (source.includes('let i=sF(') && source.includes('sG(')) normalCallback = candidate;
        else if (source.includes('sT(') && source.includes('gridXLength') && source.includes('sG(')) gridCallback = candidate;
      }
      if (Array.isArray(value) && value[1] === busyAccess.store && value[2]) {
        try {
          atomSnapshot.set(value[2], busyAccess.store.get(value[2]));
        } catch {
          // A derived atom can become temporarily unreadable during a render.
        }
      }
      const possibleApi = Array.isArray(value) ? value[0] : value;
      if (possibleApi && typeof possibleApi === 'object' && typeof possibleApi.generateNormal === 'function') {
        generationApi = possibleApi;
      }
    }
    const wantsGrid = wantsGridOverride === null ? /grid|网格/i.test(button.innerText || '') : wantsGridOverride;
    const selected = wantsGrid ? gridCallback : normalCallback;
    if (typeof selected !== 'function' || !generationApi) return null;
    return { selected, wantsGrid, atomSnapshot, generationApi };
  }

  async function captureGenerationInvocation(preparedCallback, busyAccess) {
    const methodName = preparedCallback.wantsGrid && typeof preparedCallback.generationApi.generateGrid === 'function'
      ? 'generateGrid'
      : 'generateNormal';
    const apiEntry = {
      api: preparedCallback.generationApi,
      methodName,
      originalMethod: preparedCallback.generationApi[methodName],
    };
    if (typeof apiEntry.originalMethod !== 'function') return null;
    const pendingSets = [];
    let activated = false;
    let captured = null;
    let resolveCaptured;
    const capturedPromise = new Promise((resolve) => { resolveCaptured = resolve; });
    const get = (atom) => {
      if (activated) return busyAccess.store.get(atom);
      const value = busyAccess.store.get(atom);
      preparedCallback.atomSnapshot.set(atom, value);
      return atom === busyAccess.atom ? false : value;
    };
    const set = (atom, ...args) => {
      if (activated) return busyAccess.store.set(atom, ...args);
      pendingSets.push({ atom, args });
      return undefined;
    };
    apiEntry.api[apiEntry.methodName] = function captureLowLevelGeneration(...args) {
      if (!captured) {
        captured = { args, thisArg: this };
        resolveCaptured(captured);
      }
      return undefined;
    };
    try {
      const returned = preparedCallback.wantsGrid
        ? preparedCallback.selected(get, set)
        : preparedCallback.selected(get, set, false);
      if (returned && typeof returned.catch === 'function') {
        returned.catch((error) => console.error('[NAI Image Workbench] Generation plan capture failed:', error));
      }
      await Promise.race([
        capturedPromise,
        new Promise((resolve) => nativeSetTimeout(resolve, 3_000)),
      ]);
    } finally {
      apiEntry.api[apiEntry.methodName] = apiEntry.originalMethod;
    }
    if (!captured) return null;
    return {
      ...captured,
      originalMethod: apiEntry.originalMethod,
      activate() {
        if (activated) return;
        activated = true;
        for (const operation of pendingSets) busyAccess.store.set(operation.atom, ...operation.args);
      },
    };
  }

  function findGenerateButton() {
    return document.querySelector('button.image-gen-generate-button');
  }

  function createCaptureSession(type, details = {}) {
    let resolveCapture;
    const session = {
      id: `${TAB_ID}:${++captureSequence}`,
      type,
      createdAt: now(),
      consumed: false,
      capturePromise: new Promise((resolve) => { resolveCapture = resolve; }),
      resolveCapture,
      ...details,
    };
    captureSessions.push(session);
    session.cleanupTimer = nativeSetTimeout(() => {
      const index = captureSessions.indexOf(session);
      if (index >= 0) captureSessions.splice(index, 1);
      if (!session.consumed) {
        session.expired = true;
        session.resolveCapture(false);
        if (session.type === 'enqueue') return;
        if (session.type === 'batch-start' || session.type === 'batch-refresh') {
          void loadState().then((state) => saveState({
            batch: normalizeBatchState({
              ...state.batch,
              status: 'failed',
              error: '没有捕获到 NovelAI 生成请求。',
              current: state.batch.current ? { ...state.batch.current, jobId: null, status: 'failed' } : null,
              updatedAt: now(),
            }),
          })).then(scheduleRefresh);
          notify('没有捕获到批量生成请求，特殊模式已暂停。', 'error');
          return;
        }
        notify('没有捕获到生成请求，队列已暂停。', 'error');
        void saveState({ paused: true }).then(scheduleRefresh);
      }
    }, 15_000);
    return session;
  }

  function consumeCaptureSession() {
    const session = captureSessions.shift();
    if (!session) return null;
    session.consumed = true;
    session.resolveCapture(true);
    nativeClearTimeout(session.cleanupTimer);
    return session;
  }

  function discardCaptureSession(session) {
    const index = captureSessions.indexOf(session);
    if (index >= 0) captureSessions.splice(index, 1);
    nativeClearTimeout(session.cleanupTimer);
    if (!session.consumed) session.resolveCapture(false);
  }

  function invokeNovelAIOnClick(button, event, session) {
    const props = getReactProps(button);
    if (typeof props?.onClick !== 'function') {
      const index = captureSessions.indexOf(session);
      if (index >= 0) captureSessions.splice(index, 1);
      nativeClearTimeout(session.cleanupTimer);
      notify('无法连接 NovelAI 的生成处理函数，队列已暂停。', 'error');
      void saveState({ paused: true });
      return false;
    }
    try {
      // React intentionally suppresses native click delivery for disabled form
      // controls. Temporarily make both the DOM and the current React props
      // clickable for this one synchronous dispatch, then restore them before
      // returning. This preserves NovelAI's real SyntheticEvent and handler.
      const domDisabled = button.disabled;
      const reactDisabled = props.disabled;
      if (domDisabled) button.disabled = false;
      if (reactDisabled) props.disabled = false;
      try {
        button.dispatchEvent(new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          composed: true,
          ctrlKey: Boolean(event?.ctrlKey),
          metaKey: Boolean(event?.metaKey),
          shiftKey: Boolean(event?.shiftKey),
          altKey: Boolean(event?.altKey),
          view: window,
        }));
      } finally {
        if (reactDisabled) props.disabled = reactDisabled;
        if (domDisabled) button.disabled = true;
      }
      return true;
    } catch (error) {
      const index = captureSessions.indexOf(session);
      if (index >= 0) captureSessions.splice(index, 1);
      nativeClearTimeout(session.cleanupTimer);
      notify(`无法读取当前配置：${error.message || error}`, 'error');
      void saveState({ paused: true });
      return false;
    }
  }

  const originalSetTimeout = window.setTimeout.bind(window);
  window.setTimeout = function patchedSetTimeout(callback, delay, ...args) {
    if (Number(delay) === GENERATION_TIMEOUT_MS && captureSessions.length > 0) {
      return originalSetTimeout(() => {}, GENERATION_TIMEOUT_MS);
    }
    return originalSetTimeout(callback, delay, ...args);
  };

  async function buildStoredJobFromPrepared(prepared, details = {}) {
    const { storedBody, format, blobRefs } = await dehydrateRequestBody(prepared.body || '{}');
    const summary = extractSummary(prepared.body || '{}', details.costText || '');
    return {
      id: details.id || crypto.randomUUID(),
      createdAt: now(),
      updatedAt: now(),
      endedAt: null,
      status: 'queued',
      ownerTabId: TAB_ID,
      promptPreview: summary.promptPreview,
      model: summary.model,
      width: summary.width,
      height: summary.height,
      imageCount: summary.imageCount,
      imageFlags: summary.imageFlags,
      capturedPrice: summary.capturedPrice,
      requestUrl: prepared.url,
      requestMethod: prepared.method,
      requestHeaders: prepared.headers,
      requestBody: storedBody,
      requestFormat: format,
      blobRefs,
      queueRetry: 0,
      siteAttempts: 0,
      retryAt: null,
      error: null,
      source: details.source || 'captured',
      batchId: details.batchId || null,
      batchItemId: details.batchItemId || null,
      batchVariable: details.batchVariable || null,
      batchValue: details.batchValue ?? null,
      batchPrompt: details.batchPrompt || null,
    };
  }

  async function addCapturedJob(prepared, captureSession, deferred) {
    const job = await buildStoredJobFromPrepared(prepared, { costText: captureSession.costText });
    const fingerprint = await requestFingerprint(prepared);
    runtimeJobs.set(job.id, {
      prepared,
      deferred,
      fingerprint,
      capturedAt: now(),
      activation: captureSession.activation || null,
    });
    await putJob(job);
    notify('已加入队列。', 'success');
    notifyPeers('kick');
    kickScheduler();
    return job;
  }

  async function handleBatchCapturedGeneration(prepared, session) {
    const deferred = createDeferred();
    const currentState = await loadState();
    const batch = normalizeBatchState(currentState.batch);
    if (!batch.id || batch.id !== session.batchId || !batch.current || batch.current.id !== session.batchItemId) {
      throw new Error('批量替换状态已经变化，本次请求未发送。');
    }
    const prompt = replacePromptTemplate(batch.templatePrompt, batch.variableName, batch.current.value);
    const batchPrepared = { ...prepared, body: withBasePrompt(prepared.body || '{}', prompt) };
    await saveBatchRequestTemplate(batch.id, prepared, batch.templatePrompt);
    const job = await buildStoredJobFromPrepared(batchPrepared, {
      id: session.jobId || crypto.randomUUID(),
      costText: session.costText,
      source: 'batch-replace',
      batchId: batch.id,
      batchItemId: batch.current.id,
      batchVariable: batch.variableName,
      batchValue: batch.current.value,
      batchPrompt: prompt,
    });
    const fingerprint = await requestFingerprint(batchPrepared);
    runtimeJobs.set(job.id, { prepared: batchPrepared, deferred, fingerprint, capturedAt: now(), batch: true });
    await putJob(job);
    await saveState({
      batch: normalizeBatchState({
        ...batch,
        status: 'running',
        current: { ...batch.current, jobId: job.id, prompt, status: 'queued' },
        error: null,
        configCapturedAt: now(),
        updatedAt: now(),
      }),
    });
    notify('批量替换已开始。', 'success');
    notifyPeers('kick');
    kickScheduler();
    scheduleBatchController();
    return deferred.promise;
  }

  async function bindCarrierJob(job, prepared, deferred) {
    const storedBody = await hydrateRequestBody(job);
    const carrierPrepared = {
      ...prepared,
      url: job.requestUrl || prepared.url,
      method: job.requestMethod || prepared.method,
      headers: job.requestHeaders || prepared.headers,
      body: storedBody,
    };
    const fingerprint = await requestFingerprint(carrierPrepared);
    runtimeJobs.set(job.id, { prepared: carrierPrepared, deferred, fingerprint, capturedAt: now(), carrier: true });
    await updateJob(job.id, (current) => ({
      ...current,
      ownerTabId: TAB_ID,
      status: 'queued',
      updatedAt: now(),
      error: null,
    }));
    notifyPeers('kick');
    kickScheduler();
  }

  async function handleCapturedGenerationFetch(input, init, session) {
    const prepared = await prepareFetchCall(input, init);
    if (session.type === 'batch-start' || session.type === 'batch-refresh') {
      return handleBatchCapturedGeneration(prepared, session);
    }
    const deferred = createDeferred();
    if (session.type === 'carrier') {
      const job = await getJob(session.jobId);
      if (!job) throw new Error('The restored queue task no longer exists.');
      await bindCarrierJob(job, prepared, deferred);
    } else {
      await addCapturedJob(prepared, session, deferred);
    }
    return deferred.promise;
  }

  async function trackDirectGeneration(input, init) {
    await beginBusy('direct');
    let response;
    try {
      response = await nativeFetch(input, init);
      void drainResponse(response).finally(async () => {
        const state = await loadState();
        await sleep(state.settings.interJobDelayMs);
        await endBusy();
        notifyPeers('kick');
        kickScheduler();
      });
      return response;
    } catch (error) {
      await endBusy();
      notifyPeers('kick');
      kickScheduler();
      throw error;
    }
  }

  async function performQueueRetries(prepared, execution) {
    let retryIndex = 0;
    const state = await loadState();
    const retryDelays = QUEUE_RETRY_DELAYS_MS.slice(0, state.settings.maxRetries);
    while (true) {
      try {
        const response = await fetchWithTimeout(prepared, execution);
        if (response.status !== 429 || retryIndex >= retryDelays.length) return response;
        const retryAfterHeader = Number(response.headers.get('retry-after'));
        const delay = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
          ? retryAfterHeader * 1_000
          : retryDelays[retryIndex];
        retryIndex += 1;
        await updateJob(execution.jobId, (job) => ({
          ...job,
          status: 'retry_wait',
          queueRetry: retryIndex,
          retryAt: now() + delay,
          error: `429，${Math.ceil(delay / 1_000)} 秒后重试`,
          updatedAt: now(),
        }));
        await waitForRetryDelay(execution.jobId, delay);
        await updateJob(execution.jobId, (job) => ({ ...job, status: 'running', retryAt: null, updatedAt: now() }));
      } catch (error) {
        if (error instanceof QueueTimeoutError) throw error;
        if (retryIndex >= retryDelays.length) throw error;
        const delay = retryDelays[retryIndex];
        retryIndex += 1;
        await updateJob(execution.jobId, (job) => ({
          ...job,
          status: 'retry_wait',
          queueRetry: retryIndex,
          retryAt: now() + delay,
          error: `连接失败，${Math.ceil(delay / 1_000)} 秒后重试`,
          updatedAt: now(),
        }));
        await waitForRetryDelay(execution.jobId, delay);
        await updateJob(execution.jobId, (job) => ({ ...job, status: 'running', retryAt: null, updatedAt: now() }));
      }
    }
  }

  async function waitForRetryDelay(jobId, delayMs) {
    let remaining = delayMs;
    let lastTick = now();
    while (remaining > 0) {
      const state = await loadState();
      const tickAt = now();
      if (!state.paused && state.settings.queueEnabled) remaining -= tickAt - lastTick;
      lastTick = tickAt;
      await updateJob(jobId, (job) => ({
        ...job,
        retryAt: now() + Math.max(0, remaining),
        updatedAt: now(),
      }), { broadcast: false });
      await sleep(Math.min(500, Math.max(50, remaining)));
    }
    notifyPeers('jobs-changed');
  }

  async function handleBatchJobFinished(job) {
    if (!job?.batchId || !job.batchItemId) return;
    const state = await loadState();
    const batch = normalizeBatchState(state.batch);
    if (batch.id !== job.batchId || batch.current?.id !== job.batchItemId) return;
    if (job.status === 'success') {
      let status = batch.status;
      if (!batch.items.length) status = 'completed';
      else if (status === 'capturing' || status === 'running') status = 'running';
      const discard = batch.discardCurrentRecord;
      await saveState({
        batch: normalizeBatchState({
          ...batch,
          status,
          current: null,
          completed: batch.completed + 1,
          error: null,
          discardCurrentRecord: false,
          updatedAt: now(),
        }),
      });
      if (discard) await deleteJobRecord(job.id, { broadcast: false });
      if (status === 'completed') notify('批量替换已全部完成。', 'success');
      scheduleBatchController();
      return;
    }
    await saveState({
      batch: normalizeBatchState({
        ...batch,
        status: 'failed',
        current: { ...batch.current, jobId: job.id, status: job.status },
        error: job.error || (job.status === 'unknown' ? '结果未知。' : '生成失败。'),
        discardCurrentRecord: false,
        updatedAt: now(),
      }),
    });
    notify('批量替换当前项失败，已暂停且保留该单位。', 'error');
  }

  async function finishJob(jobId, status, error = null) {
    const updated = await updateJob(jobId, (job) => {
      if (job.status === 'deleted_pending') return job;
      return {
        ...job,
        status,
        error: error ? normalizeWhitespace(error) : null,
        endedAt: now(),
        updatedAt: now(),
        retryAt: null,
        ownerTabId: null,
      };
    });
    runtimeJobs.delete(jobId);
    await trimFinishedJobs();
    await handleBatchJobFinished(updated);
    if (status !== 'success' && !updated?.batchId) await saveState({ paused: true });
    scheduleRefresh();
    return updated;
  }

  async function trimFinishedJobs() {
    const jobs = await getAllJobs();
    const finished = jobs
      .filter((job) => ['success', 'failed', 'unknown'].includes(job.status))
      .sort((a, b) => Number(b.endedAt || 0) - Number(a.endedAt || 0));
    const state = await loadState();
    const maxFinished = state.settings.maxFinished;
    if (finished.length <= maxFinished) return;
    for (const job of finished.slice(maxFinished)) await deleteJobRecord(job.id, { broadcast: false });
    notifyPeers('jobs-changed');
    void garbageCollectBlobs();
  }

  function createExecution(job, runtime) {
    let resolveOutcome;
    const outcome = new Promise((resolve) => { resolveOutcome = resolve; });
    return {
      jobId: job.id,
      runtime,
      fingerprint: runtime.fingerprint,
      controllers: new Set(),
      awaitingSiteRetry: false,
      retryGraceTimer: null,
      outcome,
      resolveOutcome,
      finished: false,
    };
  }

  async function finalizeExecution(execution, status, error = null) {
    if (execution.finished) return;
    execution.finished = true;
    if (execution.retryGraceTimer) nativeClearTimeout(execution.retryGraceTimer);
    for (const controller of execution.controllers) controller.abort(new Error('Queue task stopped.'));
    await finishJob(execution.jobId, status, error);
    execution.resolveOutcome({ status, error });
  }

  function waitForSiteRetryOrFail(execution, errorText) {
    execution.awaitingSiteRetry = true;
    if (errorText) execution.lastServerError = errorText;
    if (execution.retryGraceTimer) nativeClearTimeout(execution.retryGraceTimer);
    execution.retryGraceTimer = nativeSetTimeout(() => {
      void finalizeExecution(execution, 'failed', execution.lastServerError || 'NovelAI server error.');
    }, SITE_RETRY_GRACE_MS);
  }

  async function deliverAttemptResponse(execution, response, deferred = null) {
    const drain = drainResponse(response);
    if (response.status >= 500) {
      // Set this before the page receives the response. NovelAI can schedule its
      // own retry in the next microtask, so a later flag would race that fetch.
      waitForSiteRetryOrFail(execution, `HTTP ${response.status}`);
    }
    if (deferred && !deferred.settled) {
      deferred.settled = true;
      deferred.resolve(response);
    }
    if (response.ok) {
      await drain;
      const state = await loadState();
      await sleep(state.settings.interJobDelayMs);
      await finalizeExecution(execution, 'success');
      return;
    }
    const errorText = await readErrorResponse(response);
    if (response.status >= 500) {
      execution.lastServerError = errorText;
      return;
    }
    await drain;
    await finalizeExecution(execution, 'failed', `${response.status}: ${errorText}`);
  }

  async function handleSiteInternalRetry(input, init, execution) {
    if (execution.retryGraceTimer) nativeClearTimeout(execution.retryGraceTimer);
    execution.retryGraceTimer = null;
    execution.awaitingSiteRetry = false;
    const prepared = await prepareFetchCall(input, init);
    const fingerprint = await requestFingerprint(prepared);
    if (fingerprint !== execution.fingerprint) return trackDirectGeneration(input, init);
    await updateJob(execution.jobId, (job) => ({
      ...job,
      status: 'running',
      siteAttempts: Number(job.siteAttempts || 0) + 1,
      updatedAt: now(),
    }));
    try {
      const response = await performQueueRetries(prepared, execution);
      void deliverAttemptResponse(execution, response, null);
      return response;
    } catch (error) {
      await finalizeExecution(
        execution,
        error instanceof QueueTimeoutError ? 'unknown' : 'failed',
        error.message || String(error),
      );
      throw error;
    }
  }

  async function executeRuntimeJob(job, runtime) {
    const execution = createExecution(job, runtime);
    currentExecution = execution;
    await beginBusy('queue', job.id);
    if (runtime.activation) {
      runtime.activation();
      runtime.activation = null;
    }
    await updateJob(job.id, (current) => ({
      ...current,
      status: 'running',
      siteAttempts: Number(current.siteAttempts || 0) + 1,
      updatedAt: now(),
      error: null,
      retryAt: null,
    }));
    try {
      const response = await performQueueRetries(runtime.prepared, execution);
      void deliverAttemptResponse(execution, response, runtime.deferred);
      await execution.outcome;
    } catch (error) {
      if (!runtime.deferred.settled) {
        runtime.deferred.settled = true;
        runtime.deferred.reject(error);
      }
      const status = error instanceof QueueTimeoutError ? 'unknown' : 'failed';
      await finalizeExecution(execution, status, error.message || String(error));
      if (status === 'unknown') notify('任务超时，结果未知；队列已暂停。', 'error');
    } finally {
      await endBusy(job.id);
      if (currentExecution === execution) currentExecution = null;
      notifyPeers('kick');
      kickScheduler();
    }
  }

  async function withExecutionLock(callback) {
    if (navigator.locks?.request) {
      return navigator.locks.request(EXECUTION_LOCK, { mode: 'exclusive' }, callback);
    }
    return callback();
  }

  async function adoptJob(job) {
    const updated = await updateJob(job.id, (current) => {
      if (current.status !== 'queued' && current.status !== 'retry_wait') return current;
      return { ...current, ownerTabId: TAB_ID, updatedAt: now() };
    });
    return updated;
  }

  async function createCarrierForJob(job) {
    if (captureSessions.some((session) => session.type === 'carrier')) return;
    const button = findGenerateButton();
    if (!button) {
      notify('NovelAI 生成按钮尚未准备好。', 'error');
      return;
    }
    const session = createCaptureSession('carrier', { jobId: job.id, costText: button.innerText });
    if (job.source === 'batch-replace' && batchRuntimePlan?.batchId === job.batchId) {
      try {
        const args = [...batchRuntimePlan.invocation.args];
        args[0] = { ...(args[0] || {}), prompt: job.batchPrompt };
        const returned = batchRuntimePlan.invocation.originalMethod.apply(batchRuntimePlan.invocation.thisArg, args);
        if (returned && typeof returned.catch === 'function') {
          returned.catch((error) => console.error('[NAI Image Workbench] Batch carrier failed:', error));
        }
        return;
      } catch (error) {
        const index = captureSessions.indexOf(session);
        if (index >= 0) captureSessions.splice(index, 1);
        nativeClearTimeout(session.cleanupTimer);
        throw error;
      }
    }
    invokeNovelAIOnClick(button, null, session);
  }

  function queueJobs(jobs) {
    return jobs
      .filter((job) => ['queued', 'running', 'retry_wait', 'deleted_pending'].includes(job.status))
      .sort((a, b) => Number(a.createdAt) - Number(b.createdAt));
  }

  async function createBatchJobFromTemplate(batch, current) {
    const template = await loadBatchRequestTemplate(batch.id);
    if (!template) throw new Error('批量配置快照缺失，请暂停后重新读取当前配置。');
    const prompt = replacePromptTemplate(batch.templatePrompt, batch.variableName, current.value);
    const prepared = { ...template, body: withBasePrompt(template.body || '{}', prompt) };
    return buildStoredJobFromPrepared(prepared, {
      id: current.jobId,
      source: 'batch-replace',
      batchId: batch.id,
      batchItemId: current.id,
      batchVariable: batch.variableName,
      batchValue: current.value,
      batchPrompt: prompt,
    });
  }

  async function advanceBatchController() {
    if (batchControllerRunning) return;
    batchControllerRunning = true;
    try {
      const run = async () => {
        const state = await loadState();
        const batch = normalizeBatchState(state.batch);
        if (batch.status !== 'running' || batch.current || state.paused || !state.settings.queueEnabled) return;
        const jobs = queueJobs(await getAllJobs()).filter((job) => job.status !== 'deleted_pending');
        await refreshBusyCache();
        if (jobs.length || cachedBusy || pendingSnapshotCaptures.some((item) => !item.cancelled)) return;
        if (!batch.items.length) {
          await saveState({ batch: normalizeBatchState({ ...batch, status: 'completed', updatedAt: now() }) });
          notify('批量替换已全部完成。', 'success');
          scheduleRefresh();
          return;
        }
        const current = {
          id: crypto.randomUUID(),
          value: batch.items[0],
          jobId: crypto.randomUUID(),
          prompt: replacePromptTemplate(batch.templatePrompt, batch.variableName, batch.items[0]),
          status: batch.pendingTemplateRefresh ? 'capturing' : 'queued',
        };
        const nextBatch = normalizeBatchState({
          ...batch,
          status: batch.pendingTemplateRefresh ? 'capturing' : 'running',
          items: batch.items.slice(1),
          current,
          error: null,
          updatedAt: now(),
        });
        await saveState({ batch: nextBatch });
        scheduleRefresh();
        if (batch.pendingTemplateRefresh) {
          if (!batchRuntimePlan || batchRuntimePlan.batchId !== batch.id) {
            await saveState({
              batch: normalizeBatchState({
                ...nextBatch,
                status: 'failed',
                error: '新配置尚未保存在当前页面，请再次点击“重新读取配置”。',
                current: { ...current, status: 'failed' },
                updatedAt: now(),
              }),
            });
            return;
          }
          await dispatchBatchRuntimePlan(batchRuntimePlan, nextBatch, current, 'batch-refresh');
          const refreshed = await loadState();
          await saveState({ batch: normalizeBatchState({ ...refreshed.batch, pendingTemplateRefresh: false, updatedAt: now() }) });
          return;
        }
        try {
          const job = await createBatchJobFromTemplate(nextBatch, current);
          await putJob(job);
          notifyPeers('kick');
          kickScheduler();
        } catch (error) {
          await saveState({
            batch: normalizeBatchState({
              ...nextBatch,
              status: 'failed',
              error: error.message || String(error),
              current: { ...current, status: 'failed' },
              updatedAt: now(),
            }),
          });
          notify(`批量替换已暂停：${error.message || error}`, 'error');
        }
      };
      if (navigator.locks?.request) await navigator.locks.request(BATCH_CONTROLLER_LOCK, { mode: 'exclusive' }, run);
      else await run();
    } finally {
      batchControllerRunning = false;
      scheduleRefresh();
    }
  }

  function scheduleBatchController() {
    if (batchControllerTimer) nativeClearTimeout(batchControllerTimer);
    batchControllerTimer = nativeSetTimeout(() => {
      batchControllerTimer = null;
      void advanceBatchController();
    }, 120);
  }

  async function runScheduler() {
    if (schedulerRunning) return;
    schedulerRunning = true;
    try {
      const state = await loadState();
      if (state.paused || !state.settings.queueEnabled) return;
      const jobs = queueJobs(await getAllJobs()).filter((job) => job.status !== 'deleted_pending');
      const head = jobs[0];
      if (!head) return;
      if (head.status === 'running') {
        if (currentExecution?.jobId === head.id || await isOwnerAlive(head.ownerTabId)) return;
        await finishJob(head.id, 'unknown', '执行标签页已关闭或失去响应，无法确认远端请求结果。');
        await saveState({ paused: true });
        notify('发现失去执行页面的任务，已标为“结果未知”并暂停。', 'error');
        return;
      }
      const busy = await refreshBusyCache();
      if (busy && busy.tabId !== TAB_ID) return;

      let ownedJob = head;
      if (head.ownerTabId !== TAB_ID) {
        if (await isOwnerAlive(head.ownerTabId)) return;
        ownedJob = await adoptJob(head);
      }

      let runtime = runtimeJobs.get(ownedJob.id);
      if (!runtime) {
        await createCarrierForJob(ownedJob);
        return;
      }

      await withExecutionLock(async () => {
        const freshState = await loadState();
        const freshJob = await getJob(ownedJob.id);
        if (freshState.paused || !freshState.settings.queueEnabled || !freshJob || !['queued', 'retry_wait'].includes(freshJob.status)) return;
        runtime = runtimeJobs.get(freshJob.id);
        if (!runtime) return;
        await executeRuntimeJob(freshJob, runtime);
      });
    } catch (error) {
      console.error('[NAI Image Workbench] Scheduler error:', error);
      notify(`队列调度失败：${error.message || error}`, 'error');
      await saveState({ paused: true });
    } finally {
      schedulerRunning = false;
      scheduleRefresh();
      scheduleBatchController();
    }
  }

  function kickScheduler() {
    if (kickTimer) nativeClearTimeout(kickTimer);
    kickTimer = nativeSetTimeout(() => {
      kickTimer = null;
      void runScheduler();
    }, 50);
  }

  window.fetch = async function queuedFetch(input, init) {
    const url = input instanceof Request ? input.url : input;
    if (!isGenerationUrl(url)) return nativeFetch(input, init);

    const captureSession = consumeCaptureSession();
    if (captureSession) return handleCapturedGenerationFetch(input, init, captureSession);

    if (currentExecution?.awaitingSiteRetry) {
      try {
        const prepared = await prepareFetchCall(input, init);
        const fingerprint = await requestFingerprint(prepared);
        if (fingerprint === currentExecution.fingerprint) {
          return handleSiteInternalRetry(input, init, currentExecution);
        }
      } catch {
        // Fall through to direct tracking; the page will surface request errors itself.
      }
    }

    return trackDirectGeneration(input, init);
  };

  function activeQueueCount() {
    return cachedJobs.filter((job) => ['queued', 'running', 'retry_wait'].includes(job.status)).length;
  }

  function shouldCaptureGenerateClick() {
    return cachedState.settings.queueEnabled && !cachedState.paused
      && (Boolean(cachedBusy) || activeQueueCount() > 0 || pendingSnapshotCaptures.length > 0);
  }

  function updateGenerateClickOverlay() {
    if (!shadow) return;
    const overlay = shadow.querySelector('.generate-hitbox');
    const button = findGenerateButton();
    rememberIdleJotaiAtoms(button);
    const shouldCover = Boolean(button) && cachedState.settings.queueEnabled
      && (Boolean(cachedBusy) || (!cachedState.paused && (activeQueueCount() > 0 || pendingSnapshotCaptures.length > 0)));
    if (!shouldCover) {
      overlay.hidden = true;
      return;
    }

    const rect = button.getBoundingClientRect();
    const visible = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0
      && rect.top < window.innerHeight && rect.left < window.innerWidth;
    overlay.hidden = !visible;
    if (!visible) return;
    overlay.style.left = `${rect.left}px`;
    overlay.style.top = `${rect.top}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
    overlay.dataset.paused = cachedState.paused ? 'true' : 'false';
    overlay.dataset.mode = shouldCaptureGenerateClick() ? 'queue' : 'blocked';
    overlay.textContent = shouldCaptureGenerateClick() ? '加入队列' : '';
    overlay.title = cachedState.paused
      ? '队列已暂停；当前生成结束前不能直接生成'
      : '点击会把当前配置加入 NAI Image Workbench 队列';
  }

  async function waitForCaptureSession(session, timeoutMs = 15_000) {
    const startedAt = now();
    while (now() - startedAt < timeoutMs) {
      if (session.consumed) return true;
      await new Promise((resolve) => nativeSetTimeout(resolve, 50));
    }
    return false;
  }

  async function onGenerateOverlayClick(event) {
    const target = findGenerateButton();
    if (!target) return;
    const busy = Boolean(cachedBusy);
    if (cachedState.paused) {
      if (busy) {
        event.preventDefault();
        event.stopImmediatePropagation();
        notify('队列已暂停，但当前仍在生成；为避免 429，本次点击未发送。', 'error');
      }
      return;
    }
    if (!shouldCaptureGenerateClick()) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    const busyRelease = temporarilyReleaseNovelAIBusy(target);
    if (!busyRelease) {
      notify('无法唯一定位 NovelAI 的生成锁，队列已暂停。', 'error');
      void saveState({ paused: true }).then(scheduleRefresh);
      return;
    }
    const preparedCallback = prepareCurrentGenerationCallback(target, busyRelease);
    if (!preparedCallback) {
      notify('无法调用 NovelAI 当前生成回调，队列已暂停。', 'error');
      void saveState({ paused: true }).then(scheduleRefresh);
      return;
    }
    const invocation = await (snapshotProbeChain = snapshotProbeChain
      .catch(() => undefined)
      .then(() => captureGenerationInvocation(preparedCallback, busyRelease)));
    if (!invocation) {
      notify('无法完整读取当前配置，队列已暂停。', 'error');
      void saveState({ paused: true }).then(scheduleRefresh);
      return;
    }
    const options = invocation.args[0] || {};
    const pending = {
      id: crypto.randomUUID(),
      createdAt: now(),
      invocation,
      busyAccess: busyRelease,
      costText: target.innerText,
      wantsGrid: preparedCallback.wantsGrid,
      promptPreview: truncate(options.prompt || '(正在读取 Prompt)', 80),
      model: String(options.model || '未知模型'),
      width: Number(options.params?.width) || null,
      height: Number(options.params?.height) || null,
      imageCount: Number(options.params?.n_samples) || 1,
      imageFlags: [
        options.initImage ? { label: 'I2I', count: 1 } : null,
        options.referenceImages?.length ? { label: 'Vibe/参考', count: options.referenceImages.length } : null,
        options.characterReferences?.length ? { label: '角色参考', count: options.characterReferences.length } : null,
      ].filter(Boolean),
    };
    pendingSnapshotCaptures.push(pending);
    const session = createCaptureSession('enqueue', {
      costText: target.innerText,
      activation: invocation.activate,
    });
    scheduleRefresh();
    updateGenerateClickOverlay();
    try {
      const returned = invocation.originalMethod.apply(invocation.thisArg, invocation.args);
      const validationPassed = await Promise.race([
        session.capturePromise,
        returned && typeof returned.then === 'function'
          ? Promise.resolve(returned).then(() => false, () => false)
          : Promise.resolve(false),
      ]);
      if (!validationPassed) {
        discardCaptureSession(session);
        notify('NovelAI 未通过当前参数校验，本次未加入队列。', 'info');
      }
    } catch (error) {
      discardCaptureSession(session);
      notify(`NovelAI 参数校验未完成：${error.message || error}`, 'error');
    } finally {
      pending.cancelled = true;
      const pendingIndex = pendingSnapshotCaptures.indexOf(pending);
      if (pendingIndex >= 0) pendingSnapshotCaptures.splice(pendingIndex, 1);
      scheduleRefresh();
      updateGenerateClickOverlay();
    }
  }

  async function captureCurrentBatchPlan() {
    const target = findGenerateButton();
    await refreshBusyCache();
    if (!target || target.disabled || cachedBusy) throw new Error('NovelAI 当前仍在生成，请等待任务结束。');
    rememberIdleJotaiAtoms(target);
    const busyRelease = temporarilyReleaseNovelAIBusy(target);
    if (!busyRelease) throw new Error('无法唯一定位 NovelAI 的生成锁。');
    const preparedCallback = prepareCurrentGenerationCallback(target, busyRelease);
    if (!preparedCallback) throw new Error('无法读取 NovelAI 当前生成配置。');
    const invocation = await (snapshotProbeChain = snapshotProbeChain
      .catch(() => undefined)
      .then(() => captureGenerationInvocation(preparedCallback, busyRelease)));
    if (!invocation) throw new Error('无法捕获 NovelAI 当前完整配置。');
    const options = invocation.args[0] || {};
    const templatePrompt = String(options.prompt || readNativeBasePrompt());
    const inspected = inspectPromptTemplate(templatePrompt);
    if (!inspected.valid) throw new Error(inspected.error);
    return {
      invocation,
      busyAccess: busyRelease,
      wantsGrid: preparedCallback.wantsGrid,
      costText: target.innerText,
      templatePrompt,
      variableName: inspected.variableName,
      model: String(options.model || '未知模型'),
      width: Number(options.params?.width) || null,
      height: Number(options.params?.height) || null,
      imageCount: Number(options.params?.n_samples) || 1,
      fixedSeed: readNativeFixedSeed(),
    };
  }

  async function dispatchBatchRuntimePlan(plan, batch, current, sessionType = 'batch-start') {
    const prompt = replacePromptTemplate(batch.templatePrompt, batch.variableName, current.value);
    const jobId = current.jobId || crypto.randomUUID();
    const session = createCaptureSession(sessionType, {
      batchId: batch.id,
      batchItemId: current.id,
      jobId,
      costText: plan.costText,
    });
    try {
      plan.invocation.activate();
      const args = [...plan.invocation.args];
      args[0] = { ...(args[0] || {}), prompt };
      const returned = plan.invocation.originalMethod.apply(plan.invocation.thisArg, args);
      if (returned && typeof returned.catch === 'function') {
        returned.catch((error) => console.error('[NAI Image Workbench] Batch generation dispatch failed:', error));
      }
      if (!(await waitForCaptureSession(session))) throw new Error('没有捕获到批量生成请求。');
    } catch (error) {
      const index = captureSessions.indexOf(session);
      if (index >= 0) captureSessions.splice(index, 1);
      nativeClearTimeout(session.cleanupTimer);
      throw error;
    }
  }

  async function startBatchMode() {
    const textarea = shadow?.querySelector('.batch-items');
    const items = parseBatchItemsText(textarea?.value || '');
    if (!items.length) {
      notify('批量替换列表为空。', 'error');
      return;
    }
    if (items.length > MAX_BATCH_ITEMS) {
      notify(`批量替换最多允许 ${MAX_BATCH_ITEMS} 项。`, 'error');
      return;
    }
    cachedJobs = await getAllJobs();
    await refreshBusyCache();
    if (cachedBusy || activeQueueCount() || pendingSnapshotCaptures.some((item) => !item.cancelled)) {
      notify('请先等待普通队列和当前生成全部结束，再启动批量替换。', 'error');
      return;
    }
    const state = await loadState();
    if (!state.settings.queueEnabled) {
      notify('请先在设置中启用等待队列。', 'error');
      return;
    }
    if (state.paused) {
      notify('等待队列目前未启用，请点击面板顶部“队列启用”。', 'error');
      return;
    }
    try {
      const plan = await captureCurrentBatchPlan();
      const adjacentDuplicates = findAdjacentDuplicateBatchItems(items);
      if (plan.fixedSeed !== null && adjacentDuplicates.length) {
        const duplicatePreview = adjacentDuplicates.slice(0, 5)
          .map((item) => `第 ${item.first}、${item.second} 项：${truncate(item.value, 48)}`)
          .join('\n');
        const remaining = adjacentDuplicates.length > 5
          ? `\n另有 ${adjacentDuplicates.length - 5} 处相邻重复。`
          : '';
        const shouldContinue = window.confirm(
          `当前使用固定 Seed ${plan.fixedSeed}，替换列表中存在相邻且完全相同的提示词段：\n\n`
          + `${duplicatePreview}${remaining}\n\n`
          + '后一项可能被 NovelAI 判定为与上次参数相同。\n\n'
          + '选择“确定”继续执行；选择“取消”返回修改列表。',
        );
        if (!shouldContinue) {
          notify('已取消启动批量替换，请修改相邻重复项后再试。', 'info');
          return;
        }
      }
      const id = crypto.randomUUID();
      const current = {
        id: crypto.randomUUID(),
        value: items[0],
        jobId: crypto.randomUUID(),
        prompt: replacePromptTemplate(plan.templatePrompt, plan.variableName, items[0]),
        status: 'capturing',
      };
      const batch = normalizeBatchState({
        ...defaultBatchState(),
        id,
        status: 'capturing',
        templatePrompt: plan.templatePrompt,
        variableName: plan.variableName,
        items: items.slice(1),
        current,
        total: items.length,
        configCapturedAt: now(),
        updatedAt: now(),
      });
      batchRuntimePlan = { ...plan, batchId: id };
      await saveState({ activeTab: 'batch', batch });
      scheduleRefresh();
      await dispatchBatchRuntimePlan(batchRuntimePlan, batch, current, 'batch-start');
    } catch (error) {
      const latest = await loadState();
      if (latest.batch.status === 'capturing') {
        await saveState({
          batch: normalizeBatchState({
            ...latest.batch,
            status: 'failed',
            error: error.message || String(error),
            current: latest.batch.current ? { ...latest.batch.current, status: 'failed' } : null,
            updatedAt: now(),
          }),
        });
      }
      notify(`无法启动批量替换：${error.message || error}`, 'error');
      scheduleRefresh();
    }
  }

  async function recaptureBatchConfig() {
    const state = await loadState();
    const batch = normalizeBatchState(state.batch);
    if (batch.current) {
      notify('请先让当前项结束，或跳过失败项，再重新读取配置。', 'error');
      return;
    }
    if (!['idle', 'paused', 'stopped', 'completed'].includes(batch.status)) {
      notify('只有暂停或停止时才能重新读取配置。', 'error');
      return;
    }
    try {
      const plan = await captureCurrentBatchPlan();
      const id = batch.id || crypto.randomUUID();
      batchRuntimePlan = { ...plan, batchId: id };
      await saveState({
        batch: normalizeBatchState({
          ...batch,
          id,
          templatePrompt: plan.templatePrompt,
          variableName: plan.variableName,
          pendingTemplateRefresh: true,
          configCapturedAt: now(),
          error: null,
          updatedAt: now(),
        }),
      });
      notify('已重新读取当前完整配置；下一项将使用新配置。', 'success');
      scheduleRefresh();
    } catch (error) {
      notify(`无法重新读取配置：${error.message || error}`, 'error');
    }
  }

  function statusLabel(job) {
    if (job.status === 'queued') return '等待中';
    if (job.status === 'running') return '生成中';
    if (job.status === 'retry_wait') {
      const seconds = Math.max(0, Math.ceil((Number(job.retryAt || 0) - now()) / 1_000));
      return `重试 ${job.queueRetry}/${cachedState.settings.maxRetries} · ${seconds}s`;
    }
    if (job.status === 'success') return '成功';
    if (job.status === 'unknown') return '结果未知';
    if (job.status === 'failed') return '失败';
    if (job.status === 'deleted_pending') return '等待删除';
    return job.status;
  }

  function statusClass(job) {
    if (job.status === 'success') return 'success';
    if (job.status === 'failed' || job.status === 'unknown') return 'error';
    if (job.status === 'running') return 'running';
    if (job.status === 'retry_wait') return 'retry';
    return 'queued';
  }

  function formatMeta(job) {
    const parts = [job.model];
    if (job.width && job.height) parts.push(`${job.width}×${job.height}`);
    if (job.imageCount) parts.push(`${job.imageCount} 张`);
    if (job.capturedPrice !== null && job.capturedPrice !== undefined) parts.push(`${job.capturedPrice} Anlas`);
    return parts.filter(Boolean).join(' · ');
  }

  function renderJob(job) {
    const card = document.createElement('article');
    card.className = `job ${statusClass(job)}`;
    card.dataset.jobId = job.id;

    const top = document.createElement('div');
    top.className = 'job-top';
    const status = document.createElement('span');
    status.className = 'status';
    status.textContent = statusLabel(job);
    const time = document.createElement('time');
    time.textContent = new Date(job.endedAt || job.createdAt).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    top.append(status, time);

    const prompt = document.createElement('div');
    prompt.className = 'prompt';
    prompt.textContent = job.promptPreview || '(空 Prompt)';
    prompt.title = job.promptPreview || '';

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = formatMeta(job);

    const badges = document.createElement('div');
    badges.className = 'badges';
    if (job.batchId) {
      const modeBadge = document.createElement('span');
      modeBadge.textContent = '特殊替换';
      const valueBadge = document.createElement('span');
      valueBadge.textContent = `${job.batchVariable || '变量'}: ${truncate(job.batchValue, 32)}`;
      badges.append(modeBadge, valueBadge);
    }
    for (const flag of job.imageFlags || []) {
      const badge = document.createElement('span');
      badge.textContent = flag.count > 1 ? `${flag.label} ×${flag.count}` : flag.label;
      badges.append(badge);
    }

    if (job.error) {
      const error = document.createElement('div');
      error.className = 'job-error';
      error.textContent = job.error;
      error.title = job.error;
      card.append(top, prompt, meta, badges, error);
    } else {
      card.append(top, prompt, meta, badges);
    }

    const actions = document.createElement('div');
    actions.className = 'actions';
    if (['success', 'failed', 'unknown'].includes(job.status)) {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = '重新入队';
      retry.addEventListener('click', () => void cloneFinishedJob(job.id));
      actions.append(retry);
    }
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'danger';
    remove.textContent = '删除';
    remove.addEventListener('click', () => void softDeleteJob(job.id));
    actions.append(remove);
    card.append(actions);
    return card;
  }

  function renderPendingSnapshot(pending) {
    const card = document.createElement('article');
    card.className = 'job queued';
    const top = document.createElement('div');
    top.className = 'job-top';
    const status = document.createElement('span');
    status.className = 'status';
    status.textContent = '等待 NovelAI 校验';
    const time = document.createElement('time');
    time.textContent = new Date(pending.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    top.append(status, time);
    const prompt = document.createElement('div');
    prompt.className = 'prompt';
    prompt.textContent = pending.promptPreview;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = [
      pending.model,
      pending.width && pending.height ? `${pending.width}×${pending.height}` : null,
      `${pending.imageCount} 张`,
    ].filter(Boolean).join(' · ');
    const badges = document.createElement('div');
    badges.className = 'badges';
    for (const flag of pending.imageFlags) {
      const badge = document.createElement('span');
      badge.textContent = `${flag.label} ×${flag.count}`;
      badges.append(badge);
    }
    const actions = document.createElement('div');
    actions.className = 'job-actions';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'danger';
    remove.textContent = '删除';
    remove.addEventListener('click', () => {
      pending.cancelled = true;
      const index = pendingSnapshotCaptures.indexOf(pending);
      if (index >= 0) pendingSnapshotCaptures.splice(index, 1);
      scheduleRefresh();
      updateGenerateClickOverlay();
    });
    actions.append(remove);
    card.append(top, prompt, meta, badges, actions);
    return card;
  }

  function notify(message, type = 'info', action = null) {
    if (!shadow) {
      console[type === 'error' ? 'error' : 'log'](`[NAI Image Workbench] ${message}`);
      return;
    }
    if (cachedState.settings.toastPosition === 'off') return;
    const stack = shadow.querySelector('.toast-stack');
    if (!stack) return;
    stack.dataset.position = cachedState.settings.toastPosition;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.tabIndex = 0;
    toast.setAttribute('role', 'button');
    toast.setAttribute('aria-label', `${message}；点击关闭`);
    const text = document.createElement('span');
    text.textContent = message;
    toast.append(text);
    if (action) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = action.label;
      button.addEventListener('click', () => {
        action.onClick();
        toast.remove();
      });
      toast.append(button);
    }
    const dismiss = (event) => {
      if (event.type === 'click' && event.target.closest('button')) return;
      if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      toast.remove();
    };
    toast.addEventListener('click', dismiss);
    toast.addEventListener('keydown', dismiss);
    stack.append(toast);
    nativeSetTimeout(() => toast.remove(), action ? 5_000 : cachedState.settings.toastDurationMs);
  }

  async function preserveBatchUnitAfterJobRemoval(job, message = '对应队列任务已被删除。') {
    if (!job?.batchId || !job.batchItemId) return;
    const state = await loadState();
    const batch = normalizeBatchState(state.batch);
    if (batch.id !== job.batchId || batch.current?.id !== job.batchItemId) return;
    await saveState({
      batch: normalizeBatchState({
        ...batch,
        status: 'failed',
        current: { ...batch.current, jobId: null, status: 'failed' },
        error: message,
        discardCurrentRecord: false,
        updatedAt: now(),
      }),
    });
  }

  async function softDeleteJob(id) {
    const job = await getJob(id);
    if (!job) return;
    if (job.status === 'running') {
      await saveState({ paused: true });
      if (currentExecution?.jobId === id) {
        for (const controller of currentExecution.controllers) controller.abort(new Error('Task deleted by user.'));
      }
      const runtime = runtimeJobs.get(id);
      if (runtime?.deferred && !runtime.deferred.settled) {
        runtime.deferred.settled = true;
        runtime.deferred.reject(new Error('Queue task deleted by user.'));
      }
      runtimeJobs.delete(id);
      await deleteJobRecord(id);
      await endBusy(id);
      await preserveBatchUnitAfterJobRemoval(job, '正在生成的特殊任务记录已删除；该单位仍被保留。');
      notify('正在生成的队列记录已删除，队列已暂停。服务端请求可能仍会完成。', 'error');
      void garbageCollectBlobs();
      return;
    }

    const previousStatus = job.status;
    await updateJob(id, (current) => ({ ...current, status: 'deleted_pending', deletedFromStatus: previousStatus, updatedAt: now() }));
    const timer = nativeSetTimeout(async () => {
      pendingDeleteTimers.delete(id);
      const runtime = runtimeJobs.get(id);
      if (runtime?.deferred && !runtime.deferred.settled) {
        runtime.deferred.settled = true;
        runtime.deferred.reject(new Error('Queue task deleted by user.'));
      }
      runtimeJobs.delete(id);
      await deleteJobRecord(id);
      await preserveBatchUnitAfterJobRemoval(job);
      void garbageCollectBlobs();
      kickScheduler();
    }, 5_000);
    pendingDeleteTimers.set(id, timer);
    notify('任务已删除。', 'info', {
      label: '撤销',
      onClick: () => void undoDeleteJob(id),
    });
  }

  async function undoDeleteJob(id) {
    const timer = pendingDeleteTimers.get(id);
    if (timer) nativeClearTimeout(timer);
    pendingDeleteTimers.delete(id);
    await updateJob(id, (job) => ({
      ...job,
      status: job.deletedFromStatus || 'queued',
      deletedFromStatus: null,
      updatedAt: now(),
    }));
    notify('已恢复任务。', 'success');
    kickScheduler();
  }

  async function cloneFinishedJob(id) {
    const source = await getJob(id);
    if (!source) return;
    const clone = {
      ...source,
      id: crypto.randomUUID(),
      createdAt: now(),
      updatedAt: now(),
      endedAt: null,
      status: 'queued',
      ownerTabId: null,
      queueRetry: 0,
      siteAttempts: 0,
      retryAt: null,
      error: null,
      source: 'requeued',
      batchId: null,
      batchItemId: null,
      batchVariable: null,
      batchValue: null,
      batchPrompt: null,
    };
    await putJob(clone);
    notify('已复制到队列末尾。', 'success');
    kickScheduler();
  }

  async function clearJobs(kind) {
    const label = kind === 'queue' ? '队列中的全部任务' : '全部已结束记录';
    if (!window.confirm(`确定删除${label}吗？此操作无法撤销。`)) return;
    if (kind === 'queue') {
      await saveState({ paused: true });
      for (const pending of pendingSnapshotCaptures) pending.cancelled = true;
      pendingSnapshotCaptures.splice(0);
    }
    const jobs = await getAllJobs();
    const targets = jobs.filter((job) => kind === 'queue'
      ? ['queued', 'running', 'retry_wait', 'deleted_pending'].includes(job.status)
      : ['success', 'failed', 'unknown'].includes(job.status));
    for (const job of targets) {
      if (currentExecution?.jobId === job.id) {
        for (const controller of currentExecution.controllers) controller.abort(new Error('Queue cleared by user.'));
      }
      const runtime = runtimeJobs.get(job.id);
      if (runtime?.deferred && !runtime.deferred.settled) {
        runtime.deferred.settled = true;
        runtime.deferred.reject(new Error('Queue task deleted by user.'));
      }
      runtimeJobs.delete(job.id);
      await deleteJobRecord(job.id, { broadcast: false });
      await preserveBatchUnitAfterJobRemoval(job, '普通队列被清空；特殊模式当前单位仍被保留。');
    }
    await endBusy();
    notifyPeers('jobs-changed');
    scheduleRefresh();
    void garbageCollectBlobs();
  }

  function isQueueControlEnabled(state = cachedState) {
    return Boolean(state?.settings?.queueEnabled) && !state?.paused;
  }

  async function setQueueControlEnabled(enabled, { showNotice = true } = {}) {
    const state = await loadState();
    const settings = normalizeQueueSettings({ ...state.settings, queueEnabled: Boolean(enabled) });
    await saveState({ settings, paused: false });
    if (showNotice) {
      notify(enabled
        ? '等待队列已启用。'
        : '等待队列已禁用。当前任务不会被取消，现有任务会保留。', enabled ? 'success' : 'info');
    }
    scheduleRefresh();
    if (enabled) {
      kickScheduler();
    }
  }

  async function toggleQueueControl() {
    const state = await loadState();
    await setQueueControlEnabled(!isQueueControlEnabled(state));
  }

  async function saveBatchItemsFromTextarea() {
    if (!shadow) return;
    const state = await loadState();
    const batch = normalizeBatchState(state.batch);
    if (batch.status === 'running' || batch.status === 'capturing') return;
    const items = parseBatchItemsText(shadow.querySelector('.batch-items').value);
    if (items.length > MAX_BATCH_ITEMS) {
      notify(`批量替换最多允许 ${MAX_BATCH_ITEMS} 项。`, 'error');
      return;
    }
    await saveState({
      batch: normalizeBatchState({
        ...batch,
        items,
        total: batch.completed + (batch.current ? 1 : 0) + items.length,
        updatedAt: now(),
      }),
    });
    scheduleRefresh();
  }

  async function toggleBatchPaused() {
    const state = await loadState();
    const batch = normalizeBatchState(state.batch);
    if (batch.status === 'running' || batch.status === 'capturing') {
      await saveState({ batch: normalizeBatchState({ ...batch, status: 'paused', updatedAt: now() }) });
      notify('批量替换已暂停；当前请求仍会正常完成。', 'info');
      scheduleRefresh();
      return;
    }
    if (batch.status !== 'paused') return;
    if (batch.pendingTemplateRefresh && (!batchRuntimePlan || batchRuntimePlan.batchId !== batch.id)) {
      notify('请先点击“重新读取配置”，再继续批量替换。', 'error');
      return;
    }
    await saveState({ paused: false, batch: normalizeBatchState({ ...batch, status: 'running', error: null, updatedAt: now() }) });
    notify('批量替换已继续。', 'success');
    scheduleRefresh();
    scheduleBatchController();
  }

  async function stopBatchMode() {
    const state = await loadState();
    const batch = normalizeBatchState(state.batch);
    if (['idle', 'stopped', 'completed'].includes(batch.status)) return;
    const returnFailedCurrent = batch.status === 'failed' && batch.current;
    await saveState({
      batch: normalizeBatchState({
        ...batch,
        status: 'stopped',
        items: returnFailedCurrent ? [batch.current.value, ...batch.items] : batch.items,
        current: returnFailedCurrent ? null : batch.current,
        error: null,
        updatedAt: now(),
      }),
    });
    notify(returnFailedCurrent
      ? '批量替换已停止；失败单位已放回剩余列表首行。'
      : batch.current ? '批量替换将在当前项结束后停止。' : '批量替换已停止；剩余列表已保留。', 'info');
    scheduleRefresh();
  }

  async function clearBatchRemaining() {
    const state = await loadState();
    const batch = normalizeBatchState(state.batch);
    if (!batch.items.length) return;
    if (!window.confirm('确定清空全部剩余替换单位吗？当前项和已结束记录不会删除。')) return;
    await saveState({
      batch: normalizeBatchState({
        ...batch,
        items: [],
        total: batch.completed + (batch.current ? 1 : 0),
        updatedAt: now(),
      }),
    });
    scheduleRefresh();
  }

  async function retryBatchCurrent() {
    const state = await loadState();
    const batch = normalizeBatchState(state.batch);
    if (batch.status !== 'failed' || !batch.current) return;
    cachedJobs = await getAllJobs();
    await refreshBusyCache();
    if (cachedBusy || queueJobs(cachedJobs).some((job) => !['failed', 'unknown', 'success'].includes(job.status))) {
      notify('请先等待当前生成和普通队列结束。', 'error');
      return;
    }
    const current = { ...batch.current, jobId: crypto.randomUUID(), status: 'queued' };
    const nextBatch = normalizeBatchState({ ...batch, status: 'running', current, error: null, updatedAt: now() });
    try {
      const job = await createBatchJobFromTemplate(nextBatch, current);
      await saveState({ paused: false, batch: nextBatch });
      await putJob(job);
      notify('失败单位已重新提交。', 'success');
      kickScheduler();
    } catch (error) {
      notify(`无法重试当前项：${error.message || error}`, 'error');
    }
  }

  async function skipBatchCurrent() {
    const state = await loadState();
    const batch = normalizeBatchState(state.batch);
    if (!batch.current || batch.status !== 'failed') return;
    await saveState({
      batch: normalizeBatchState({
        ...batch,
        status: 'paused',
        current: null,
        error: null,
        updatedAt: now(),
      }),
    });
    notify('失败单位已跳过并从待处理列表移除。', 'info');
    scheduleRefresh();
  }

  async function discardRunningBatchCurrent() {
    const state = await loadState();
    const batch = normalizeBatchState(state.batch);
    if (!batch.current || !['running', 'capturing', 'paused'].includes(batch.status)) return;
    await saveState({
      batch: normalizeBatchState({
        ...batch,
        status: 'stopped',
        discardCurrentRecord: true,
        updatedAt: now(),
      }),
    });
    notify('当前请求不会被取消；完成后将删除工具盒记录并停止批量模式。', 'info');
    scheduleRefresh();
  }

  function fillSettingsForm(settings = cachedState.settings, queueEnabled = isQueueControlEnabled(cachedState)) {
    if (!shadow) return;
    const form = shadow.querySelector('.settings-form');
    form.elements.queueEnabled.checked = queueEnabled;
    form.elements.maxRetries.value = String(settings.maxRetries);
    form.elements.interJobDelaySeconds.value = String(settings.interJobDelayMs / 1_000);
    form.elements.maxFinished.value = String(settings.maxFinished);
    form.elements.toastDurationSeconds.value = String(settings.toastDurationMs / 1_000);
    form.elements.toastPosition.value = settings.toastPosition;
    form.elements.historySaveIndicator.checked = settings.historySaveIndicator;
  }

  function openSettings() {
    fillSettingsForm();
    const dialog = shadow.querySelector('.settings-dialog');
    dialog.hidden = false;
    if (cachedState.settingsPosition?.left && cachedState.settingsPosition?.top) {
      dialog.style.left = cachedState.settingsPosition.left;
      dialog.style.top = cachedState.settingsPosition.top;
      dialog.style.right = 'auto';
      return;
    }
    const panelRect = shadow.querySelector('.panel').getBoundingClientRect();
    const width = dialog.offsetWidth;
    const gap = 10;
    const preferredLeft = panelRect.left - width - gap;
    const left = preferredLeft >= 4
      ? preferredLeft
      : Math.min(window.innerWidth - width - 4, panelRect.right + gap);
    const top = Math.max(4, Math.min(window.innerHeight - dialog.offsetHeight - 4, panelRect.top));
    dialog.style.left = `${Math.max(4, left)}px`;
    dialog.style.top = `${top}px`;
    dialog.style.right = 'auto';
  }

  function closeSettings() {
    shadow.querySelector('.settings-dialog').hidden = true;
  }

  async function saveSettingsFromForm(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const settings = normalizeQueueSettings({
      queueEnabled: form.elements.queueEnabled.checked,
      maxRetries: form.elements.maxRetries.value,
      interJobDelayMs: Number(form.elements.interJobDelaySeconds.value) * 1_000,
      maxFinished: form.elements.maxFinished.value,
      toastDurationMs: Number(form.elements.toastDurationSeconds.value) * 1_000,
      toastPosition: form.elements.toastPosition.value,
      historySaveIndicator: form.elements.historySaveIndicator.checked,
    });
    await saveState({ settings, paused: false });
    await trimFinishedJobs();
    closeSettings();
    notify(settings.queueEnabled ? '设置已保存，等待队列已启用。' : '设置已保存，等待队列已禁用。现有任务会保留。', 'success');
    scheduleRefresh();
    scheduleHistorySaveIndicatorUpdate();
    if (settings.queueEnabled) {
      kickScheduler();
    }
  }

  function buildUi() {
    if (document.getElementById('nai-image-workbench-host')) return;
    uiHost = document.createElement('div');
    uiHost.id = 'nai-image-workbench-host';
    shadow = uiHost.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; }
        .panel { position: fixed; top: 112px; right: 16px; z-index: 2147483000; width: 380px; max-width: calc(100vw - 24px); max-height: min(72vh, 760px); display: flex; flex-direction: column; color: #fff; background: #141936; border: 1px solid #343a63; border-radius: 10px; box-shadow: 0 14px 42px rgba(0,0,0,.45); font: 14px/1.4 "Source Sans Pro", system-ui, sans-serif; overflow: hidden; }
        .panel.collapsed .body, .panel.collapsed .tabs { display: none; }
        .header { display: flex; align-items: center; gap: 8px; padding: 9px 10px; background: #191b31; border-bottom: 1px solid #343a63; cursor: move; user-select: none; }
        .title { min-width: 0; flex: 1; font: 600 15px/1.2 Eczar, system-ui, sans-serif; color: #f5f3c2; }
        button { border: 1px solid #41486f; border-radius: 6px; padding: 5px 9px; color: #fff; background: #22253f; font: 600 12px/1.25 system-ui, sans-serif; cursor: pointer; }
        button:hover { border-color: #777fae; background: #2c3153; }
        button.danger { color: #ffc5c5; border-color: #744a57; }
        button.primary { color: #141936; background: #f5f3c2; border-color: #f5f3c2; }
        .tabs { display: grid; grid-template-columns: 1fr 1fr 1.15fr; gap: 6px; padding: 8px 10px 0; }
        .tabs button span { margin-left: 9px; }
        .tabs button.active { color: #f5f3c2; border-color: #8e926e; background: #30334a; }
        .body { min-height: 140px; overflow: auto; padding: 8px 10px 10px; }
        .view[hidden] { display: none; }
        .toolbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
        .summary { color: #b8bddc; font-size: 12px; }
        .list { display: flex; flex-direction: column; gap: 8px; }
        .empty { padding: 28px 10px; color: #989fca; text-align: center; border: 1px dashed #3a406a; border-radius: 8px; }
        .job { padding: 9px; border: 1px solid #363d66; border-left: 3px solid #777fae; border-radius: 8px; background: #191d3a; }
        .job.running { border-left-color: #7ed0ff; }
        .job.retry { border-left-color: #f1c56f; }
        .job.success { border-left-color: #74d99f; }
        .job.error { border-left-color: #ff7d8e; }
        .job-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
        .status { color: #f5f3c2; font-size: 12px; font-weight: 700; }
        time { color: #858db9; font-size: 11px; }
        .prompt { margin-top: 6px; color: #fff; font-size: 13px; overflow-wrap: anywhere; }
        .meta { margin-top: 5px; color: #a9afd1; font-size: 11px; }
        .badges { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
        .badges:empty { display: none; }
        .badges span { padding: 2px 6px; color: #d8dcff; background: #2a315a; border-radius: 999px; font-size: 10px; }
        .job-error { margin-top: 6px; color: #ffb6bf; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: 8px; }
        .batch-view { display: flex; flex-direction: column; gap: 9px; }
        .batch-box { padding: 9px; color: #dce0ff; background: #191d3a; border: 1px solid #363d66; border-radius: 8px; }
        .batch-box strong { color: #f5f3c2; }
        .batch-box small { display: block; margin-top: 4px; color: #969dc7; }
        .batch-current { border-left: 3px solid #7ed0ff; overflow-wrap: anywhere; }
        .batch-current.failed { border-left-color: #ff7d8e; }
        .batch-items-label { display: flex; align-items: center; justify-content: space-between; color: #c5cae9; font-size: 12px; }
        .batch-items { width: 100%; min-height: 164px; resize: vertical; padding: 8px 9px; color: #fff; background: #0f1430; border: 1px solid #41486f; border-radius: 7px; font: 13px/1.45 ui-monospace, Consolas, monospace; }
        .batch-items:disabled { color: #9299c0; opacity: .72; }
        .batch-validation { color: #aeb5da; font-size: 12px; overflow-wrap: anywhere; }
        .batch-validation.error { color: #ffabb7; }
        .batch-preview { margin: 5px 0 0; padding-left: 18px; color: #bfc5e8; font-size: 11px; }
        .batch-preview li { margin: 2px 0; overflow-wrap: anywhere; }
        .batch-controls { display: flex; flex-wrap: wrap; gap: 6px; }
        .batch-controls button { flex: 1 1 auto; }
        .batch-error { color: #ffb6bf; border-color: #784252; }
        .toast-stack { position: fixed; right: 18px; bottom: 18px; z-index: 2147483640; display: flex; flex-direction: column; gap: 8px; width: min(360px, calc(100vw - 32px)); pointer-events: none; }
        .toast-stack[data-position="top-right"] { top: 18px; bottom: auto; }
        .toast { display: flex; align-items: center; gap: 8px; padding: 9px 11px; color: #fff; background: #22253f; border: 1px solid #4a527e; border-radius: 8px; box-shadow: 0 8px 26px rgba(0,0,0,.4); pointer-events: auto; cursor: pointer; }
        .toast span { flex: 1; }
        .toast.error { border-color: #a94e61; }
        .toast.success { border-color: #4c9f71; }
        .settings-dialog { position: fixed; top: 112px; right: 16px; z-index: 2147483200; width: 380px; max-width: calc(100vw - 24px); max-height: calc(100vh - 24px); color: #fff; background: #141936; border: 1px solid #4b5487; border-radius: 10px; box-shadow: 0 18px 52px rgba(0,0,0,.58); font: 13px/1.4 system-ui, sans-serif; overflow: hidden; }
        .settings-dialog[hidden] { display: none; }
        .settings-title { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; color: #f5f3c2; background: #191b31; border-bottom: 1px solid #343a63; font-size: 15px; font-weight: 700; cursor: move; user-select: none; }
        .settings-form { max-height: calc(100vh - 78px); overflow-y: auto; padding: 10px 12px 12px; }
        .setting-group { min-width: 0; margin: 0 0 10px; padding: 3px 10px 2px; border: 1px solid rgba(74,82,126,.7); border-radius: 8px; }
        .setting-group legend { padding: 0 6px; color: #f5f3c2; font-size: 12px; font-weight: 700; }
        .setting-group:last-of-type { margin-bottom: 0; }
        .setting-row { display: grid; grid-template-columns: minmax(0, 1fr) 112px; align-items: center; gap: 12px; padding: 8px 0; border-bottom: 1px solid rgba(74,82,126,.45); }
        .setting-row:last-of-type { border-bottom: 0; }
        .setting-row small { display: block; margin-top: 2px; color: #979fc9; font-size: 11px; }
        .setting-row input[type="number"], .setting-row select { width: 100%; padding: 6px 7px; color: #fff; background: #0f1430; border: 1px solid #41486f; border-radius: 6px; }
        .setting-row input[type="checkbox"] { justify-self: end; width: 19px; height: 19px; accent-color: #1687df; }
        .settings-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-top: 12px; }
        .settings-credit { color: #858db8; font-size: 10px; letter-spacing: .02em; white-space: nowrap; }
        .settings-actions { display: flex; justify-content: flex-end; gap: 7px; }
        .generate-hitbox { position: fixed; z-index: 2147482500; display: block; margin: 0; padding: 0; border: 0; border-radius: 3px; color: #fff; background: transparent !important; box-shadow: none; cursor: pointer; font: 700 15px/1 system-ui, sans-serif; }
        .generate-hitbox[data-mode="queue"] { border: 1px solid rgb(143, 149, 218); background: rgb(112, 119, 194) !important; box-shadow: 0 0 0 1px rgba(255,255,255,.08) inset, 0 5px 16px rgba(72,78,150,.38); }
        .generate-hitbox[data-mode="queue"]:hover { background: rgb(126, 133, 207) !important; border-color: rgb(170, 175, 231); }
        .generate-hitbox[data-paused="true"] { cursor: not-allowed; }
        .generate-hitbox[hidden] { display: none; }
        @media (max-width: 700px) { .panel { top: 72px; right: 8px; width: calc(100vw - 16px); max-height: 64vh; } }
      </style>
      <section class="panel" aria-label="NAI Image Workbench 队列">
        <header class="header">
          <div class="title">NAI Image Workbench</div>
          <button class="queue-toggle primary" type="button" title="控制等待队列；与设置中的“启用等待队列”是同一个开关">队列禁用</button>
          <button class="settings" type="button">设置</button>
          <button class="collapse" type="button" aria-label="折叠">—</button>
        </header>
        <nav class="tabs">
          <button type="button" data-tab="queue">队列<span class="queue-count">0</span></button>
          <button type="button" data-tab="finished">已结束<span class="finished-count">0</span></button>
          <button type="button" data-tab="batch">批量替换<span class="batch-count">0</span></button>
        </nav>
        <div class="body">
          <div class="queue-view view">
            <div class="toolbar">
              <span class="summary"></span>
              <button class="clear danger" type="button">全部删除</button>
            </div>
            <div class="list"></div>
          </div>
          <div class="batch-view view" hidden>
            <div class="batch-box batch-template"></div>
            <div class="batch-box batch-current" hidden></div>
            <div class="batch-box batch-error" hidden></div>
            <label class="batch-items-label"><span>剩余替换单位（每行一个）</span><span class="batch-item-count">0/500</span></label>
            <textarea class="batch-items" spellcheck="false" placeholder="taromarun&#10;piromizu&#10;xilmo&#10;kamo_kamen&#10;sharpffffff"></textarea>
            <div class="batch-validation"></div>
            <ol class="batch-preview"></ol>
            <div class="batch-controls batch-main-controls">
              <button class="batch-start primary" type="button">开始特殊生成</button>
              <button class="batch-pause" type="button">暂停</button>
              <button class="batch-stop" type="button">停止</button>
            </div>
            <div class="batch-controls">
              <button class="batch-recapture" type="button">重新读取配置</button>
              <button class="batch-clear danger" type="button">清空剩余</button>
            </div>
            <div class="batch-controls batch-failure-controls" hidden>
              <button class="batch-retry primary" type="button">重试当前项</button>
              <button class="batch-skip danger" type="button">跳过并删除当前项</button>
            </div>
            <div class="batch-controls batch-running-controls" hidden>
              <button class="batch-discard danger" type="button">完成后丢弃记录并停止</button>
            </div>
          </div>
        </div>
      </section>
      <section class="settings-dialog" role="dialog" aria-modal="true" aria-label="设置" hidden>
        <div class="settings-title"><span>设置</span><button class="settings-close" type="button" aria-label="关闭设置">×</button></div>
        <form class="settings-form">
          <fieldset class="setting-group">
            <legend>队列设置</legend>
            <label class="setting-row" title="与面板顶部的“队列启用 / 队列禁用”按钮功能相同；修改后立即生效"><span>启用等待队列<small>与外部按钮功能相同；关闭后不接管 Generate，也不派发后续任务</small></span><input name="queueEnabled" type="checkbox"></label>
            <label class="setting-row"><span>自动重试次数<small>只用于 429 与连接失败，范围 0–3</small></span><input name="maxRetries" type="number" min="0" max="3" step="1"></label>
            <label class="setting-row"><span>任务间隔（秒）<small>前一任务完成后再等待，范围 0.5–10</small></span><input name="interJobDelaySeconds" type="number" min="0.5" max="10" step="0.5"></label>
            <label class="setting-row"><span>已结束记录上限<small>超出后自动删除最旧记录，范围 10–100</small></span><input name="maxFinished" type="number" min="10" max="100" step="1"></label>
          </fieldset>
          <fieldset class="setting-group">
            <legend>使用体验</legend>
            <label class="setting-row"><span>提示位置<small>可放在右上角、右下角，或完全关闭</small></span><select name="toastPosition"><option value="top-right">右上角</option><option value="bottom-right">右下角</option><option value="off">关闭</option></select></label>
            <label class="setting-row"><span>普通提示停留（秒）<small>点击提示仍可立即关闭，范围 1–30</small></span><input name="toastDurationSeconds" type="number" min="1" max="30" step="1"></label>
            <label class="setting-row"><span>History 保存状态标识<small>缩略图右下角：已保存为绿色，未保存及生成中为红色</small></span><input name="historySaveIndicator" type="checkbox"></label>
          </fieldset>
          <div class="settings-footer">
            <small class="settings-credit">by KaerMorh</small>
            <div class="settings-actions">
              <button class="settings-reset" type="button">恢复默认</button>
              <button class="settings-cancel" type="button">取消</button>
              <button class="primary" type="submit">保存</button>
            </div>
          </div>
        </form>
      </section>
      <button class="generate-hitbox" type="button" aria-label="把当前 NovelAI 配置加入队列" hidden></button>
      <div class="toast-stack" aria-live="polite"></div>
    `;
    document.documentElement.append(uiHost);

    shadow.querySelector('.queue-toggle').addEventListener('click', () => void toggleQueueControl());
    shadow.querySelector('.settings').addEventListener('click', openSettings);
    shadow.querySelector('.settings-close').addEventListener('click', closeSettings);
    shadow.querySelector('.settings-cancel').addEventListener('click', closeSettings);
    shadow.querySelector('.settings-reset').addEventListener('click', () => fillSettingsForm(defaultState().settings, true));
    shadow.querySelector('input[name="queueEnabled"]').addEventListener('change', (event) => {
      const enabled = event.currentTarget.checked;
      void setQueueControlEnabled(enabled);
    });
    shadow.querySelector('.settings-form').addEventListener('submit', (event) => void saveSettingsFromForm(event));
    shadow.querySelector('.collapse').addEventListener('click', async () => {
      await saveState({ collapsed: !cachedState.collapsed });
      scheduleRefresh();
    });
    shadow.querySelectorAll('[data-tab]').forEach((button) => {
      button.addEventListener('click', async () => {
        await saveState({ activeTab: button.dataset.tab });
        scheduleRefresh();
      });
    });
    shadow.querySelector('.clear').addEventListener('click', () => void clearJobs(cachedState.activeTab === 'finished' ? 'finished' : 'queue'));
    shadow.querySelector('.batch-items').addEventListener('input', () => {
      if (batchEditTimer) nativeClearTimeout(batchEditTimer);
      batchEditTimer = nativeSetTimeout(() => {
        batchEditTimer = null;
        void saveBatchItemsFromTextarea();
      }, 300);
      renderBatchUi(cachedState.batch);
    });
    shadow.querySelector('.batch-start').addEventListener('click', () => void startBatchMode());
    shadow.querySelector('.batch-pause').addEventListener('click', () => void toggleBatchPaused());
    shadow.querySelector('.batch-stop').addEventListener('click', () => void stopBatchMode());
    shadow.querySelector('.batch-recapture').addEventListener('click', () => void recaptureBatchConfig());
    shadow.querySelector('.batch-clear').addEventListener('click', () => void clearBatchRemaining());
    shadow.querySelector('.batch-retry').addEventListener('click', () => void retryBatchCurrent());
    shadow.querySelector('.batch-skip').addEventListener('click', () => void skipBatchCurrent());
    shadow.querySelector('.batch-discard').addEventListener('click', () => void discardRunningBatchCurrent());
    shadow.querySelector('.generate-hitbox').addEventListener('click', onGenerateOverlayClick);
    installDragging();
  }

  function installDragging() {
    const panel = shadow.querySelector('.panel');
    const header = shadow.querySelector('.header');
    let drag = null;
    header.addEventListener('pointerdown', (event) => {
      if (event.target.closest('button')) return;
      const rect = panel.getBoundingClientRect();
      drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
      header.setPointerCapture(event.pointerId);
    });
    header.addEventListener('pointermove', (event) => {
      if (!drag) return;
      const left = Math.max(4, Math.min(window.innerWidth - panel.offsetWidth - 4, event.clientX - drag.dx));
      const top = Math.max(4, Math.min(window.innerHeight - 52, event.clientY - drag.dy));
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
      panel.style.right = 'auto';
    });
    header.addEventListener('pointerup', async (event) => {
      if (!drag) return;
      drag = null;
      header.releasePointerCapture(event.pointerId);
      await saveState({ position: { left: panel.style.left, top: panel.style.top } });
    });

    const settingsDialog = shadow.querySelector('.settings-dialog');
    const settingsHeader = shadow.querySelector('.settings-title');
    let settingsDrag = null;
    settingsHeader.addEventListener('pointerdown', (event) => {
      if (event.target.closest('button')) return;
      const rect = settingsDialog.getBoundingClientRect();
      settingsDrag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
      settingsHeader.setPointerCapture(event.pointerId);
    });
    settingsHeader.addEventListener('pointermove', (event) => {
      if (!settingsDrag) return;
      const left = Math.max(4, Math.min(window.innerWidth - settingsDialog.offsetWidth - 4, event.clientX - settingsDrag.dx));
      const top = Math.max(4, Math.min(window.innerHeight - 52, event.clientY - settingsDrag.dy));
      settingsDialog.style.left = `${left}px`;
      settingsDialog.style.top = `${top}px`;
      settingsDialog.style.right = 'auto';
    });
    settingsHeader.addEventListener('pointerup', async (event) => {
      if (!settingsDrag) return;
      settingsDrag = null;
      settingsHeader.releasePointerCapture(event.pointerId);
      await saveState({ settingsPosition: { left: settingsDialog.style.left, top: settingsDialog.style.top } });
    });
  }

  function batchStatusLabel(status) {
    return {
      idle: '未启动',
      capturing: '正在读取并提交配置',
      running: '运行中',
      paused: '已暂停',
      stopped: '已停止',
      failed: '失败并暂停',
      completed: '已完成',
    }[status] || status;
  }

  function renderBatchUi(value = cachedState.batch) {
    if (!shadow) return;
    const batch = normalizeBatchState(value);
    const textarea = shadow.querySelector('.batch-items');
    const editable = !['running', 'capturing'].includes(batch.status);
    textarea.disabled = !editable;
    if (shadow.activeElement !== textarea) textarea.value = batch.items.join('\n');
    const visibleItems = parseBatchItemsText(textarea.value);
    shadow.querySelector('.batch-item-count').textContent = `${visibleItems.length}/${MAX_BATCH_ITEMS}`;

    const usesFrozenTemplate = Boolean(batch.templatePrompt)
      && ['capturing', 'running', 'paused', 'failed'].includes(batch.status);
    const templatePrompt = usesFrozenTemplate ? batch.templatePrompt : readNativeBasePrompt();
    const inspected = inspectPromptTemplate(templatePrompt);
    const templateBox = shadow.querySelector('.batch-template');
    templateBox.replaceChildren();
    const templateTitle = document.createElement('strong');
    templateTitle.textContent = `状态：${batchStatusLabel(batch.status)} · 完成 ${batch.completed}/${batch.total || visibleItems.length}`;
    const templateText = document.createElement('small');
    templateText.textContent = inspected.valid
      ? `变量 {{${inspected.variableName}}}，出现 ${inspected.count} 次 · ${truncate(templatePrompt, 120)}`
      : inspected.error;
    templateBox.append(templateTitle, templateText);

    const currentBox = shadow.querySelector('.batch-current');
    currentBox.hidden = !batch.current;
    currentBox.classList.toggle('failed', batch.status === 'failed');
    if (batch.current) {
      const liveJob = cachedJobs.find((job) => job.id === batch.current.jobId);
      currentBox.textContent = `当前项：${batch.current.value} · ${liveJob ? statusLabel(liveJob) : batch.current.status}`;
      const prompt = document.createElement('small');
      prompt.textContent = truncate(batch.current.prompt || '', 140);
      currentBox.append(prompt);
    }
    const errorBox = shadow.querySelector('.batch-error');
    errorBox.hidden = !batch.error;
    errorBox.textContent = batch.error || '';

    const validation = shadow.querySelector('.batch-validation');
    const tooMany = visibleItems.length > MAX_BATCH_ITEMS;
    const validationError = tooMany ? `列表超过 ${MAX_BATCH_ITEMS} 项。` : inspected.error;
    validation.textContent = validationError || `将按顺序处理 ${visibleItems.length} 个剩余单位；每次成功后删除一行。`;
    validation.classList.toggle('error', Boolean(validationError));
    const preview = shadow.querySelector('.batch-preview');
    preview.replaceChildren();
    if (inspected.valid) {
      for (const item of visibleItems.slice(0, 3)) {
        const row = document.createElement('li');
        row.textContent = truncate(replacePromptTemplate(templatePrompt, inspected.variableName, item), 130);
        preview.append(row);
      }
    }

    const start = shadow.querySelector('.batch-start');
    start.disabled = !editable || Boolean(batch.current) || !visibleItems.length || Boolean(validationError)
      || !['idle', 'stopped', 'completed'].includes(batch.status);
    const pause = shadow.querySelector('.batch-pause');
    pause.textContent = batch.status === 'paused' ? '继续' : '暂停';
    pause.disabled = !['running', 'capturing', 'paused'].includes(batch.status);
    shadow.querySelector('.batch-stop').disabled = !['running', 'capturing', 'paused', 'failed'].includes(batch.status);
    shadow.querySelector('.batch-recapture').disabled = Boolean(batch.current)
      || !['idle', 'paused', 'stopped', 'completed'].includes(batch.status);
    shadow.querySelector('.batch-clear').disabled = !editable || !visibleItems.length;
    shadow.querySelector('.batch-failure-controls').hidden = batch.status !== 'failed' || !batch.current;
    shadow.querySelector('.batch-running-controls').hidden = !batch.current
      || !['running', 'capturing', 'paused'].includes(batch.status);
  }

  async function refreshUi() {
    cachedState = await loadState();
    cachedJobs = await getAllJobs();
    await refreshBusyCache();
    if (!shadow) return;
    const toastStack = shadow.querySelector('.toast-stack');
    toastStack.dataset.position = cachedState.settings.toastPosition;
    if (cachedState.settings.toastPosition === 'off') toastStack.replaceChildren();
    const panel = shadow.querySelector('.panel');
    panel.classList.toggle('collapsed', Boolean(cachedState.collapsed));
    if (cachedState.position?.left && cachedState.position?.top) {
      panel.style.left = cachedState.position.left;
      panel.style.top = cachedState.position.top;
      panel.style.right = 'auto';
    }
    const settingsDialog = shadow.querySelector('.settings-dialog');
    if (cachedState.settingsPosition?.left && cachedState.settingsPosition?.top) {
      settingsDialog.style.left = cachedState.settingsPosition.left;
      settingsDialog.style.top = cachedState.settingsPosition.top;
      settingsDialog.style.right = 'auto';
    }
    const queueControlEnabled = isQueueControlEnabled(cachedState);
    const queueControl = shadow.querySelector('.queue-toggle');
    queueControl.textContent = queueControlEnabled ? '队列禁用' : '队列启用';
    queueControl.classList.toggle('primary', !queueControlEnabled);
    queueControl.title = queueControlEnabled
      ? '点击禁用等待队列；与设置中的“启用等待队列”是同一个开关'
      : '点击启用等待队列；与设置中的“启用等待队列”是同一个开关';
    const queueEnabledInput = shadow.querySelector('input[name="queueEnabled"]');
    if (queueEnabledInput) queueEnabledInput.checked = queueControlEnabled;
    shadow.querySelector('.collapse').textContent = cachedState.collapsed ? '+' : '—';

    const queued = queueJobs(cachedJobs).filter((job) => job.status !== 'deleted_pending');
    const finished = cachedJobs
      .filter((job) => ['success', 'failed', 'unknown'].includes(job.status))
      .sort((a, b) => Number(b.endedAt || 0) - Number(a.endedAt || 0));
    const pendingSnapshots = pendingSnapshotCaptures.filter((pending) => !pending.cancelled);
    const queueTotal = queued.length + pendingSnapshots.length;
    shadow.querySelector('.queue-count').textContent = String(queueTotal);
    shadow.querySelector('.finished-count').textContent = String(finished.length);
    shadow.querySelector('.batch-count').textContent = String(cachedState.batch.items.length + (cachedState.batch.current ? 1 : 0));
    shadow.querySelectorAll('[data-tab]').forEach((button) => button.classList.toggle('active', button.dataset.tab === cachedState.activeTab));

    shadow.querySelector('.queue-view').hidden = cachedState.activeTab === 'batch';
    shadow.querySelector('.batch-view').hidden = cachedState.activeTab !== 'batch';
    renderBatchUi(cachedState.batch);

    const shown = cachedState.activeTab === 'finished' ? finished : [...pendingSnapshots, ...queued];
    shadow.querySelector('.summary').textContent = cachedState.activeTab === 'finished'
      ? `保留 ${finished.length}/${cachedState.settings.maxFinished}`
      : !queueControlEnabled
        ? `队列已禁用 · ${queueTotal} 项保留`
        : `运行中 · ${queueTotal} 项`;
    const list = shadow.querySelector('.list');
    list.replaceChildren();
    if (!shown.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = cachedState.activeTab === 'finished' ? '还没有已结束的队列任务' : '生成过程中再次点击 Generate 即可入队';
      list.append(empty);
    } else {
      for (const job of shown) {
        list.append(pendingSnapshots.includes(job) ? renderPendingSnapshot(job) : renderJob(job));
      }
    }
    updateGenerateClickOverlay();
    scheduleHistorySaveIndicatorUpdate();
  }

  function scheduleRefresh() {
    if (refreshTimer) nativeClearTimeout(refreshTimer);
    refreshTimer = nativeSetTimeout(() => {
      refreshTimer = null;
      void refreshUi();
    }, 40);
  }

  async function initialize() {
    await openDatabase();
    await markTabHeartbeat(false);
    cachedState = await loadState();
    cachedJobs = await getAllJobs();
    if (['capturing', 'running'].includes(cachedState.batch.status)) {
      const recoveredJob = cachedState.batch.current?.jobId
        ? cachedJobs.find((job) => job.id === cachedState.batch.current.jobId)
        : null;
      cachedState = await saveState({
        paused: true,
        batch: normalizeBatchState({
          ...cachedState.batch,
          status: recoveredJob ? 'paused' : 'failed',
          error: recoveredJob
            ? '页面曾重新载入；为避免重复生成，批量替换需要手动确认后继续。'
            : '页面在捕获当前项时重新载入；该单位已保留，但需要重试或跳过。',
          current: cachedState.batch.current
            ? { ...cachedState.batch.current, status: recoveredJob ? 'paused' : 'failed' }
            : null,
          updatedAt: now(),
        }),
      });
    }
    await refreshBusyCache();
    buildUi();
    await refreshUi();

    const observer = new MutationObserver(() => {
      updateGenerateClickOverlay();
      scheduleHistorySaveIndicatorUpdate();
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['disabled', 'aria-disabled', 'class', 'style'],
    });
    window.addEventListener('resize', updateGenerateClickOverlay, { passive: true });
    window.addEventListener('scroll', updateGenerateClickOverlay, { passive: true, capture: true });
    window.addEventListener('resize', scheduleHistorySaveIndicatorUpdate, { passive: true });
    document.addEventListener('pointerdown', deferHistoryIndicatorDuringInteraction, { passive: true, capture: true });
    document.addEventListener('click', deferHistoryIndicatorDuringInteraction, { passive: true, capture: true });

    nativeSetInterval(() => {
      void markTabHeartbeat(false);
      scheduleRefresh();
      kickScheduler();
      scheduleBatchController();
    }, 2_000);

    channel?.addEventListener('message', (event) => {
      if (event.data?.from === TAB_ID) return;
      scheduleRefresh();
      if (event.data?.type === 'kick' || event.data?.type === 'jobs-changed' || event.data?.type === 'meta-changed') kickScheduler();
      scheduleBatchController();
    });

    window.addEventListener('pagehide', () => {
      void markTabHeartbeat(true);
    });

    notify(`NAI Image Workbench 已就绪 · v${SCRIPT_VERSION}`, 'success');
    kickScheduler();
    scheduleBatchController();
  }

  const start = () => void initialize().catch((error) => {
    console.error('[NAI Image Workbench] Initialization failed:', error);
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
