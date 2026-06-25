/**
 * 注入到 creator.xiaohongshu.com/publish 页面（MAIN world）。
 * 暴露 window.__rbdFill(payload) 给 popup 调用。
 *
 * payload: { title, body, finalBody, tags, images: [{name, type, base64}] }
 *
 * 流程：
 *  1) 切到「上传图文」tab（若未切）
 *  2) 上传图片，等预览出现
 *  3) 填标题
 *  4) 填正文（多策略：Quill API → paste 事件 → execCommand）
 *
 * 全程在 console 打 [rbd-fill] 日志，便于调试。
 */
(function () {
  const log = (...a) => console.log('[rbd-fill]', ...a);

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  async function waitFor(predicate, { timeout = 15000, interval = 200 } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const v = predicate();
      if (v) return v;
      await sleep(interval);
    }
    return null;
  }

  function visibleRect(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    return true;
  }

  function setReactInputValue(input, value) {
    const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function base64ToFile(b64, name, type) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], name, { type: type || 'image/png' });
  }

  // ── 1) Tab 切换：宽松搜索任何含「上传图文」文本的可见可点击元素 ──
  function findImagePostTab() {
    const all = document.querySelectorAll('div, button, span, a, li');
    for (const el of all) {
      const txt = (el.innerText || '').replace(/\s+/g, '');
      if (!txt || !/上传图文/.test(txt)) continue;
      // 取「最里层」匹配（避免点到 wrapper）：如果有子元素也命中，跳过
      const child = Array.from(el.children).find((c) => /上传图文/.test((c.innerText || '').replace(/\s+/g, '')));
      if (child) continue;
      if (visibleRect(el)) return el;
    }
    return null;
  }

  function findImageUploadInput() {
    const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
    // 优先 accept 含 image 类型
    const imgOne = inputs.find((i) => {
      const a = (i.getAttribute('accept') || '').toLowerCase();
      return /jpg|jpeg|png|webp|image\//.test(a);
    });
    if (imgOne) return imgOne;
    // 再试 .upload-input
    return document.querySelector('.upload-input') || inputs[0] || null;
  }

  function imagePreviewCount() {
    const selectors = [
      '.img-preview-area .pr',
      '.img-preview-area img',
      '[class*="preview"] img',
      '.img-list img',
      '[class*="upload"] img'
    ];
    let max = 0;
    for (const sel of selectors) {
      const n = document.querySelectorAll(sel).length;
      if (n > max) max = n;
    }
    return max;
  }

  // ── 标题 ──
  function findTitleInput() {
    const candidates = [
      'div.d-input input',
      'input[placeholder*="标题"]',
      'input[maxlength="20"]'
    ];
    for (const sel of candidates) {
      for (const el of document.querySelectorAll(sel)) {
        if (visibleRect(el)) return el;
      }
    }
    return null;
  }

  // ── 正文（Quill）──
  function findBodyEditor() {
    const candidates = [
      'div.ql-editor[contenteditable="true"]',
      'div.ql-editor',
      '[role="textbox"][contenteditable="true"]',
      '[contenteditable="true"]'
    ];
    for (const sel of candidates) {
      for (const el of document.querySelectorAll(sel)) {
        if (visibleRect(el)) return el;
      }
    }
    return null;
  }

  function getQuillInstance(editor) {
    // 找最近的 .ql-container，Quill 实例可能挂在上面
    const container = editor.closest('.ql-container') || editor.parentElement;
    if (!container) return null;
    // 常见属性
    if (container.__quill) return container.__quill;
    if (container.quill) return container.quill;
    // 通过全局 Quill.find
    if (window.Quill && typeof window.Quill.find === 'function') {
      try {
        const q = window.Quill.find(container);
        if (q) return q;
      } catch {}
    }
    return null;
  }

  // 策略 A：Quill API 直接 setText（最可靠，支持 \n）
  function fillBodyViaQuill(editor, body) {
    const quill = getQuillInstance(editor);
    if (!quill) return false;
    try {
      quill.setText(body);
      log('body filled via Quill API');
      return true;
    } catch (e) {
      log('Quill API failed:', e.message);
      return false;
    }
  }

  // 策略 B：模拟 paste 事件（Quill 监听 paste，会正确处理 \n）
  function fillBodyViaPaste(editor, body) {
    try {
      editor.focus();
      // 清空
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('delete', false);

      const dt = new DataTransfer();
      dt.setData('text/plain', body);
      const ev = new ClipboardEvent('paste', {
        clipboardData: dt,
        bubbles: true,
        cancelable: true
      });
      const dispatched = editor.dispatchEvent(ev);
      log('paste event dispatched:', dispatched, 'editor text length:', editor.innerText.length);
      // 验证是否真的写进去了
      return editor.innerText.replace(/\s+/g, '').length > 0;
    } catch (e) {
      log('paste failed:', e.message);
      return false;
    }
  }

  // 策略 C：execCommand 逐行 + 模拟 Enter keydown 触发 Quill 段落
  function fillBodyViaExecCommand(editor, body) {
    try {
      editor.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('delete', false);

      const lines = body.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]) document.execCommand('insertText', false, lines[i]);
        if (i < lines.length - 1) {
          // Quill 监听 keydown，模拟 Enter
          const evInit = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
          editor.dispatchEvent(new KeyboardEvent('keydown', evInit));
          editor.dispatchEvent(new KeyboardEvent('keypress', evInit));
          editor.dispatchEvent(new KeyboardEvent('keyup', evInit));
          // 兜底用 execCommand insertParagraph
          document.execCommand('insertParagraph', false);
        }
      }
      editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
      log('exec body filled, text len:', editor.innerText.length);
      return true;
    } catch (e) {
      log('execCommand failed:', e.message);
      return false;
    }
  }

  // ── 各步骤 ──
  async function step1_ensureImagePostTab() {
    log('step1: ensure 上传图文 tab');
    // 先查页面上有「上传图文」字样的可点元素；不管 upload input 是否已存在，都尝试点一次确保切到位
    const tab = findImagePostTab();
    if (tab) {
      log('found tab:', tab.tagName, tab.className, 'text:', tab.innerText.slice(0, 20));
      tab.click();
      await sleep(400);
    } else {
      log('no tab element with 上传图文 found; assuming already in image mode');
    }
    // 等 upload input 出现
    const up = await waitFor(findImageUploadInput, { timeout: 10000 });
    if (!up) return { ok: false, reason: 'upload_input_not_ready' };
    await sleep(300);
    return { ok: true, tabClicked: !!tab };
  }

  async function step2_uploadImages(images) {
    if (!images || images.length === 0) return { ok: false, reason: 'no_images' };
    const input = findImageUploadInput();
    if (!input) return { ok: false, reason: 'image_input_not_found' };
    log('step2: upload', images.length, 'images via input', input.className);

    const dt = new DataTransfer();
    for (const img of images) dt.items.add(base64ToFile(img.base64, img.name, img.type));
    try {
      input.files = dt.files;
    } catch (e) {
      return { ok: false, reason: 'set_files_failed', detail: e.message };
    }
    input.dispatchEvent(new Event('change', { bubbles: true }));

    const ok = await waitFor(
      () => imagePreviewCount() >= images.length,
      { timeout: 60000, interval: 500 }
    );
    if (!ok) return { ok: false, reason: 'preview_not_ready', detail: `expected ${images.length}, got ${imagePreviewCount()}` };
    await sleep(1500); // 等编辑器渲染
    return { ok: true, count: images.length };
  }

  async function step3_fillTitle(title) {
    log('step3: fill title');
    const input = await waitFor(findTitleInput, { timeout: 10000 });
    if (!input) return { ok: false, reason: 'title_input_not_found' };
    input.focus();
    setReactInputValue(input, title);
    return { ok: true };
  }

  async function step4_fillBody(body) {
    log('step4: fill body, length:', body.length);
    const editor = await waitFor(findBodyEditor, { timeout: 10000 });
    if (!editor) return { ok: false, reason: 'body_editor_not_found' };

    // 试 A → B → C
    if (fillBodyViaQuill(editor, body)) return { ok: true, method: 'quill' };
    if (fillBodyViaPaste(editor, body)) return { ok: true, method: 'paste' };
    if (fillBodyViaExecCommand(editor, body)) return { ok: true, method: 'exec' };
    return { ok: false, reason: 'body_all_strategies_failed' };
  }

  // ── 主入口 ──
  window.__rbdFill = async function (payload) {
    log('__rbdFill called', { title: payload.title, bodyLen: (payload.finalBody||'').length, imgs: payload.images?.length });
    const result = { ok: true, steps: {} };

    result.steps.tab = await step1_ensureImagePostTab();
    if (!result.steps.tab.ok) {
      return { ok: false, steps: result.steps, message: `tab(${result.steps.tab.reason})` };
    }

    result.steps.images = await step2_uploadImages(payload.images || []);
    if (!result.steps.images.ok) {
      return { ok: false, steps: result.steps, message: `images(${result.steps.images.reason}: ${result.steps.images.detail || ''})` };
    }

    result.steps.title = await step3_fillTitle(payload.title);
    result.steps.body = await step4_fillBody(payload.finalBody || payload.body);

    const failed = ['title', 'body'].filter((k) => !result.steps[k].ok);
    if (failed.length) {
      result.ok = false;
      result.message = '失败步骤：' + failed.map((k) => `${k}(${result.steps[k].reason})`).join(', ');
    } else {
      result.message = `✅ 标题${payload.title.length}字 · 正文${(payload.finalBody||'').length}字 (${result.steps.body.method}) · 图片${payload.images?.length||0}张`;
    }
    log('__rbdFill done:', result.message);
    return result;
  };
})();
