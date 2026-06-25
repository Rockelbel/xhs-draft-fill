/**
 * post.txt 解析 + 平台限制处理（标题截断、空行折叠）。
 */
(function () {
  const MAX_TITLE_LEN = 20;
  const MAX_BODY_LEN = 1000;
  const TITLE_BREAKS = '，。,.！？!?；;';

  function shortenTitle(title, limit = MAX_TITLE_LEN) {
    if ([...title].length <= limit) return title;
    // 按字符（不按字节）处理，中文一个字符
    const chars = [...title];
    if (chars.length <= limit) return title;
    let cutAt = -1;
    for (let i = 0; i < Math.min(chars.length, limit); i++) {
      if (TITLE_BREAKS.includes(chars[i])) cutAt = i;
    }
    if (cutAt >= 0) return chars.slice(0, cutAt).join('').trim();
    return chars.slice(0, limit).join('').trim();
  }

  function parsePost(text) {
    const raw = text.replace(/\s+$/, '');
    const lines = raw.split('\n');

    let title = '';
    let titleIdx = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim()) {
        title = lines[i].trim();
        titleIdx = i;
        break;
      }
    }
    if (!title) throw new Error('找不到标题（首行非空）');

    let tags = [];
    let tagsIdx = lines.length;
    for (let j = lines.length - 1; j > titleIdx; j--) {
      if (lines[j].trim()) {
        if (lines[j].trimStart().startsWith('#')) {
          tags = lines[j]
            .split(/\s+/)
            .map((t) => t.replace(/^#+/, '').trim())
            .filter(Boolean);
          tagsIdx = j;
        }
        break;
      }
    }

    let bodyLines = lines.slice(titleIdx + 1, tagsIdx);
    while (bodyLines.length && !bodyLines[0].trim()) bodyLines.shift();
    while (bodyLines.length && !bodyLines[bodyLines.length - 1].trim()) bodyLines.pop();
    let body = bodyLines.join('\n');
    // XHS 禁止连续空行，但允许"含空格的行"。
    // 把 N 个连续换行（N ≥ 2）替换成 \n \n，相当于在段落之间插入一个含单空格的行。
    // 这样视觉上有呼吸感，又不会触发"不支持连续空行输入"。
    body = body.replace(/\n{2,}/g, '\n \n');

    if (!body) throw new Error('正文为空');

    const originalTitle = title;
    title = shortenTitle(title);
    const titleShortened = title !== originalTitle;

    return { title, originalTitle, titleShortened, body, tags, finalBody: body };
  }

  window.RBDParser = { parsePost, shortenTitle, MAX_TITLE_LEN, MAX_BODY_LEN };
})();
