/**
 * 链接资源就地预览 - 内容脚本（全站生效）
 * 点击指向可预览文件的链接时拦截跳转，在页内浮层中直接查看，不再离开当前页面。支持：
 *   - Markdown（.md/.markdown）：后台抓原文（绕过 CORS、带 Cookie），marked 渲染 GFM、DOMPurify 消毒
 *   - PDF（.pdf）：浮层内嵌浏览器原生 PDF 查看器
 *   - 音频/视频：浮层内 HTML5 播放器
 *   - 文本/代码/JSON（.txt/.json/.log/.yml/.xml 及常见源码后缀）：等宽字体展示，JSON 自动格式化
 * 浏览器直接打开 Markdown 文本地址（text/plain|text/markdown，如 raw.githubusercontent.com）时也自动浮层。
 * 事件委托绑在 document 捕获阶段，兼容各站点的无跳转局部导航。
 * 与图片预览共用 popup「资源预览」总开关（previewEnabled）与网站名单，各类型可用 previewTypes 单独启停，
 * 设置持久保存在 chrome.storage.local。
 * 新增可预览类型：在 EXT_GROUPS 登记后缀，并在 load() 中补一个渲染分支即可。
 */
(function() {
  var OVERLAY_ID = 'resource-preview-overlay';
  var MASTER_KEY = 'previewEnabled';        // 统一的资源预览总开关（与图片预览共用）
  var LEGACY_IMG_KEY = 'imagePreviewEnabled'; // 旧版图片独立开关，仅做迁移回退
  var Z = 2147483645;

  // ===== 支持的链接类型（按后缀判定，query/hash 不影响）=====
  var EXT_GROUPS = {
    markdown: ['md', 'markdown'],
    pdf: ['pdf'],
    audio: ['mp3', 'wav', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'flac', 'weba'],
    video: ['mp4', 'webm', 'ogv', 'm4v', 'mov', 'mkv', 'avi'],
    text: [
      'txt', 'text', 'log', 'json', 'jsonl', 'csv', 'tsv', 'ini', 'conf', 'cfg',
      'yaml', 'yml', 'toml', 'env', 'xml', 'sql', 'properties', 'diff', 'patch',
      'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'java', 'py', 'c', 'h', 'cpp', 'cc',
      'hpp', 'cxx', 'cs', 'go', 'rs', 'rb', 'php', 'swift', 'kt', 'scala', 'lua',
      'r', 'pl', 'pm', 'sh', 'bash', 'zsh', 'bat', 'cmd', 'ps1', 'css', 'scss',
      'less', 'vue', 'svelte', 'html', 'htm', 'groovy', 'gradle', 'dart', 'ex',
      'exs', 'clj', 'hs', 'mk'
    ]
  };
  var EXT_TO_KIND = {};
  Object.keys(EXT_GROUPS).forEach(function(kind) {
    EXT_GROUPS[kind].forEach(function(ext) { EXT_TO_KIND[ext] = kind; });
  });
  var KIND_LABEL = { markdown: 'Markdown', pdf: 'PDF', audio: '音频', video: '视频', text: '文本' };

  // ===== 设置状态（与 image-preview.js 共用同一套总开关与网站名单）=====
  var enabled = true;
  var filterMode = 'blacklist'; // blacklist | whitelist
  var blockedSites = [];
  var allowedSites = [];
  // 链接预览的打开方式：click 直接打开 | modifier Alt+点击 | contextMenu 右键菜单
  //                        | drag 拖动打开 | longpress 长按打开 | hover 悬停打开
  var linkTriggerMode = 'click';
  var hoverMs = 600;       // 悬停打开延时
  var longPressMs = 500;   // 长按打开时长
  // 各格式独立启停（popup「预览类型」）：{ image, markdown, pdf, media, text }，缺键视为开启
  var typePrefs = {};
  // audio/video 两个 kind 共用「音视频」一个开关
  function kindEnabled(kind) {
    var key = (kind === 'audio' || kind === 'video') ? 'media' : kind;
    return typePrefs[key] !== false;
  }
  var activeKind = ''; // 当前浮层展示的类型；运行中停用该类型时自动关闭浮层

  // 总开关状态：统一键为准；尚未迁移（popup 未打开过）时回退到旧版图片开关
  function masterOn(res) {
    if (res[MASTER_KEY] !== undefined) return res[MASTER_KEY] !== false;
    return res[LEGACY_IMG_KEY] !== false;
  }

  function siteActive() {
    if (!enabled) return false;
    if (filterMode === 'whitelist') return allowedSites.indexOf(location.hostname) !== -1;
    return blockedSites.indexOf(location.hostname) === -1;
  }

  chrome.storage.local.get(
    [MASTER_KEY, LEGACY_IMG_KEY, 'blockedSites', 'allowedSites', 'siteFilterMode',
     'linkTriggerMode', 'linkHoverMs', 'linkLongPressMs', 'previewTypes'],
    function(res) {
      enabled = masterOn(res);
      blockedSites = res.blockedSites || [];
      allowedSites = res.allowedSites || [];
      if (res.siteFilterMode) filterMode = res.siteFilterMode;
      if (res.linkTriggerMode) linkTriggerMode = res.linkTriggerMode;
      if (res.linkHoverMs) hoverMs = res.linkHoverMs;
      if (res.linkLongPressMs) longPressMs = res.linkLongPressMs;
      typePrefs = res.previewTypes || {};
      if (siteActive()) maybeAutoPreview();
    }
  );

  chrome.storage.onChanged.addListener(function(changes, area) {
    if (area !== 'local') return;
    if (changes[MASTER_KEY]) enabled = changes[MASTER_KEY].newValue !== false;
    if (changes.siteFilterMode) filterMode = changes.siteFilterMode.newValue || 'blacklist';
    if (changes.blockedSites) blockedSites = changes.blockedSites.newValue || [];
    if (changes.allowedSites) allowedSites = changes.allowedSites.newValue || [];
    if (changes.linkTriggerMode) linkTriggerMode = changes.linkTriggerMode.newValue || 'click';
    if (changes.linkHoverMs) hoverMs = changes.linkHoverMs.newValue || 600;
    if (changes.linkLongPressMs) longPressMs = changes.linkLongPressMs.newValue || 500;
    if (changes.previewTypes) {
      typePrefs = changes.previewTypes.newValue || {};
      // 正在展示的类型被停用：立即关闭浮层（与总开关停用同样处理）
      if (activeKind && !kindEnabled(activeKind) && closeActive) closeActive();
    }
    if (!siteActive() && closeActive) closeActive();
  });

  // 右键菜单「预览链接」：任何触发模式下的手动入口，但仍受总开关与名单限制
  chrome.runtime.onMessage.addListener(function(msg) {
    if (msg.action !== 'previewLink' || !siteActive()) return;
    var d = detectKind(msg.url);
    if (d && kindEnabled(d.kind)) openViewer(d.url.href, d.kind);
  });

  // 当前浮层正在展示的地址（用于让文档内同页锚点保持原生滚动）
  var currentDocUrl = '';
  // 关闭当前浮层的句柄：停用开关/名单变更时由 storage 监听调用
  var closeActive = null;

  // 按后缀判定地址类型：仅 http(s)；返回 { url: URL 对象, kind } 或 null
  function detectKind(href, base) {
    if (!href) return null;
    var u;
    try {
      u = new URL(href, base || location.href);
    } catch (e) {
      return null;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    var m = u.pathname.match(/\.([a-z0-9]+)$/i);
    if (!m) return null;
    var kind = EXT_TO_KIND[m[1].toLowerCase()];
    return kind ? { url: u, kind: kind } : null;
  }

  // ===== 直接访问 Markdown 文本地址：自动浮层 =====
  // 仅命中浏览器文本查看器（text/plain|text/markdown）；正常 HTML 站点为 text/html，不会误伤。
  // PDF/音视频/文本浏览器本身可原生展示，不自动弹窗。
  function maybeAutoPreview() {
    var d = detectKind(location.href);
    if (!d || d.kind !== 'markdown' || !kindEnabled('markdown')) return;
    if (/^text\/(plain|markdown|x-markdown)(?:;|$)/i.test(document.contentType || '')) {
      openViewer(d.url.href, 'markdown');
    }
  }

  // ===== 链接打开方式（click | modifier | contextMenu | drag | longpress | hover）=====

  function anchorFromNode(node) {
    var a = node && node.closest ? node.closest('a[href]') : null;
    if (!a || a.hasAttribute('download')) return null;
    return a;
  }
  function detectFromAnchor(anchor) {
    var d = detectKind(anchor.href);
    if (!d) return null;
    // 文档内同页锚点（#章节）不拦截，交给浏览器原生滚动
    if (currentDocUrl && d.url.href.split('#')[0] === currentDocUrl.split('#')[0] && d.url.hash) return null;
    return d;
  }
  // 注意：不拦 Alt——Alt 的语义（modifier 模式必需、click 模式放行）由调用方判断
  function plainClickAllowed(e) {
    return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey; // 中键/新标签页等保持原生
  }

  // 手势触发（长按/拖动）后吞掉随之而来的 click，避免原生跳转
  var suppressClick = false;

  document.addEventListener('click', function(e) {
    if (suppressClick) {
      suppressClick = false;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (!siteActive()) return;
    // 直接打开 / Alt+点击 两种模式在 click 中处理；其余模式（右键/拖动/长按/悬停）不放行点击
    if (linkTriggerMode !== 'click' && linkTriggerMode !== 'modifier') return;
    if (!plainClickAllowed(e)) return;
    if (linkTriggerMode === 'modifier' && !e.altKey) return;
    if (linkTriggerMode === 'click' && e.altKey) return;

    var anchor = anchorFromNode(e.target);
    if (!anchor) return;
    var d = detectFromAnchor(anchor);
    if (!d || !kindEnabled(d.kind)) return;

    e.preventDefault();
    e.stopPropagation();
    openViewer(d.url.href, d.kind);
  }, true);

  // ===== 长按 / 拖动：在链接上按下鼠标后跟踪 =====
  var DRAG_PX = 12;        // 拖动模式的触发距离
  var MOVE_TOLERANCE = 10; // 长按模式允许的轻微抖动
  var hold = null;        // { anchor, d, x, y, mode, timer, rafStart }

  // 长按/悬停时跟随光标的进度环；animate=false 时为静态圆环（拖动模式）
  function startHoldRing(x, y, ms, animate) {
    var ring = document.createElement('div');
    ring.style.cssText =
      'position:fixed;z-index:' + (Z + 3) + ';width:34px;height:34px;border-radius:50%;' +
      'pointer-events:none;display:flex;align-items:center;justify-content:center;' +
      'left:' + (x + 14) + 'px;top:' + (y - 40) + 'px;';
    var fill = document.createElement('div');
    fill.style.cssText =
      'width:34px;height:34px;border-radius:50%;' +
      'background:conic-gradient(rgba(10,10,10,0.25) 360deg);';
    var dot = document.createElement('div');
    dot.style.cssText =
      'position:absolute;width:24px;height:24px;border-radius:50%;background:#fff;' +
      'box-shadow:0 1px 6px rgba(0,0,0,0.25);display:flex;align-items:center;justify-content:center;';
    dot.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#0a0a0a" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>';
    ring.appendChild(fill);
    ring.appendChild(dot);
    document.body.appendChild(ring);

    var t0 = Date.now(), raf = 0;
    if (animate !== false) {
      (function tick() {
        var pct = Math.min(1, (Date.now() - t0) / ms);
        fill.style.background =
          'conic-gradient(rgba(10,10,10,0.9) ' + (pct * 360) + 'deg, rgba(10,10,10,0.25) 0deg)';
        if (pct < 1 && ring.parentNode) raf = requestAnimationFrame(tick);
      })();
    }
    return {
      el: ring,
      move: function(x2, y2) { ring.style.left = (x2 + 14) + 'px'; ring.style.top = (y2 - 40) + 'px'; },
      // 拖动模式：越过阈值后圆环填实，提示「松手即打开」
      setArmed: function(on) {
        fill.style.background = on
          ? 'conic-gradient(rgba(10,10,10,0.9) 360deg, rgba(10,10,10,0.25) 0deg)'
          : 'conic-gradient(rgba(10,10,10,0.25) 360deg)';
      },
      remove: function() { cancelAnimationFrame(raf); if (ring.parentNode) ring.remove(); }
    };
  }

  function cancelHold() {
    if (!hold) return;
    clearTimeout(hold.timer);
    hold.ring.remove();
    hold = null;
  }

  document.addEventListener('mousedown', function(e) {
    if (!siteActive()) return;
    if (linkTriggerMode !== 'longpress' && linkTriggerMode !== 'drag') return;
    if (!plainClickAllowed(e) || e.altKey) return; // Alt+点击（浏览器下载链接）保持原生
    var anchor = anchorFromNode(e.target);
    if (!anchor) return;
    var d = detectFromAnchor(anchor);
    if (!d || !kindEnabled(d.kind)) return;

    e.preventDefault(); // 阻止原生拖出链接与文本选择（click 仍会触发）
    var ring = startHoldRing(
      e.clientX, e.clientY, longPressMs,
      linkTriggerMode === 'longpress' // 拖动模式显示静态圆环，不表达时间
    );

    hold = {
      anchor: anchor, d: d, x: e.clientX, y: e.clientY,
      mode: linkTriggerMode, ring: ring, fired: false, armed: false, timer: 0
    };

    if (hold.mode === 'longpress') {
      hold.timer = setTimeout(function() {
        if (!hold || hold.fired) return;
        var target = hold.d; // finishHold 会把 hold 置空，先取地址
        if (!kindEnabled(target.kind)) { cancelHold(); return; } // 长按期间该类型被停用
        finishHold();
        openViewer(target.url.href, target.kind);
      }, longPressMs);
    }
  }, true);

  document.addEventListener('mousemove', function(e) {
    if (!hold) return;
    var dx = e.clientX - hold.x, dy = e.clientY - hold.y;
    hold.ring.move(e.clientX, e.clientY);
    if (hold.mode === 'longpress') {
      // 长按：移动超过容差视为取消（变成普通拖拽/选择意图）
      if (dx * dx + dy * dy > MOVE_TOLERANCE * MOVE_TOLERANCE) cancelHold();
    } else {
      // 拖动：越过阈值进入「松手即打开」就绪态，但不立即打开
      var armed = dx * dx + dy * dy >= DRAG_PX * DRAG_PX;
      if (armed !== hold.armed) { hold.armed = armed; hold.ring.setArmed(armed); }
    }
  }, true);

  function finishHold() {
    if (!hold) return;
    hold.fired = true;
    suppressClick = true; // 松开后浏览器还会补发 click，吞掉它
    var ring = hold.ring, timer = hold.timer;
    hold = null;
    clearTimeout(timer);
    ring.remove();
  }

  // 松手时判定：拖动已就绪 → 打开；未拖够距离 → 取消，随后的 click 按普通点击放行。失焦一律取消
  window.addEventListener('mouseup', function() {
    if (!hold || hold.fired) return;
    if (hold.mode === 'drag' && hold.armed) {
      var target = hold.d; // finishHold 会把 hold 置空，先取地址
      if (!kindEnabled(target.kind)) { cancelHold(); return; } // 拖动期间该类型被停用
      finishHold();
      openViewer(target.url.href, target.kind);
      // 手势补发的 click 紧随其后被吞掉；若 click 未出现，400ms 后兜底复位
      setTimeout(function() { suppressClick = false; }, 400);
      return;
    }
    cancelHold();
  });
  window.addEventListener('blur', function() { if (hold && !hold.fired) cancelHold(); });

  // ===== 悬停打开：延时自动预览，悬停期间在光标处显示进度环 =====
  var hoverTimer = 0;
  var hoverRing = null;
  var hoverAnchor = null;
  var hoverD = null;
  var hoverSuppressUntil = 0; // 关闭浮层后的短暂抑制期，防止立刻重弹

  function clearHover() {
    clearTimeout(hoverTimer);
    if (hoverRing) { hoverRing.remove(); hoverRing = null; }
    hoverAnchor = null;
    hoverD = null;
  }

  document.addEventListener('mouseover', function(e) {
    if (!siteActive() || linkTriggerMode !== 'hover') return;
    if (Date.now() < hoverSuppressUntil) return; // 刚关闭浮层，不再立刻重弹
    if (document.getElementById(OVERLAY_ID)) return; // 浮层已打开，不再触发
    var anchor = anchorFromNode(e.target);
    if (!anchor || anchor === hoverAnchor) return;
    var d = detectFromAnchor(anchor);
    if (!d || !kindEnabled(d.kind)) return;

    clearHover();
    hoverAnchor = anchor;
    hoverD = d;

    hoverTimer = setTimeout(function() {
      if (linkTriggerMode !== 'hover' || !siteActive() || Date.now() < hoverSuppressUntil) return;
      if (document.getElementById(OVERLAY_ID)) return;
      var target = hoverD;
      clearHover();
      if (target && kindEnabled(target.kind)) openViewer(target.url.href, target.kind);
    }, hoverMs);

    hoverRing = startHoldRing(e.clientX, e.clientY, hoverMs, true);
  }, true);

  document.addEventListener('mousemove', function(e) {
    if (hoverRing) hoverRing.move(e.clientX, e.clientY);
  }, true);

  document.addEventListener('mouseout', function(e) {
    if (!hoverAnchor) return;
    // 移到链接的子元素上不取消；relatedTarget 仍在链接内则忽略
    var rt = e.relatedTarget;
    if (rt && hoverAnchor.contains(rt)) return;
    if (e.target === hoverAnchor || hoverAnchor.contains(e.target)) clearHover();
  }, true);

  var ICONS = {
    copy: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>',
    check: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    external: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>',
    close: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>'
  };

  // 代码平台的 blob 页面地址 → 原文(raw)地址。
  // 代码平台上的文本类链接通常指向渲染后的 HTML 页（GitHub/GitLab 等），直接抓取会拿到整页 HTML，
  // 需先换成原始文本地址；支持 GitHub/Gitee/GitLab（含自建）/Bitbucket 及 Gitea/Gogs 同源站点
  function toRawUrl(href) {
    var u;
    try { u = new URL(href); } catch (e) { return href; }
    var p = u.pathname, m;

    // GitLab（含自建）：/owner/repo/-/blob/ref/path → /owner/repo/-/raw/ref/path
    m = p.match(/^(.+?\/-)\/blob\/(.+)$/);
    if (m) { u.pathname = m[1] + '/raw/' + m[2]; return u.href; }

    // /owner/repo/blob/ref/path
    m = p.match(/^\/([^/]+\/[^/]+)\/blob\/(.+)$/);
    if (m) {
      if (/(^|\.)github\.com$/.test(u.hostname)) {
        // GitHub：换域到 raw.githubusercontent.com/owner/repo/ref/path（分支/标签/SHA 均可）
        return 'https://raw.githubusercontent.com/' + m[1] + '/' + m[2];
      }
      // Gitee / Gitea / Gogs 等：同源 /blob/ → /raw/
      u.pathname = '/' + m[1] + '/raw/' + m[2];
      return u.href;
    }

    // Bitbucket：/owner/repo/src/ref/path → /owner/repo/raw/ref/path
    m = p.match(/^\/([^/]+\/[^/]+)\/src\/(.+)$/);
    if (m && /(^|\.)bitbucket\.org$/.test(u.hostname)) {
      u.pathname = '/' + m[1] + '/raw/' + m[2];
      return u.href;
    }

    return href;
  }

  // 取地址末段作为文档标题（解码 %XX）
  function fileNameOf(url) {
    var seg;
    try {
      seg = new URL(url).pathname.split('/').pop() || 'document';
    } catch (e) {
      seg = 'document';
    }
    try { seg = decodeURIComponent(seg); } catch (e) {}
    return seg;
  }

  // 复制到剪贴板：安全上下文用 Clipboard API，http 页面降级到 execCommand
  function writeClipboard(text, cb) {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function() { cb(true); }, function() { cb(fallbackCopy(text)); });
    } else {
      cb(fallbackCopy(text));
    }
  }
  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }

  function openViewer(url, kind) {
    activeKind = kind;
    // 浮层已打开：复用，不重建（支持文档内串联跳转、跨类型切换）
    var existing = document.getElementById(OVERLAY_ID);
    if (existing && existing._load) {
      existing._load(url, kind);
      return;
    }

    var prevOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';

    var overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.style.cssText =
      'position:fixed;top:0;left:0;right:0;bottom:0;' +
      'background:rgba(0,0,0,0.55);z-index:' + Z + ';opacity:0;transition:opacity .15s ease;' +
      'display:flex;align-items:center;justify-content:center;' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;';

    var card = document.createElement('div');
    card.style.cssText =
      'width:920px;max-width:92vw;height:88vh;max-height:88vh;' +
      'background:#fff;border-radius:16px;box-shadow:0 16px 60px rgba(0,0,0,0.28);' +
      'display:flex;flex-direction:column;overflow:hidden;';

    // ===== 顶栏：文件名 + 操作按钮 =====
    var header = document.createElement('div');
    header.style.cssText =
      'flex:none;display:flex;align-items:center;gap:6px;padding:10px 12px 10px 16px;' +
      'border-bottom:1px solid #e5e5e5;background:#fff;';

    var title = document.createElement('div');
    title.style.cssText =
      'flex:1;min-width:0;font-size:13px;font-weight:600;color:#0a0a0a;' +
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' +
      'font-family:"Geist Mono","SF Mono",Consolas,monospace;letter-spacing:-0.01em;';
    title.textContent = fileNameOf(url);

    function hbtn(icon, tip, handler) {
      var b = document.createElement('button');
      b.type = 'button';
      b.title = tip;
      b.innerHTML = icon;
      b.style.cssText =
        'flex:none;width:32px;height:32px;padding:0;border:none;border-radius:50%;' +
        'background:transparent;color:#737373;cursor:pointer;display:inline-flex;' +
        'align-items:center;justify-content:center;transition:background .12s,color .12s;';
      b.addEventListener('mouseenter', function() { b.style.background = '#f0f0f0'; b.style.color = '#0a0a0a'; });
      b.addEventListener('mouseleave', function() { b.style.background = 'transparent'; b.style.color = '#737373'; });
      b.addEventListener('click', function(e) { e.stopPropagation(); handler(); });
      var svgEl = b.querySelector('svg');
      if (svgEl) svgEl.style.display = 'block';
      header.appendChild(b);
      return b;
    }

    header.appendChild(title);

    var copyBtn = hbtn(ICONS.copy, '复制地址', function() {
      writeClipboard(currentDocUrl, function(ok) {
        if (!ok) return;
        copyBtn.innerHTML = ICONS.check;
        copyBtn.querySelector('svg').style.display = 'block';
        setTimeout(function() {
          copyBtn.innerHTML = ICONS.copy;
          copyBtn.querySelector('svg').style.display = 'block';
        }, 1400);
      });
    });
    hbtn(ICONS.external, '在新标签页打开', function() { window.open(currentDocUrl, '_blank', 'noopener'); });
    hbtn(ICONS.close, '关闭（ESC）', close);

    // ===== 内容区：每次 load 整体替换内部元素 =====
    var body = document.createElement('div');
    body.style.cssText = 'flex:1;min-height:0;display:flex;flex-direction:column;background:#fff;';

    card.appendChild(header);
    card.appendChild(body);
    overlay.appendChild(card);

    // 排版样式随浮层一起移除；选择器全部以 ID 起头提高特异性，抗宿主页面样式渗入
    var styleEl = document.createElement('style');
    styleEl.textContent = VIEWER_CSS;
    overlay.appendChild(styleEl);

    document.body.appendChild(overlay);
    requestAnimationFrame(function() { overlay.style.opacity = '1'; });

    // token 标识当前加载：快速串联跳转时，过期的异步响应一律忽略
    var token = 0;

    function mount(el) {
      while (body.firstChild) body.removeChild(body.firstChild);
      if (el) body.appendChild(el);
    }

    function makeState(kind) {
      var box = document.createElement('div');
      box.style.cssText =
        'flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;' +
        'gap:14px;padding:24px;text-align:center;';
      return box;
    }

    function showLoading(message) {
      var box = makeState();
      var spinner = document.createElement('div');
      spinner.className = 'rp-spinner';
      var txt = document.createElement('div');
      txt.style.cssText = 'font-size:13px;color:#737373;';
      txt.textContent = message;
      box.appendChild(spinner);
      box.appendChild(txt);
      mount(box);
    }

    function showError(message) {
      var box = makeState();
      var t = document.createElement('div');
      t.style.cssText = 'font-size:14px;color:#0a0a0a;word-break:break-all;max-width:420px;';
      t.textContent = message;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = '在新标签页打开';
      btn.style.cssText =
        'padding:9px 18px;border:none;border-radius:999px;background:#0a0a0a;color:#fafafa;' +
        'font-family:inherit;font-size:13px;font-weight:500;cursor:pointer;';
      btn.addEventListener('click', function() { window.open(currentDocUrl, '_blank', 'noopener'); });
      box.appendChild(t);
      box.appendChild(btn);
      mount(box);
    }

    // 请求后台抓取文本（Markdown / 文本代码），统一处理通信与 HTTP 错误
    function fetchRemoteText(fetchUrl, myToken, cb) {
      chrome.runtime.sendMessage({ action: 'fetchText', url: fetchUrl }, function(res) {
        if (myToken !== token) return; // 已切换到其他资源
        if (chrome.runtime.lastError) {
          showError('加载失败：' + chrome.runtime.lastError.message);
          return;
        }
        if (!res || res.ok === false) {
          showError(res && res.status
            ? '加载失败（HTTP ' + res.status + '）'
            : '加载失败：' + ((res && res.error) || '未知错误'));
          return;
        }
        cb(res);
      });
    }

    /* ---------- Markdown ---------- */

    function renderMarkdown(text, docUrl) {
      if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') {
        showError('Markdown 渲染组件未加载，请在新标签页打开');
        return;
      }
      var docEl = document.createElement('div');
      docEl.className = 'rp-md';
      var html;
      try {
        marked.setOptions({ gfm: true, breaks: false });
        html = DOMPurify.sanitize(marked.parse(text));
      } catch (e) {
        showError('渲染失败：' + ((e && e.message) || e));
        return;
      }
      docEl.innerHTML = html;

      // marked 12 无 baseUrl 选项：相对链接/图片按原文地址转成绝对地址；
      // 单个畸形 URL 跳过即可，不能连累整篇文档渲染失败
      docEl.querySelectorAll('a[href]').forEach(function(a) {
        var raw = a.getAttribute('href');
        if (raw.charAt(0) === '#') return; // 同页锚点保持相对，交给原生滚动
        var abs = null;
        try { abs = new URL(raw, docUrl).href; } catch (e) {}
        if (!abs) return;
        a.setAttribute('href', abs);
        // 指向其他「已启用」可预览类型的链接不加 target（由页面级点击拦截在浮层内继续打开），
        // 不支持或已停用的类型新标签页打开
        var linkKind = detectKind(abs);
        if (!linkKind || !kindEnabled(linkKind.kind)) {
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
        }
      });
      docEl.querySelectorAll('img[src]').forEach(function(im) {
        try {
          im.setAttribute('src', new URL(im.getAttribute('src'), docUrl).href);
        } catch (e) { return; }
        im.loading = 'lazy';
        im.decoding = 'async';
      });

      var wrap = document.createElement('div');
      wrap.style.cssText = 'flex:1;min-height:0;overflow-y:auto;';
      wrap.appendChild(docEl);
      mount(wrap);
    }

    function loadMarkdown(target) {
      var myToken = ++token;
      showLoading('正在加载 Markdown…');
      // 代码平台的 blob 页面地址先换算成 raw 原文地址
      var fetchUrl = toRawUrl(target);
      fetchRemoteText(fetchUrl, myToken, function(res) {
        // 返回 HTML 说明该地址是渲染页而非 Markdown 原文（未知平台无法换算 raw）
        if (/^text\/html/i.test(res.contentType || '')) {
          showError('该地址返回的是 HTML 页面而非 Markdown 原文');
          return;
        }
        renderMarkdown(res.text, fetchUrl);
      });
    }

    /* ---------- 文本 / 代码 / JSON ---------- */

    function renderText(text, target) {
      var ext = (target.match(/\.([a-z0-9]+)(?:[?#]|$)/i) || [])[1] || '';
      ext = ext.toLowerCase();
      var content = text;
      if (ext === 'json') {
        try { content = JSON.stringify(JSON.parse(text), null, 2); } catch (e) { /* 非法 JSON 按原文展示 */ }
      }
      var pre = document.createElement('pre');
      pre.className = 'rp-text';
      pre.textContent = content; // textContent 天然防注入
      var wrap = document.createElement('div');
      wrap.style.cssText = 'flex:1;min-height:0;overflow:auto;';
      wrap.appendChild(pre);
      mount(wrap);
    }

    function loadText(target) {
      var myToken = ++token;
      showLoading('正在加载文本…');
      var fetchUrl = toRawUrl(target);
      fetchRemoteText(fetchUrl, myToken, function(res) {
        if (/^text\/html/i.test(res.contentType || '')) {
          showError('该地址返回的是 HTML 页面而非文本原文');
          return;
        }
        renderText(res.text, target);
      });
    }

    /* ---------- PDF：内嵌浏览器原生查看器 ---------- */

    function loadPdf(target) {
      var myToken = ++token; // 中断可能进行中的异步加载
      showLoading('正在加载 PDF…');

      var frame = document.createElement('iframe');
      frame.src = target;
      frame.title = fileNameOf(target);
      frame.style.cssText = 'flex:1;min-height:0;width:100%;border:0;background:#fff;';
      var done = false;
      function reveal() {
        if (done || myToken !== token) return; // 已展示或已切换到其他资源
        done = true;
        mount(frame);
      }
      frame.addEventListener('load', reveal);
      // 内置 PDF 查看器一般会触发 load；个别环境不触发，1.5 秒后无论如何显示
      setTimeout(reveal, 1500);
    }

    /* ---------- 音频 / 视频：HTML5 播放器 ---------- */

    function loadMedia(target, kind) {
      var myToken = ++token; // 中断可能进行中的异步加载
      showLoading(kind === 'audio' ? '正在加载音频…' : '正在加载视频…');

      var el = document.createElement(kind === 'audio' ? 'audio' : 'video');
      el.controls = true;
      el.preload = 'metadata';
      el.src = target;

      var box = document.createElement('div');
      box.style.cssText =
        'flex:1;min-height:0;display:flex;align-items:center;justify-content:center;' +
        'padding:28px;background:#fafafa;';
      if (kind === 'audio') {
        el.style.cssText = 'width:380px;max-width:100%;';
      } else {
        el.style.cssText = 'max-width:100%;max-height:100%;border-radius:10px;background:#000;';
      }
      el.addEventListener('error', function() {
        if (myToken !== token) return; // 已切换到其他资源
        showError('无法播放该' + (kind === 'audio' ? '音频' : '视频') + '（格式可能不受支持或地址已失效）');
      }, { once: true });
      box.appendChild(el);
      // metadata 到达即展示（部分格式不触发 canplay）；只挂载一次
      var revealed = false;
      function reveal() {
        if (revealed || myToken !== token) return;
        revealed = true;
        mount(box);
      }
      el.addEventListener('canplay', reveal, { once: true });
      el.addEventListener('loadedmetadata', reveal, { once: true });
    }

    function load(target, kind) {
      currentDocUrl = target;
      title.textContent = fileNameOf(target);
      switch (kind) {
        case 'markdown': loadMarkdown(target); break;
        case 'text':     loadText(target); break;
        case 'pdf':      loadPdf(target); break;
        case 'audio':
        case 'video':    loadMedia(target, kind); break;
        default:         showError('不支持的预览类型：' + (KIND_LABEL[kind] || kind));
      }
    }
    overlay._load = load;

    // ===== 关闭：点遮罩、×、ESC =====
    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) close();
    });

    function onKeydown(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    }
    document.addEventListener('keydown', onKeydown, true);

    function close() {
      overlay.remove();
      document.documentElement.style.overflow = prevOverflow;
      document.removeEventListener('keydown', onKeydown, true);
      currentDocUrl = '';
      activeKind = '';
      closeActive = null;
      hoverSuppressUntil = Date.now() + 1500; // 光标可能仍停在链接上，短暂抑制悬停重弹
      cancelHold();
      clearHover();
    }
    closeActive = close;

    load(url, kind);
  }

  // ===== 浮层排版样式（单色体系：ink #0a0a0a / hairline #e5e5e5 / 灰面 #f5f5f5）=====
  var VIEWER_CSS =
    '#resource-preview-overlay .rp-md{box-sizing:border-box;padding:34px 44px 60px;color:#0a0a0a;' +
    'font-size:14.5px;line-height:1.7;word-wrap:break-word;}' +
    '#resource-preview-overlay .rp-md *{box-sizing:border-box;}' +
    '#resource-preview-overlay .rp-md>:first-child{margin-top:0;}' +
    '#resource-preview-overlay .rp-md>:last-child{margin-bottom:0;}' +
    '#resource-preview-overlay .rp-md h1,#resource-preview-overlay .rp-md h2,#resource-preview-overlay .rp-md h3,' +
    '#resource-preview-overlay .rp-md h4,#resource-preview-overlay .rp-md h5,#resource-preview-overlay .rp-md h6{' +
    'margin:26px 0 14px;font-weight:600;line-height:1.3;letter-spacing:-0.01em;}' +
    '#resource-preview-overlay .rp-md h1{font-size:24px;padding-bottom:9px;border-bottom:1px solid #e5e5e5;}' +
    '#resource-preview-overlay .rp-md h2{font-size:19px;padding-bottom:7px;border-bottom:1px solid #e5e5e5;}' +
    '#resource-preview-overlay .rp-md h3{font-size:16px;}' +
    '#resource-preview-overlay .rp-md h4{font-size:14.5px;}' +
    '#resource-preview-overlay .rp-md h5,#resource-preview-overlay .rp-md h6{font-size:13.5px;color:#737373;}' +
    '#resource-preview-overlay .rp-md p,#resource-preview-overlay .rp-md ul,#resource-preview-overlay .rp-md ol,' +
    '#resource-preview-overlay .rp-md blockquote,#resource-preview-overlay .rp-md table,#resource-preview-overlay .rp-md pre{' +
    'margin:0 0 14px;}' +
    '#resource-preview-overlay .rp-md ul,#resource-preview-overlay .rp-md ol{padding-left:26px;}' +
    '#resource-preview-overlay .rp-md li{margin:4px 0;}' +
    '#resource-preview-overlay .rp-md li>ul,#resource-preview-overlay .rp-md li>ol{margin:4px 0;}' +
    '#resource-preview-overlay .rp-md a{color:#0a0a0a;text-decoration:underline;text-underline-offset:2px;' +
    'text-decoration-thickness:1px;text-decoration-color:#a3a3a3;}' +
    '#resource-preview-overlay .rp-md a:hover{text-decoration-color:#0a0a0a;}' +
    '#resource-preview-overlay .rp-md strong{font-weight:600;}' +
    '#resource-preview-overlay .rp-md code{font-family:"Geist Mono","SF Mono",Consolas,monospace;font-size:0.86em;' +
    'background:#f5f5f5;border:1px solid #efefef;border-radius:6px;padding:1.5px 5px;}' +
    '#resource-preview-overlay .rp-md pre{padding:15px 17px;background:#fafafa;border:1px solid #e5e5e5;' +
    'border-radius:12px;overflow-x:auto;font-size:12.5px;line-height:1.6;}' +
    '#resource-preview-overlay .rp-md pre code{font-size:inherit;background:none;border:none;padding:0;' +
    'border-radius:0;white-space:pre;}' +
    '#resource-preview-overlay .rp-md blockquote{margin-left:0;padding:2px 0 2px 15px;border-left:3px solid #d4d4d4;' +
    'color:#737373;}' +
    '#resource-preview-overlay .rp-md blockquote>:first-child{margin-top:0;}' +
    '#resource-preview-overlay .rp-md blockquote>:last-child{margin-bottom:0;}' +
    '#resource-preview-overlay .rp-md table{border-collapse:collapse;display:block;max-width:100%;overflow-x:auto;' +
    'font-size:13.5px;}' +
    '#resource-preview-overlay .rp-md th,#resource-preview-overlay .rp-md td{padding:7px 13px;border:1px solid #e5e5e5;}' +
    '#resource-preview-overlay .rp-md th{background:#fafafa;font-weight:600;text-align:left;}' +
    '#resource-preview-overlay .rp-md tr:nth-child(2n) td{background:#fcfcfc;}' +
    '#resource-preview-overlay .rp-md hr{border:none;border-top:1px solid #e5e5e5;margin:24px 0;}' +
    '#resource-preview-overlay .rp-md img{max-width:100%;border-radius:8px;}' +
    '#resource-preview-overlay .rp-md input[type=checkbox]{margin:0 4px 0 -22px;vertical-align:middle;}' +
    '#resource-preview-overlay .rp-text{margin:0;padding:22px 26px 40px;min-width:100%;' +
    'font-family:"Geist Mono","SF Mono",Consolas,monospace;font-size:12.5px;line-height:1.65;' +
    'color:#0a0a0a;white-space:pre;tab-size:2;}' +
    '@keyframes rp-spin{to{transform:rotate(360deg);}}' +
    '#resource-preview-overlay .rp-spinner{width:26px;height:26px;border:2.5px solid #e5e5e5;' +
    'border-top-color:#737373;border-radius:50%;animation:rp-spin .7s linear infinite;}';
})();
