// ==UserScript==
// @name         NovelAI Chunks → Private GitHub
// @namespace    https://novelai.net/local-tools/chunks-sync/
// @version      1.3.0
// @description  打开 NovelAI 图像页时，把 Prompt Chunks 的变化备份到指定的 GitHub 私有仓库。
// @match        https://novelai.net/*
// @run-at       document-idle
// @noframes
// @sandbox      DOM
// @grant        unsafeWindow
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @connect      api.github.com
// ==/UserScript==

(() => {
  'use strict';
  const path = 'novelai/prompt-chunks.json';
  const format = 'novelai-chunks-github-v1';
  const onImagePage = () => /^\/image(?:\/|$)/.test(location.pathname);
  let lastStatus = '准备就绪';
  let panel;
  let running = false;
  let revision = 0;

  // Read only the macro array subscribed to by the image page, not account/session objects.
  function snapshot(records) {
    if (!Array.isArray(records) || records.length === 0) return null;
    const ids = new Set();
    const rows = [];
    for (const item of records) {
      if (!item || typeof item.id !== 'string' || ids.has(item.id)) return null;
      if (!item.isCategory && !Array.isArray(item.categoryOrder) &&
          (typeof item.label !== 'string' || typeof item.expansion !== 'string')) return null;
      ids.add(item.id);
      const row = { id: item.id };
      for (const k of ['label', 'expansion', 'color', 'isCategory', 'childOrder', 'categoryOrder']) {
        if (item[k] != null) row[k] = item[k];
      }
      rows.push(row);
    }
    for (const row of rows) {
      for (const refs of [row.childOrder, row.categoryOrder]) {
        if (refs != null && (!Array.isArray(refs) || refs.some(id => !ids.has(id)))) return null;
      }
    }
    return JSON.stringify({ format, records: rows }, null, 2) + '\n';
  }

  function readChunks() {
    const doc = unsafeWindow.document;
    const anchors = [doc.querySelector('#promptChunkContainer [draggable]'), doc.querySelector('button.image-gen-generate-button')];
    for (const node of anchors.filter(Boolean)) {
      const key = Object.keys(node).find(k => k.startsWith('__reactFiber$'));
      for (let fiber = node[key]; fiber; fiber = fiber.return) {
        for (let hook = fiber.memoizedState; hook; hook = hook.next) {
          const tuple = hook.memoizedState;
          if (!Array.isArray(tuple) || typeof tuple[1]?.get !== 'function' || !tuple[2]) continue;
          if (!Array.isArray(tuple[0]) && tuple[0] != null) continue;
          const json = snapshot(tuple[1].get(tuple[2]));
          if (json) return json;
        }
      }
    }
    return null;
  }

  function github(config, method, endpoint, body) {
    return new Promise((resolve, reject) => GM_xmlhttpRequest({
      method, url: 'https://api.github.com' + (config.repo ? '/repos/' + config.repo : '') + endpoint,
      anonymous: true, redirect: 'error', timeout: 20000,
      headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + config.token,
        ...(body ? { 'Content-Type': 'application/json' } : {}) },
      data: body ? JSON.stringify(body) : undefined,
      onload: res => {
        if (res.status === 401) {
          // Keep only an allowlisted response identifier, never the credential or raw response.
          const requestId = res.responseHeaders?.match(/^x-github-request-id:\s*([a-z0-9:-]+)\s*$/im)?.[1];
          reject(Object.assign(new Error('GitHub 请求认证失败（HTTP 401）。令牌已保留。'), { status: 401, requestId }));
          return;
        }
        try { resolve({ status: res.status, data: JSON.parse(res.responseText) }); }
        catch { reject(new Error('GitHub 返回的不是 JSON。')); }
      },
      onerror: () => reject(new Error('无法连接 GitHub，请检查网络和油猴的域名权限。')),
      ontimeout: () => reject(new Error('连接 GitHub 超时。')),
    }));
  }

  function encode(text) {
    return btoa(Array.from(new TextEncoder().encode(text), byte => String.fromCharCode(byte)).join(''));
  }

  async function sync(config, json, active) {
    const endpoint = '/contents/' + path;
    // Omitting ref/branch uses the repository's default branch.
    const file = await github(config, 'GET', endpoint);
    let sha;
    const content = encode(json);
    if (file.status === 200) {
      if (file.data.type !== 'file' || file.data.encoding !== 'base64' || !file.data.sha) throw new Error('目标不是可读取的备份文件。');
      const old = file.data.content.replace(/\s/g, '');
      if (old === content) return '已核对远端文件，内容一致。';
      let previous;
      try { previous = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(old), c => c.charCodeAt(0)))); } catch {}
      if (previous?.format !== format) throw new Error('目标路径已存在其他文件，不会覆盖。');
      sha = file.data.sha;
    } else if (file.status !== 404) throw new Error('读取备份失败：HTTP ' + file.status);
    if (!active()) return '同步已取消。';
    const result = await github(config, 'PUT', endpoint, {
      message: 'Back up NovelAI prompt chunks', content, ...(sha ? { sha } : {}),
    });
    if (result.status === 404) throw new Error('无法写入 ' + config.repo + '（HTTP 404）。请核对仓库名称及当前令牌对该仓库的访问权限。令牌已保留。');
    if (![200, 201].includes(result.status)) throw new Error('写入失败：HTTP ' + result.status + '。请检查令牌权限、分支保护或稍后重试。');
    return '已同步到 ' + config.repo + '/' + path;
  }

  async function run() {
    const saved = GM_getValue('config', null);
    if (!saved || running || !onImagePage()) return;
    const config = { repo: saved.repo, token: GM_getValue('githubToken', '').trim() };
    if (!config.token) {
      lastStatus = '同步已暂停。请点「设置」，填写有效的 GitHub 令牌并保存。'; return;
    }
    if (!config.token || !/^[a-z\d-]+\/[a-z\d_.-]+$/i.test(config.repo) || /\/(?:\.|\.\.)$/.test(config.repo)) {
      lastStatus = '仓库或令牌无效，请重新配置。'; return;
    }
    const ticket = revision;
    const active = () => ticket === revision && onImagePage() && GM_getValue('config', null)?.repo === config.repo;
    running = true;
    try {
      lastStatus = '正在读取 Chunks；若长时间等待，请打开原生 Prompt Chunks 面板。';
      for (let i = 0; i < 120 && active(); i++) {
        const json = readChunks();
        if (json) {
          lastStatus = '已读取 Chunks，正在核对 GitHub 仓库和备份文件…';
          const result = await sync(config, json, active);
          if (active()) {
            lastStatus = result;
            GM_setValue('lastVerified', { repo: config.repo, time: new Date().toLocaleString(), result });
          }
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      if (active()) throw new Error('未读取到完整的非空 Chunks。登录并加载图像页后可通过菜单重试。');
    } catch (error) {
      if (!active()) return;
      lastStatus = error.message;
      if (error.status === 401) {
        lastStatus = '仓库请求返回 401，正在自动检查同一令牌的用户认证…';
        try {
          const user = await github({ token: config.token }, 'GET', '/user');
          if (!active()) return;
          lastStatus = user.status === 200 && user.data.login
            ? '同一令牌的用户认证成功，但仓库请求返回 401；问题位于仓库请求或网络处理。令牌已保留。'
            : '仓库请求返回 401；用户认证检查返回 HTTP ' + user.status + '。令牌已保留。';
        } catch (probeError) {
          if (!active()) return;
          lastStatus = probeError.status === 401
            ? '仓库和用户接口均返回 401；' + (probeError.requestId
              ? 'GitHub 响应编号 ' + probeError.requestId
              : '响应缺少 GitHub 请求编号，尚不能确认响应来源') + '。令牌已保留，认证请求仍需排查。'
            : '仓库请求返回 401；自动认证检查失败：' + probeError.message;
        }
      }
      console.warn('[NovelAI Chunks Sync]', lastStatus);
    } finally {
      running = false;
      if (ticket !== revision && onImagePage() && GM_getValue('config', null)) void run();
    }
  }

  function showPanel(configure = false) {
    if (!panel) {
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;top:12px;right:12px;width:max-content;max-width:100vw;z-index:2147483647';
      document.body.append(host);
      panel = host.attachShadow({ mode: 'closed' });
      panel.innerHTML = `<style>:host{font:13px system-ui;color:#edf1ff}section{background:#20233a;border:1px solid #667090;border-radius:8px;padding:10px;max-width:300px}button,input{font:inherit;margin:3px;padding:4px}small,output{display:block;margin-top:4px}input{width:95%}a{color:#b7d2ff}</style>
        <section><strong title="拖动以移动面板" style="display:inline-block;cursor:grab;touch-action:none;user-select:none">⠿ Chunks 同步</strong> <button id="run">立即同步</button><button id="settings">设置</button>
        <output aria-live="polite"></output><small></small><a target="_blank" rel="noopener noreferrer">查看 GitHub 备份</a>
        <form hidden><label>私有仓库<input name="repo" placeholder="owner/repo" required></label>
        <label>GitHub 令牌<input name="token" type="password" autocomplete="off" placeholder="已配置时留空保留"></label><button type="button" id="auth">检查认证</button>
        <button>保存并同步</button></form></section>`;
      const grip = panel.querySelector('strong');
      let drag;
      function place(x, y) {
        host.style.right = 'auto';
        host.style.left = Math.max(0, Math.min(x, innerWidth - host.offsetWidth)) + 'px';
        host.style.top = Math.max(0, Math.min(y, innerHeight - host.offsetHeight)) + 'px';
      }
      const pos = GM_getValue('panelPosition', null);
      if (Number.isFinite(pos?.x) && Number.isFinite(pos?.y)) place(pos.x, pos.y);
      grip.onpointerdown = e => {
        if (e.button !== 0 || drag) return;
        const rect = host.getBoundingClientRect();
        drag = { id: e.pointerId, dx: e.clientX - rect.left, dy: e.clientY - rect.top };
        grip.setPointerCapture(e.pointerId);
      };
      grip.onpointermove = e => {
        if (drag?.id === e.pointerId) place(e.clientX - drag.dx, e.clientY - drag.dy);
      };
      grip.onlostpointercapture = () => {
        drag = null;
        const rect = host.getBoundingClientRect();
        GM_setValue('panelPosition', { x: rect.left, y: rect.top });
      };
      panel.querySelector('#run').onclick = () => GM_getValue('config', null) && GM_getValue('githubToken', '') ? void run() : showPanel(true);
      panel.querySelector('#settings').onclick = () => {
        const form = panel.querySelector('form');
        if (form.hidden) showPanel(true); else { form.hidden = true; form.elements.token.value = ''; }
      };
      panel.querySelector('#auth').onclick = async e => {
        const button = e.currentTarget;
        const token = panel.querySelector('form').elements.token.value.trim() || GM_getValue('githubToken', '').trim();
        if (!token) { lastStatus = '请先填写令牌再检查认证。'; showPanel(); return; }
        button.disabled = true;
        try {
          const result = await github({ token }, 'GET', '/user');
          lastStatus = result.status === 200 && result.data.login
            ? '认证成功：' + result.data.login + '。当前令牌可用；同步失败需继续检查仓库访问。'
            : '认证检查返回 HTTP ' + result.status + '；尚未确认认证成功。';
        } catch (error) {
          lastStatus = error.status === 401
            ? '用户认证接口也返回 401；尚不能确定是令牌还是请求传递问题。令牌已保留。'
            : error.message;
        } finally {
          button.disabled = false;
          showPanel();
        }
      };
      panel.querySelector('form').onsubmit = e => {
        e.preventDefault();
        const form = e.target;
        const repo = form.elements.repo.value.trim();
        const token = form.elements.token.value.trim() || GM_getValue('githubToken', '');
        if (!/^[a-z\d-]+\/[a-z\d_.-]+$/i.test(repo) || /\/(?:\.|\.\.)$/.test(repo) || !token) {
          lastStatus = '请填写有效的 owner/repo 和 GitHub 令牌。'; return;
        }
        revision++;
        GM_setValue('githubToken', token);
        GM_setValue('config', { repo });
        form.elements.token.value = ''; form.hidden = true;
        void run();
      };
    }
    const saved = GM_getValue('config', null);
    if (configure) {
      panel.querySelector('form').hidden = false;
      panel.querySelector('input[name=repo]').value = saved?.repo || '';
    }
    const previous = GM_getValue('lastVerified', null);
    panel.querySelector('output').textContent = !saved && lastStatus === '准备就绪' ? '未配置，点击设置连接私有仓库。' : lastStatus;
    panel.querySelector('small').textContent = previous && previous.repo === saved?.repo
      ? '上次核对成功 ' + previous.time + ' · ' + previous.repo : '尚无成功记录';
    const link = panel.querySelector('a');
    link.hidden = !previous || previous.repo !== saved?.repo;
    if (!link.hidden) link.href = 'https://github.com/' + saved.repo + '/blob/HEAD/' + path;
    panel.querySelector('#run').disabled = running;
    const host = panel.host;
    if (host.style.left) {
      host.style.left = Math.max(0, Math.min(parseFloat(host.style.left), innerWidth - host.offsetWidth)) + 'px';
      host.style.top = Math.max(0, Math.min(parseFloat(host.style.top), innerHeight - host.offsetHeight)) + 'px';
    }
  }
  GM_registerMenuCommand('配置并启用私有仓库同步', () => showPanel(true));
  GM_registerMenuCommand('立即同步', () => { if (!GM_getValue('config', null)) return alert('请先配置私有仓库。'); void run(); });
  GM_registerMenuCommand('查看同步状态', () => alert(lastStatus));
  GM_registerMenuCommand('停用同步并清除令牌', () => {
    revision++; GM_deleteValue('config'); GM_deleteValue('githubToken'); lastStatus = '同步已停用，已清除本机配置。';
  });
  let opened = false;
  function checkRoute() {
    const image = onImagePage();
    if (image && typeof document !== 'undefined' && document.body) showPanel();
    if (!image && panel) { panel.host.remove(); panel = null; }
    if (image && !opened) void run();
    if (!image && opened) revision++;
    opened = image;
  }
  checkRoute();
  setInterval(checkRoute, 1000);
})();

