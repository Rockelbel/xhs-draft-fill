/**
 * Popup 主逻辑：
 *  1. 选 / 恢复 redbook 根目录
 *  2. 列出所有子文件夹（按名字倒序，最新在上）
 *  3. 点击某个文件夹 → 读取 post.txt + pic*.png → 注入到当前 XHS 发布页
 */
(async function () {
  const { saveRootHandle, loadRootHandle, clearRootHandle } = window.RBDDb;
  const { parsePost } = window.RBDParser;

  const PUBLISH_URL = 'https://creator.xiaohongshu.com/publish/publish';
  const PUBLISH_MATCH = /^https?:\/\/creator\.xiaohongshu\.com\/publish/;

  const rootLabel = document.getElementById('rootLabel');
  const pickRootBtn = document.getElementById('pickRootBtn');
  const openPublishBtn = document.getElementById('openPublishBtn');
  const grantBtn = document.getElementById('grantBtn');
  const refreshBtn = document.getElementById('refreshBtn');
  const folderList = document.getElementById('folderList');
  const emptyHint = document.getElementById('emptyHint');
  const statusEl = document.getElementById('status');

  let rootHandle = null;

  function setStatus(msg, kind = '') {
    statusEl.textContent = msg;
    statusEl.className = 'status' + (kind ? ' ' + kind : '');
  }

  // 仅查询，不请求（无需用户手势）
  async function queryReadPermission(handle) {
    return await handle.queryPermission({ mode: 'read' });
  }

  // 请求权限（必须在用户点击回调里调用）
  async function requestReadPermission(handle) {
    return await handle.requestPermission({ mode: 'read' });
  }

  async function pickRoot() {
    try {
      const handle = await window.showDirectoryPicker({ id: 'redbook-root', mode: 'read' });
      await saveRootHandle(handle);
      rootHandle = handle;
      rootLabel.textContent = handle.name;
      await renderFolders();
      setStatus('已选择根目录', 'success');
    } catch (e) {
      if (e.name !== 'AbortError') setStatus('选目录失败：' + e.message, 'error');
    }
  }

  async function tryRestoreRoot() {
    const handle = await loadRootHandle();
    if (!handle) return false;
    rootHandle = handle;
    rootLabel.textContent = handle.name;
    // 不在这里自动 requestPermission（必须有 user gesture），渲染时再问
    return true;
  }

  async function renderFolders() {
    if (!rootHandle) {
      emptyHint.style.display = 'block';
      emptyHint.textContent = '点击「选目录」选择 redbook 根目录';
      folderList.innerHTML = '';
      grantBtn.style.display = 'none';
      return;
    }

    const perm = await queryReadPermission(rootHandle);
    if (perm !== 'granted') {
      // 不能在这里自动 request（缺少 user gesture）
      // 显示授权按钮，等用户点
      grantBtn.style.display = 'block';
      grantBtn.textContent = `授权访问「${rootHandle.name}」目录`;
      emptyHint.style.display = 'block';
      emptyHint.textContent = '点上方橙色按钮授权一次即可';
      folderList.innerHTML = '';
      return;
    }

    grantBtn.style.display = 'none';
    folderList.innerHTML = '';
    emptyHint.style.display = 'none';

    const folders = [];
    for await (const [name, h] of rootHandle.entries()) {
      if (h.kind === 'directory' && !name.startsWith('.')) folders.push(name);
    }
    folders.sort().reverse(); // 名字按 YYMMDD_ 前缀倒序，最新在上

    if (folders.length === 0) {
      emptyHint.textContent = '该目录下没有子文件夹';
      emptyHint.style.display = 'block';
      return;
    }

    for (const name of folders) {
      const li = document.createElement('li');
      li.className = 'folder-item';
      li.innerHTML = `
        <div>
          <div class="folder-name">${name}</div>
          <div class="folder-meta" data-meta="${name}">点击填入</div>
        </div>
        <button class="btn-sm">填入</button>
      `;
      li.addEventListener('click', () => fillFromFolder(name, li));
      folderList.appendChild(li);
    }
  }

  async function readFolderPayload(folderName) {
    const dirHandle = await rootHandle.getDirectoryHandle(folderName);
    // 1. post.txt
    let postText;
    try {
      const f = await (await dirHandle.getFileHandle('post.txt')).getFile();
      postText = await f.text();
    } catch (e) {
      throw new Error('缺少 post.txt');
    }
    const parsed = parsePost(postText);

    // 2. pic*.png 按序
    const pics = [];
    for await (const [name, h] of dirHandle.entries()) {
      if (h.kind === 'file' && /^pic\d+\.png$/i.test(name)) {
        const idx = parseInt(name.match(/(\d+)/)[1], 10);
        pics.push({ idx, name, handle: h });
      }
    }
    pics.sort((a, b) => a.idx - b.idx);
    if (pics.length === 0) throw new Error('没有 pic*.png');

    const imageBlobs = [];
    for (const p of pics) {
      const file = await p.handle.getFile();
      const ab = await file.arrayBuffer();
      imageBlobs.push({
        name: p.name,
        type: file.type || 'image/png',
        base64: arrayBufferToBase64(ab)
      });
    }

    return { ...parsed, images: imageBlobs };
  }

  function arrayBufferToBase64(buf) {
    let bin = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  async function getActivePublishTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && PUBLISH_MATCH.test(tab.url || '')) return tab;
    return null;
  }

  async function fillFromFolder(name, liEl) {
    setStatus(`读取 ${name}...`);
    let payload;
    try {
      payload = await readFolderPayload(name);
    } catch (e) {
      setStatus(`❌ ${name}: ${e.message}`, 'error');
      return;
    }

    const tab = await getActivePublishTab();
    if (!tab) {
      setStatus('当前标签不是发布页，先点上方按钮打开', 'error');
      return;
    }

    setStatus(`注入 ${name}...`);
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        files: ['injected/fill.js']
      });
      const [ret] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: (p) => window.__rbdFill(p),
        args: [payload]
      });
      if (ret?.result?.ok) {
        const note = payload.titleShortened ? ` (标题缩短: ${payload.originalTitle} → ${payload.title})` : '';
        setStatus(`✅ 已填入「${payload.title}」${note}`, 'success');
      } else {
        setStatus(`⚠️ 注入但部分字段未匹配：${ret?.result?.message || '未知'}`, 'error');
      }
    } catch (e) {
      setStatus(`❌ 注入失败：${e.message}`, 'error');
    }
  }

  async function openPublish() {
    const tab = await getActivePublishTab();
    if (tab) {
      setStatus('当前已经在发布页', 'success');
      return;
    }
    await chrome.tabs.create({ url: PUBLISH_URL });
    window.close();
  }

  async function grantAccess() {
    if (!rootHandle) {
      setStatus('请先选目录', 'error');
      return;
    }
    try {
      const result = await requestReadPermission(rootHandle);
      if (result === 'granted') {
        setStatus('已授权', 'success');
        await renderFolders();
      } else {
        setStatus('授权被拒绝', 'error');
      }
    } catch (e) {
      setStatus('授权失败：' + e.message, 'error');
    }
  }

  // ── 事件绑定 ──
  pickRootBtn.addEventListener('click', pickRoot);
  openPublishBtn.addEventListener('click', openPublish);
  refreshBtn.addEventListener('click', renderFolders);
  grantBtn.addEventListener('click', grantAccess);

  // 初始化
  if (await tryRestoreRoot()) {
    setStatus('点击列表项填入草稿');
    await renderFolders();
  } else {
    setStatus('请先选择 redbook 根目录');
  }
})();
