/**
 * 图片就地预览 - 内容脚本（全站生效）
 * 在任意网页点击图片时弹出浮层就地查看：左右切换、滚轮/按钮缩放（鼠标点移至中心）、
 * 拖动平移、跳转到仓库目录（代码平台）、新标签页打开。ESC 关闭。
 * 事件委托绑在 document 上，兼容各站点的无跳转局部导航。
 * 可在扩展 popup 中通过开关停用，设置持久保存在 chrome.storage.local。
 */
(function() {
  var OVERLAY_ID = 'img-preview-overlay';
  var STORE_KEY = 'imagePreviewEnabled';
  var LEGACY_KEY = 'ghImagePreviewEnabled'; // 旧版仅 GitHub 时的设置键，做一次迁移
  var Z = 2147483646;

  // ===== 设置状态 =====
  var enabled = true;
  var triggerMode = 'click';   // click | contextMenu | modifier | hover
  var filterMode = 'blacklist'; // blacklist | whitelist
  var blockedSites = [];
  var allowedSites = [];

  // 当前站点功能是否可用：总开关 + 名单判定
  function siteActive() {
    if (!enabled) return false;
    if (filterMode === 'whitelist') return allowedSites.indexOf(location.hostname) !== -1;
    return blockedSites.indexOf(location.hostname) === -1;
  }

  chrome.storage.local.get(
    [STORE_KEY, LEGACY_KEY, 'blockedSites', 'allowedSites', 'previewTriggerMode', 'siteFilterMode'],
    function(res) {
      enabled = res[STORE_KEY] !== undefined
        ? res[STORE_KEY]
        : res[LEGACY_KEY] !== false;
      blockedSites = res.blockedSites || [];
      allowedSites = res.allowedSites || [];
      if (res.previewTriggerMode) triggerMode = res.previewTriggerMode;
      if (res.siteFilterMode) filterMode = res.siteFilterMode;
    }
  );
  chrome.storage.onChanged.addListener(function(changes, area) {
    if (area !== 'local') return;
    if (changes[STORE_KEY]) enabled = changes[STORE_KEY].newValue !== false;
    if (changes.previewTriggerMode) triggerMode = changes.previewTriggerMode.newValue || 'click';
    if (changes.siteFilterMode) filterMode = changes.siteFilterMode.newValue || 'blacklist';
    if (changes.blockedSites) blockedSites = changes.blockedSites.newValue || [];
    if (changes.allowedSites) allowedSites = changes.allowedSites.newValue || [];

    if (!siteActive()) {
      var ov = document.getElementById(OVERLAY_ID);
      if (ov) {
        ov.remove();
        document.documentElement.style.overflow = ''; // 绕过 close()，手动恢复滚动
      }
    }
  });

  // 右键菜单「预览图片」：任何触发模式下的手动入口，但仍受总开关与名单限制
  chrome.runtime.onMessage.addListener(function(msg) {
    if (msg.action === 'previewImage') {
      if (!siteActive()) return;
      var images = collectImages();
      var target = null;
      if (msg.srcUrl) {
        target = images.find(function(im) { return im.src === msg.srcUrl || im.currentSrc === msg.srcUrl; });
      }
      if (target) openViewer(images, images.indexOf(target));
      else if (msg.srcUrl) openViewer([{ src: msg.srcUrl, currentSrc: msg.srcUrl, alt: '' }], 0);
    }
  });

  // 判断外层链接是否指向图片本身（代码平台会自动给 ![](x.png) 包裹图片链接）。
  // 若图片挂的是用户自定义超链（[![](x)](https://other.com)），则返回 false 不拦截。
  function isImageLink(anchor) {
    var href = anchor.href || '';
    if (!href) return true;
    if (/[?&]raw=true/.test(href) || /\/raw\//.test(href)) return true;
    if (/\.(png|jpe?g|gif|webp|bmp|avif|svg|ico)([?#].*)?$/i.test(href)) return true;
    if (/(^|\.)githubusercontent\.com$/.test(anchor.hostname)) return true;
    if (/(^|\.)gitlabusercontent\.com$/.test(anchor.hostname)) return true;
    return false;
  }

  // 表情图片不拦截（各平台 emoji 的 class 或 URL 特征）
  function isEmoji(img) {
    if (img.classList.contains('emoji')) return true;
    if (/[/_-]emoji[/_-]/i.test(img.src)) return true;
    return false;
  }

  // 处于交互控件内的图片不拦截（如 <button><img></button>），避免吞掉按钮点击
  function isInteractive(img) {
    return !!(img.closest('button, [role="button"], input, label, select'));
  }

  // 收集页面上所有可预览的图片（按文档顺序）：已渲染、非表情、非交互控件
  function collectImages() {
    var imgs = Array.prototype.slice.call(document.querySelectorAll('img'));
    return imgs.filter(function(img) {
      if (img.offsetWidth === 0 || img.offsetHeight === 0) return false;
      if (Math.max(img.offsetWidth, img.offsetHeight) < 24) return false;
      if (isEmoji(img) || isInteractive(img)) return false;
      var a = img.closest('a');
      return !a || isImageLink(a);
    });
  }

  var ICONS = {
    prev: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>',
    next: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',
    zoomOut: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/><path d="M8 11h6"/></svg>',
    zoomIn: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/><path d="M11 8v6M8 11h6"/></svg>',
    fit: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>',
    external: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>',
    link: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
    copy: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>',
    check: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    locate: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="22" x2="18" y1="12" y2="12"/><line x1="6" x2="2" y1="12" y2="12"/><line x1="12" x2="12" y1="6" y2="2"/><line x1="12" x2="12" y1="22" y2="18"/></svg>',
    download: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>',
    // 文件夹：Lucide 原 path 在 viewBox 中几何中心偏上、矩形主体视觉重心也偏上，
    // 根节点下移 1px 做视觉补偿（display:block 消除 inline SVG 基线留白）
    folder: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block;transform:translateY(1px)"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>'
  };

  // 取文件路径的父目录（去掉文件名），无父目录返回 ''
  function parentDir(path) {
    var dir = (path || '').split(/[?#]/)[0];
    var slash = dir.lastIndexOf('/');
    return slash >= 0 ? dir.slice(0, slash) : '';
  }

  // 从图片外层链接推导图片所在仓库目录页 URL，支持主流代码平台；无法推导返回 null。
  // GitHub / Gitee： /owner/repo/blob|raw/branch/a/x.png → /owner/repo/tree/branch/a
  // GitLab：         /owner/repo/-/blob|raw/branch/a/x   → /owner/repo/-/tree/branch/a
  // Bitbucket：      /owner/repo/src/branch/a/x          → /owner/repo/src/branch/a
  function repoDirUrl(imgEl) {
    var a = imgEl.closest('a');
    var href = a ? a.href : '';
    var m, dir;

    m = href.match(/^(https?:\/\/[^/]+\/[^/]+\/[^/]+)\/-\/(?:blob|raw)\/([^/?#]+)(?:\/(.+))?/);
    if (m) {
      dir = parentDir(m[3]);
      return m[1] + '/-/tree/' + m[2] + (dir ? '/' + dir : '');
    }

    m = href.match(/^(https?:\/\/[^/]+\/[^/]+\/[^/]+)\/(?:blob|raw)\/([^/?#]+)(?:\/(.+))?/);
    if (m) {
      dir = parentDir(m[3]);
      return m[1] + '/tree/' + m[2] + (dir ? '/' + dir : '');
    }

    m = href.match(/^(https?:\/\/[^/]+\/[^/]+\/[^/]+)\/src\/([^/?#]+)(?:\/(.+))?/);
    if (m) {
      dir = parentDir(m[3]);
      return m[1] + '/src/' + m[2] + (dir ? '/' + dir : '');
    }

    // raw.githubusercontent.com/owner/repo/branch/path → github.com 目录页
    m = href.match(/^https?:\/\/raw\.githubusercontent\.com\/([^/]+\/[^/]+)\/([^/?#]+)(?:\/(.+))?/);
    if (m) {
      dir = parentDir(m[3]);
      return 'https://github.com/' + m[1] + '/tree/' + m[2] + (dir ? '/' + dir : '');
    }

    return null;
  }

  function openViewer(images, index) {
    var old = document.getElementById(OVERLAY_ID);
    if (old) old.remove();

    var prevOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';

    // zoom === null 表示适应窗口；数字表示相对当前渲染尺寸的倍率
    var zoom = null;
    var baseWidth = 0;

    var overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.style.cssText =
      'position:fixed;top:0;left:0;right:0;bottom:0;' +
      'background:rgba(0,0,0,0.88);z-index:' + Z + ';opacity:0;transition:opacity .15s ease;' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;';

    // ===== 顶部工具栏 =====
    var toolbar = document.createElement('div');
    toolbar.style.cssText =
      'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:' + (Z + 2) + ';' +
      'display:flex;align-items:center;gap:2px;padding:5px;' +
      'background:rgba(30,30,30,0.85);border:1px solid rgba(255,255,255,0.12);' +
      'border-radius:18px;backdrop-filter:blur(8px);box-shadow:0 4px 20px rgba(0,0,0,0.4);';

    function tbtn(icon, title, handler) {
      var b = document.createElement('button');
      b.type = 'button';
      b.title = title;
      b.innerHTML = icon;
      b.style.cssText =
        'display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;' +
        'border:none;border-radius:50%;background:transparent;color:rgba(255,255,255,0.85);' +
        'cursor:pointer;transition:background .12s,color .12s;';
      b.addEventListener('mouseenter', function() {
        b.style.background = 'rgba(255,255,255,0.15)';
        b.style.color = '#fff';
      });
      b.addEventListener('mouseleave', function() {
        b.style.background = 'transparent';
        b.style.color = 'rgba(255,255,255,0.85)';
      });
      b.addEventListener('click', function(e) { e.stopPropagation(); handler(); });
      var svgEl = b.querySelector('svg');
      if (svgEl) svgEl.style.display = 'block';
      toolbar.appendChild(b);
      return b;
    }
    function sep() {
      var s = document.createElement('span');
      s.style.cssText = 'width:1px;height:20px;background:rgba(255,255,255,0.15);margin:0 4px;';
      toolbar.appendChild(s);
    }

    var prevBtn = tbtn(ICONS.prev, '上一张（←）', function() { showAt(index - 1); });
    var counter = document.createElement('span');
    counter.style.cssText = 'color:rgba(255,255,255,0.85);font-size:12px;min-width:52px;text-align:center;font-variant-numeric:tabular-nums;';
    toolbar.appendChild(counter);
    var nextBtn = tbtn(ICONS.next, '下一张（→）', function() { showAt(index + 1); });
    sep();
    tbtn(ICONS.zoomOut, '缩小（-）', zoomOut);
    var zoomLabel = document.createElement('span');
    zoomLabel.style.cssText = 'color:rgba(255,255,255,0.85);font-size:12px;min-width:48px;text-align:center;font-variant-numeric:tabular-nums;cursor:pointer;';
    zoomLabel.title = '适应窗口（0）';
    zoomLabel.addEventListener('click', function(e) { e.stopPropagation(); zoomFit(); });
    toolbar.appendChild(zoomLabel);
    tbtn(ICONS.zoomIn, '放大（+）', zoomIn);
    sep();
    tbtn(ICONS.fit, '适应窗口（0）', zoomFit);
    var dirBtn = tbtn(ICONS.folder, '跳转到仓库目录', function() {
      var url = repoDirUrl(images[index]);
      if (url) location.href = url; // 原生跳转：当前标签页离开
    });
    tbtn(ICONS.locate, '定位到原图在页面中的位置', locateOriginal);
    sep();
    var linkBtn = tbtn(ICONS.link, '查看原图地址', toggleUrlBar);
    var copyBtn = tbtn(ICONS.copy, '复制原图地址', copySrc);
    var dlBtn = tbtn(ICONS.download, '下载图片（单张/多张）', toggleDownloadPanel);
    tbtn(ICONS.external, '在新标签页打开', openExternal);

    // ===== 右上角关闭 =====
    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.title = '关闭（ESC）';
    closeBtn.innerHTML =
      '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
    closeBtn.style.cssText =
      'position:fixed;top:16px;right:20px;z-index:' + (Z + 2) + ';width:40px;height:40px;' +
      'border:1px solid rgba(255,255,255,0.12);border-radius:50%;background:rgba(30,30,30,0.85);color:#fff;' +
      'cursor:pointer;backdrop-filter:blur(8px);padding:0;' +
      'display:flex;align-items:center;justify-content:center;transition:background .12s;';
    closeBtn.addEventListener('mouseenter', function() { closeBtn.style.background = 'rgba(60,60,60,0.9)'; });
    closeBtn.addEventListener('mouseleave', function() { closeBtn.style.background = 'rgba(30,30,30,0.85)'; });

    // ===== 图片滚动视口 =====
    // 不使用 align/justify 居中：大图溢出 flex 容器时起始边会滚不到。
    // 改用 img 的 margin:auto 居中，溢出后四个方向的边缘都能滚动/拖到。
    var viewport = document.createElement('div');
    viewport.style.cssText =
      'position:absolute;top:0;left:0;right:0;bottom:0;overflow:auto;display:flex;cursor:zoom-out;' +
      // 左侧为缩略图栏预留空间（窄栏 110 + 间距），展开时由切换按钮改为 296px
      (images.length > 1 ? 'padding-left:124px;transition:padding .18s ease;' : '');

    var img = document.createElement('img');
    img.style.cssText =
      'max-width:92vw;max-height:82vh;border-radius:6px;flex:none;margin:auto;' +
      'box-shadow:0 8px 40px rgba(0,0,0,0.5);user-select:none;-webkit-user-drag:none;';

    var failTip = document.createElement('div');
    failTip.style.cssText =
      'color:rgba(255,255,255,0.85);font-size:14px;display:none;position:absolute;' +
      'top:50%;left:50%;transform:translate(-50%,-50%);';
    failTip.textContent = '图片加载失败';

    viewport.appendChild(img);
    viewport.appendChild(failTip);

    // ===== 底部说明 =====
    var caption = document.createElement('div');
    caption.style.cssText =
      'position:fixed;bottom:18px;left:50%;transform:translateX(-50%);z-index:' + (Z + 1) + ';' +
      'max-width:70vw;color:rgba(255,255,255,0.7);font-size:12px;text-align:center;word-break:break-all;';

    // ===== 左侧缩略图栏（多于 1 张时显示）=====
    // 默认一列（窄），点头部按钮展开为三列（宽）；缩略图完整居中，不裁切。
    var thumbBtns = [];
    var rail = null;
    var railScroll = null;
    var expanded = false;
    if (images.length > 1) {
      rail = document.createElement('div');
      rail.style.cssText =
        'position:fixed;left:14px;top:76px;bottom:76px;width:110px;z-index:' + (Z + 1) + ';' +
        'display:flex;flex-direction:column;gap:6px;padding:7px;' +
        'background:rgba(20,20,20,0.6);border:1px solid rgba(255,255,255,0.1);' +
        'border-radius:14px;backdrop-filter:blur(8px);transition:width .18s ease;';

      // 头部：张数 + 展开/收起按钮
      var railHeader = document.createElement('div');
      railHeader.style.cssText = 'flex:none;display:flex;align-items:center;justify-content:space-between;gap:4px;padding:0 2px;';
      var railTitle = document.createElement('span');
      railTitle.style.cssText = 'font-size:11px;color:rgba(255,255,255,0.6);';
      railTitle.textContent = images.length + ' 张';
      var railToggle = document.createElement('button');
      railToggle.type = 'button';
      railToggle.title = '展开多列';
      railToggle.style.cssText =
        'flex:none;width:24px;height:24px;padding:0;border:none;border-radius:6px;' +
        'background:transparent;color:rgba(255,255,255,0.7);cursor:pointer;display:flex;align-items:center;justify-content:center;';
      railToggle.addEventListener('mouseenter', function() {
        railToggle.style.background = 'rgba(255,255,255,0.12)';
        railToggle.style.color = '#fff';
      });
      railToggle.addEventListener('mouseleave', function() {
        railToggle.style.background = 'transparent';
        railToggle.style.color = 'rgba(255,255,255,0.7)';
      });
      var ICON_EXPAND =
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 17 5-5-5-5"/><path d="m13 17 5-5-5-5"/></svg>';
      var ICON_COLLAPSE =
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m11 17-5-5 5-5"/><path d="m18 17-5-5 5-5"/></svg>';
      railToggle.innerHTML = ICON_EXPAND;
      railToggle.addEventListener('click', function(e) {
        e.stopPropagation();
        expanded = !expanded;
        rail.style.width = expanded ? '282px' : '110px';
        railToggle.innerHTML = expanded ? ICON_COLLAPSE : ICON_EXPAND;
        railToggle.title = expanded ? '收起为一列' : '展开多列';
        viewport.style.paddingLeft = expanded ? '296px' : '124px';
        setTimeout(followThumb, 200);
      });
      railHeader.appendChild(railTitle);
      railHeader.appendChild(railToggle);

      // 滚动区：窄态单列居中，宽态三列换行
      railScroll = document.createElement('div');
      railScroll.style.cssText =
        'flex:1;min-height:0;overflow-y:auto;display:flex;flex-wrap:wrap;gap:6px;' +
        'justify-content:center;align-content:flex-start;scrollbar-width:none;';

      images.forEach(function(im, k) {
        var tb = document.createElement('button');
        tb.type = 'button';
        tb.title = im.alt || ('第 ' + (k + 1) + ' 张');
        tb.style.cssText =
          'flex:none;width:80px;height:56px;padding:0;border:none;border-radius:8px;overflow:hidden;' +
          'background:rgba(255,255,255,0.08);cursor:pointer;outline:2px solid transparent;outline-offset:-2px;' +
          'transition:outline-color .12s;display:flex;align-items:center;justify-content:center;';
        var ti = document.createElement('img');
        ti.src = im.currentSrc || im.src;
        ti.loading = 'lazy';
        ti.decoding = 'async';
        ti.alt = '';
        // contain：完整图片居中显示，不裁切边缘
        ti.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block;';
        // 失效不清空：替换为占位图标，按钮保留位置且可点击（点击后主区显示加载失败）
        ti.addEventListener('error', function() {
          tb.innerHTML =
            '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
            'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="color:rgba(255,255,255,0.32)">' +
            '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/>' +
            '<path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"/><line x1="21" y1="3" x2="3" y2="21"/></svg>';
        });
        tb.appendChild(ti);
        // 点缩略图始终切换预览；勾选只能点右上角圆圈
        tb.addEventListener('click', function(e) { e.stopPropagation(); showAt(k); });
        railScroll.appendChild(tb);
        thumbBtns.push(tb);
      });

      rail.appendChild(railHeader);
      rail.appendChild(railScroll);
    }

    // ===== 原图地址条（点击链接按钮展开）=====
    var urlBar = document.createElement('div');
    urlBar.style.cssText =
      'position:fixed;top:64px;left:50%;transform:translateX(-50%);z-index:' + (Z + 2) + ';display:none;';
    var urlInput = document.createElement('input');
    urlInput.type = 'text';
    urlInput.readOnly = true;
    urlInput.style.cssText =
      'width:560px;max-width:60vw;padding:8px 12px;font-size:12px;font-family:"Geist Mono","SF Mono",Consolas,monospace;' +
      'color:rgba(255,255,255,0.9);background:rgba(20,20,20,0.92);' +
      'border:1px solid rgba(255,255,255,0.18);border-radius:10px;box-shadow:0 4px 20px rgba(0,0,0,0.4);';
    urlInput.addEventListener('focus', function() { urlInput.select(); });
    urlInput.addEventListener('click', function() { urlInput.select(); });
    urlBar.appendChild(urlInput);

    // ===== 下载面板（点击下载按钮展开）：当前张 / 指定范围 / 全部 =====
    var dlPanel = document.createElement('div');
    dlPanel.style.cssText =
      'position:fixed;top:64px;left:50%;transform:translateX(-50%);z-index:' + (Z + 2) + ';display:none;' +
      'width:236px;padding:12px;background:rgba(20,20,20,0.94);' +
      'border:1px solid rgba(255,255,255,0.15);border-radius:14px;box-shadow:0 4px 20px rgba(0,0,0,0.4);';

    var dlCurrentBtn = document.createElement('button');
    dlCurrentBtn.type = 'button';
    dlCurrentBtn.style.cssText =
      'width:100%;padding:9px;border:none;border-radius:10px;background:#0a0a0a;color:#fafafa;' +
      'font-family:inherit;font-size:13px;font-weight:500;cursor:pointer;';
    dlCurrentBtn.textContent = '下载本张';
    dlCurrentBtn.addEventListener('click', function() {
      startDownload([{ url: currentSrc(), name: fileNameBase(index) }]);
    });

    // 下载指定：进入勾选模式（缩略图直接勾选），仅多于 1 张时有意义
    var dlSelectBtn = document.createElement('button');
    dlSelectBtn.type = 'button';
    dlSelectBtn.style.cssText =
      'width:100%;margin:10px 0;padding:9px;border:none;border-radius:10px;background:rgba(255,255,255,0.1);color:#fff;' +
      'font-family:inherit;font-size:13px;font-weight:500;cursor:pointer;';
    dlSelectBtn.textContent = '下载指定（勾选）';
    if (!rail) dlSelectBtn.style.display = 'none';
    dlSelectBtn.addEventListener('click', enterSelectMode);

    var dlAllBtn = document.createElement('button');
    dlAllBtn.type = 'button';
    dlAllBtn.style.cssText =
      'width:100%;padding:9px;border:none;border-radius:10px;background:rgba(255,255,255,0.1);color:#fff;' +
      'font-family:inherit;font-size:13px;font-weight:500;cursor:pointer;';
    dlAllBtn.addEventListener('click', function() {
      startDownload(images.map(function(_, k) {
        return { url: images[k].currentSrc || images[k].src, name: fileNameBase(k) };
      }));
    });

    dlPanel.appendChild(dlCurrentBtn);
    dlPanel.appendChild(dlSelectBtn);
    dlPanel.appendChild(dlAllBtn);

    overlay.appendChild(viewport);
    overlay.appendChild(rail);
    overlay.appendChild(toolbar);
    overlay.appendChild(urlBar);
    overlay.appendChild(dlPanel);
    overlay.appendChild(closeBtn);
    overlay.appendChild(caption);
    document.body.appendChild(overlay);
    requestAnimationFrame(function() { overlay.style.opacity = '1'; });

    // token 标识当前显示请求：快速切换时，过期的 load/error 事件一律忽略，
    // 避免旧图事件把状态覆盖掉
    var token = 0;
    img.addEventListener('error', function() {
      if (img.dataset.token !== String(token)) return;
      failTip.style.display = 'block';
      img.style.visibility = 'hidden';
    });
    img.addEventListener('load', function() {
      if (img.dataset.token !== String(token)) return;
      failTip.style.display = 'none';
      img.style.visibility = '';
    });

    function currentSrc() {
      return images[index].currentSrc || images[index].src;
    }

    function showAt(i) {
      var n = images.length;
      index = (i + n) % n;

      // 立即进入空白态：先重置 src 再赋新值，新图加载失败时不会残留上一张；
      // 同一 URL 也会重新触发 load/error
      token++;
      img.dataset.token = token;
      img.style.visibility = 'hidden';
      failTip.style.display = 'none';
      img.removeAttribute('src');
      img.src = currentSrc();

      caption.textContent = images[index].alt || '';
      caption.style.display = images[index].alt ? 'block' : 'none';
      counter.textContent = (index + 1) + ' / ' + n;
      dlAllBtn.textContent = '下载全部 ' + n + ' 张';
      prevBtn.disabled = nextBtn.disabled = n <= 1;
      prevBtn.style.opacity = nextBtn.style.opacity = n <= 1 ? '0.35' : '1';
      prevBtn.style.pointerEvents = nextBtn.style.pointerEvents = n <= 1 ? 'none' : 'auto';
      dirBtn.style.display = repoDirUrl(images[index]) ? '' : 'none';

      // 地址条展开着则同步为当前图片地址
      if (urlBar.style.display !== 'none') urlInput.value = currentSrc();

      // 勾选模式下保留各项的勾选描边，不跟随当前预览项
      if (!selectMode) followThumb();
      zoomFit();
    }

    // 缩略图栏：高亮当前项（透明描边切换不引起布局位移），并在滚动区内跟随；
    // 不用 scrollIntoView，避免连带滚动背景页面
    function followThumb() {
      if (!rail) return;
      thumbBtns.forEach(function(t, k) {
        t.style.outlineColor = k === index ? '#ffffff' : 'transparent';
      });
      var cur = thumbBtns[index];
      var top = cur.offsetTop, bottom = top + cur.offsetHeight;
      if (top < railScroll.scrollTop) railScroll.scrollTop = top;
      else if (bottom > railScroll.scrollTop + railScroll.clientHeight) {
        railScroll.scrollTop = bottom - railScroll.clientHeight;
      }
    }

    // 缩放锚点：记录最近一次鼠标位置，默认视口中心
    var lastMouse = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    overlay.addEventListener('mousemove', function(e) {
      lastMouse = { x: e.clientX, y: e.clientY };
    });

    function applyZoom() {
      if (zoom === null) {
        img.style.width = '';
        img.style.maxWidth = '92vw';
        img.style.maxHeight = '82vh';
        img.style.cursor = 'zoom-out';
        zoomLabel.textContent = '适应';
      } else {
        img.style.maxWidth = 'none';
        img.style.maxHeight = 'none';
        img.style.width = (baseWidth * zoom) + 'px';
        img.style.cursor = 'grab';
        zoomLabel.textContent = Math.round(zoom * 100) + '%';
      }
    }
    // 以鼠标位置为锚点缩放：缩放后光标下的图片点直接移动到视口中心，
    // 无需再手动拖动（滚动到物理极限时浏览器自动钳制，如缩小后图片小于视口）。
    function zoomAnchored(mult, ev) {
      var anchor = ev ? { x: ev.clientX, y: ev.clientY } : lastMouse;
      var oldRect = img.getBoundingClientRect();
      if (zoom === null) {
        baseWidth = oldRect.width || baseWidth;
        zoom = 1;
      }

      // 光标在图片中的相对位置（超出图片则夹到边缘）
      var fx = Math.min(1, Math.max(0, (anchor.x - oldRect.left) / oldRect.width));
      var fy = Math.min(1, Math.max(0, (anchor.y - oldRect.top) / oldRect.height));

      zoom = Math.min(8, Math.max(0.1, zoom * mult));
      applyZoom();

      // 布局后调整滚动，使该图片点位于可视内容区正中心
      // （左侧有缩略图栏占位时，内容中心随 paddingLeft 右移）
      var newRect = img.getBoundingClientRect();
      var pointX = newRect.left + fx * newRect.width;
      var pointY = newRect.top + fy * newRect.height;
      var padL = parseFloat(viewport.style.paddingLeft) || 0;
      viewport.scrollLeft += pointX - (viewport.clientWidth + padL) / 2;
      viewport.scrollTop += pointY - viewport.clientHeight / 2;
    }
    function zoomIn() { zoomAnchored(1.25); }
    function zoomOut() { zoomAnchored(1 / 1.25); }
    function zoomFit() {
      zoom = null;
      applyZoom();
    }
    function openExternal() {
      window.open(currentSrc(), '_blank', 'noopener');
    }

    // 定位到原图在页面中的位置：关闭浮层、平滑滚动到该图、红色高亮闪烁提示
    function locateOriginal() {
      var target = images[index];
      close();
      try {
        target.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
      } catch (e) {
        target.scrollIntoView();
      }

      var prevOutline = target.style.outline;
      var prevOffset = target.style.outlineOffset;
      var prevShadow = target.style.boxShadow;
      target.style.transition = 'outline-color .3s, box-shadow .3s';
      target.style.outline = '3px solid #e7000b';
      target.style.outlineOffset = '2px';
      target.style.boxShadow = '0 0 0 6px rgba(231,0,11,0.22), 0 0 24px rgba(231,0,11,0.35)';
      setTimeout(function() {
        target.style.outline = prevOutline;
        target.style.outlineOffset = prevOffset;
        target.style.boxShadow = prevShadow;
        setTimeout(function() { target.style.transition = ''; }, 400);
      }, 2200);
    }

    // 查看原图地址：展开/收起地址条（与下载面板互斥）
    function toggleUrlBar() {
      var showing = urlBar.style.display !== 'none';
      dlPanel.style.display = 'none';
      if (showing) {
        urlBar.style.display = 'none';
      } else {
        urlInput.value = currentSrc();
        urlBar.style.display = 'block';
        urlInput.focus();
        urlInput.select();
      }
    }

    // 轻量提示条
    function showToast(message, ok) {
      var t = document.createElement('div');
      t.textContent = message;
      t.style.cssText =
        'position:fixed;bottom:64px;left:50%;transform:translateX(-50%);z-index:' + (Z + 2) + ';' +
        'background:rgba(20,20,20,0.92);color:' + (ok === false ? '#ff6b6b' : '#fff') +
        'font-size:13px;padding:9px 18px;border-radius:10px;' +
        'border:1px solid rgba(255,255,255,0.15);box-shadow:0 4px 20px rgba(0,0,0,0.4);';
      overlay.appendChild(t);
      setTimeout(function() { if (t.parentNode) t.remove(); }, 1800);
    }

    // 复制到剪贴板：安全上下文用 Clipboard API，http 页面降级到 execCommand
    function writeClipboard(text) {
      if (navigator.clipboard && window.isSecureContext) {
        return navigator.clipboard.writeText(text).then(function() { return true; }, function() {
          return fallbackCopy(text);
        });
      }
      return Promise.resolve(fallbackCopy(text));
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

    function copySrc() {
      writeClipboard(currentSrc()).then(function(ok) {
        showToast(ok ? '原图地址已复制' : '复制失败，请手动查看地址', ok);
        if (ok) {
          copyBtn.innerHTML = ICONS.check;
          copyBtn.querySelector('svg').style.display = 'block';
          setTimeout(function() {
            copyBtn.innerHTML = ICONS.copy;
            copyBtn.querySelector('svg').style.display = 'block';
          }, 1400);
        }
      });
    }

    /* ===== 下载：文件名 / 面板切换 / 范围 / 批量 + 进度 ===== */

    // 生成下载文件名基础：两位序号前缀 + 清洗后的原文件名；
    // URL 里没有可用文件名（如 camo 代理）用 image-序号；扩展名由后台按 Content-Type 补全
    function fileNameBase(k) {
      var url = images[k].currentSrc || images[k].src;
      var seg = (url.split(/[?#]/)[0].split('/').pop() || '');
      if (!/\.[a-z0-9]{2,5}$/i.test(seg)) seg = 'image-' + (k + 1);
      seg = seg.replace(/[^\w.\-]+/g, '_').slice(0, 80);
      return String(k + 1).padStart(2, '0') + '-' + seg;
    }

    function toggleDownloadPanel() {
      var showing = dlPanel.style.display !== 'none';
      urlBar.style.display = 'none';
      dlPanel.style.display = showing ? 'none' : 'block';
    }

    /* ===== 勾选模式：缩略图直接勾选，支持全选/清空，下载选中项 ===== */

    var selectMode = false;
    var picked = {};
    var pickBar = null;
    var ICON_CHECK =
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

    // 每个缩略图上的勾选角标
    thumbBtns.forEach(function(tb, k) {
      var mark = document.createElement('span');
      mark.style.cssText =
        'position:absolute;top:4px;right:4px;width:20px;height:20px;border-radius:50%;' +
        'background:rgba(0,0,0,0.55);border:1.5px solid rgba(255,255,255,0.75);color:#fff;cursor:pointer;' +
        'display:none;align-items:center;justify-content:center;z-index:2;';
      tb.style.position = 'relative';
      // 点圆圈只切换勾选，不触发缩略图的预览切换
      mark.addEventListener('click', function(e) {
        e.stopPropagation();
        e.preventDefault();
        togglePick(k);
      });
      tb.appendChild(mark);
      tb._pickMark = mark;
    });

    function enterSelectMode() {
      selectMode = true;
      picked = {};
      dlPanel.style.display = 'none';
      thumbBtns.forEach(function(tb, k) {
        tb._pickMark.style.display = 'flex';
        tb.style.outlineColor = 'transparent';
      });
      pickBar = makePickBar();
    }
    function exitSelectMode() {
      selectMode = false;
      picked = {};
      thumbBtns.forEach(function(tb, k) {
        tb._pickMark.style.display = 'none';
        tb._pickMark.style.background = 'rgba(0,0,0,0.55)';
      });
      if (pickBar) { pickBar.remove(); pickBar = null; }
      followThumb(); // 恢复当前图片的高亮
    }
    function togglePick(k) {
      picked[k] = !picked[k];
      var mark = thumbBtns[k]._pickMark;
      mark.innerHTML = picked[k] ? ICON_CHECK : '';
      mark.style.background = picked[k] ? '#0a0a0a' : 'rgba(0,0,0,0.55)';
      thumbBtns[k].style.outlineColor = picked[k] ? 'rgba(255,255,255,0.7)' : 'transparent';
      updatePickBar();
    }
    function pickedList() {
      return Object.keys(picked).filter(function(k) { return picked[k]; }).map(Number);
    }
    function makePickBar() {
      var bar = document.createElement('div');
      bar.style.cssText =
        'position:fixed;bottom:56px;left:50%;transform:translateX(-50%);z-index:' + (Z + 2) + ';' +
        'display:flex;align-items:center;gap:8px;padding:7px 9px;background:rgba(20,20,20,0.94);' +
        'border:1px solid rgba(255,255,255,0.15);border-radius:14px;box-shadow:0 4px 20px rgba(0,0,0,0.4);';
      function pbtn(text, primary, handler) {
        var b = document.createElement('button');
        b.type = 'button';
        b.textContent = text;
        b.style.cssText =
          'padding:8px 14px;border:none;border-radius:10px;font-family:inherit;font-size:13px;font-weight:500;cursor:pointer;' +
          (primary ? 'background:#0a0a0a;color:#fafafa;' : 'background:rgba(255,255,255,0.1);color:#fff;');
        b.addEventListener('click', handler);
        bar.appendChild(b);
        return b;
      }
      pbtn('全选', false, function() {
        thumbBtns.forEach(function(_, k) { if (!picked[k]) togglePick(k); });
      });
      pbtn('清空', false, function() {
        thumbBtns.forEach(function(_, k) { if (picked[k]) togglePick(k); });
      });
      bar._download = pbtn('下载选中（0）', true, function() {
        var ks = pickedList();
        if (!ks.length) return;
        var items = ks.map(function(k) {
          return { url: images[k].currentSrc || images[k].src, name: fileNameBase(k) };
        });
        exitSelectMode();
        startDownload(items);
      });
      pbtn('取消', false, exitSelectMode);
      overlay.appendChild(bar);
      return bar;
    }
    function updatePickBar() {
      pickBar._download.textContent = '下载选中（' + pickedList().length + '）';
    }

    var progCard = null;
    function startDownload(items) {
      dlPanel.style.display = 'none';
      progCard = makeProgressCard();
      updateProgress(0, items.length);
      chrome.runtime.sendMessage({ action: 'downloadImages', items: items }, function(res) {
        if (chrome.runtime.lastError) {
          if (progCard && progCard.parentNode) progCard.remove();
          progCard = null;
          showToast('下载失败：' + chrome.runtime.lastError.message, false);
          return;
        }
        finishProgress(res);
      });
    }

    // 后台逐张回传进度
    chrome.runtime.onMessage.addListener(function(msg) {
      if (msg.action === 'downloadProgress' && progCard) {
        updateProgress(msg.done, msg.total);
      }
    });

    function makeProgressCard() {
      var card = document.createElement('div');
      card.style.cssText =
        'position:fixed;bottom:64px;left:50%;transform:translateX(-50%);z-index:' + (Z + 2) + ';' +
        'min-width:210px;padding:12px 18px;background:rgba(20,20,20,0.94);color:#fff;font-size:13px;' +
        'border:1px solid rgba(255,255,255,0.15);border-radius:12px;' +
        'box-shadow:0 4px 20px rgba(0,0,0,0.4);text-align:center;';
      var txt = document.createElement('div');
      var barWrap = document.createElement('div');
      barWrap.style.cssText = 'margin-top:8px;height:4px;border-radius:2px;background:rgba(255,255,255,0.12);overflow:hidden;';
      var bar = document.createElement('div');
      bar.style.cssText = 'height:100%;width:0%;background:#fff;border-radius:2px;transition:width .2s;';
      barWrap.appendChild(bar);
      card.appendChild(txt);
      card.appendChild(barWrap);
      card._txt = txt;
      card._bar = bar;
      overlay.appendChild(card);
      return card;
    }
    function updateProgress(done, total) {
      progCard._txt.textContent = '正在下载 ' + done + ' / ' + total;
      progCard._bar.style.width = (total ? Math.round(done / total * 100) : 0) + '%';
    }
    function finishProgress(res) {
      if (!progCard) return;
      progCard._txt.textContent =
        '下载完成：成功 ' + res.ok + ' 张' + (res.fail ? '，失败 ' + res.fail + ' 张' : '');
      progCard._bar.style.width = '100%';
      var card = progCard;
      setTimeout(function() { if (card.parentNode) card.remove(); }, 2600);
      progCard = null;
      if (res.fail) showToast('部分图片下载失败，可能已失效', false);
    }

    // 滚轮缩放（以滚轮时的光标位置为锚点）
    viewport.addEventListener('wheel', function(e) {
      e.preventDefault();
      zoomAnchored(e.deltaY < 0 ? 1.25 : 1 / 1.25, e);
    }, { passive: false });

    // 拖动平移（放大后）：在图片上按下启动；增量跟随鼠标。
    // 鼠标贴近视口边缘时自动持续平移，解决鼠标到屏幕边缘后无法继续拖动的问题。
    var dragging = false;
    var EDGE = 70;         // 触发自动平移的边缘带宽
    var PAN_SPEED = 18;     // 边缘处每帧平移像素
    var rafId = 0;
    img.addEventListener('mousedown', function(e) {
      if (e.button !== 0) return;
      dragging = true;
      img.style.cursor = 'grabbing';
      e.preventDefault();
      rafId = requestAnimationFrame(panLoop);
    });
    window.addEventListener('mousemove', function(e) {
      if (!dragging) return;
      lastMouse = { x: e.clientX, y: e.clientY };
      viewport.scrollLeft -= e.movementX || 0;
      viewport.scrollTop -= e.movementY || 0;
    });
    function endDrag() {
      if (!dragging) return;
      dragging = false;
      cancelAnimationFrame(rafId);
      img.style.cursor = zoom === null ? 'zoom-out' : 'grab';
    }
    window.addEventListener('mouseup', endDrag);
    window.addEventListener('blur', endDrag);
    function panLoop() {
      if (!dragging) return;
      var vw = viewport.clientWidth, vh = viewport.clientHeight;
      var px = 0, py = 0;
      if (lastMouse.x < EDGE) px = (lastMouse.x - EDGE) / EDGE;
      else if (lastMouse.x > vw - EDGE) px = (lastMouse.x - (vw - EDGE)) / EDGE;
      if (lastMouse.y < EDGE) py = (lastMouse.y - EDGE) / EDGE;
      else if (lastMouse.y > vh - EDGE) py = (lastMouse.y - (vh - EDGE)) / EDGE;
      viewport.scrollLeft += px * PAN_SPEED;
      viewport.scrollTop += py * PAN_SPEED;
      rafId = requestAnimationFrame(panLoop);
    }

    // 点击空白处关闭（图片/工具栏上的点击不关）
    viewport.addEventListener('click', function(e) {
      if (e.target === viewport) close();
    });
    closeBtn.addEventListener('click', close);

    function onKeydown(e) {
      switch (e.key) {
        // 勾选模式下 ESC 先退出勾选，不直接关闭浮层
        case 'Escape':
          e.preventDefault(); e.stopPropagation();
          if (selectMode) exitSelectMode(); else close();
          break;
        case 'ArrowLeft': showAt(index - 1); break;
        case 'ArrowRight': showAt(index + 1); break;
        case '+': case '=': zoomIn(); break;
        case '-': case '_': zoomOut(); break;
        case '0': zoomFit(); break;
        default: return;
      }
      e.preventDefault();
    }
    document.addEventListener('keydown', onKeydown, true);

    function close() {
      overlay.remove();
      document.documentElement.style.overflow = prevOverflow;
      document.removeEventListener('keydown', onKeydown, true);
      // hover 模式：关闭后短暂抑制，鼠标还停在原图上时不会立刻重弹
      clearTimeout(hoverTimer);
      hoverSuppressUntil = Date.now() + 1500;
    }

    showAt(index);
  }

  // ===== hover 模式：悬停延时自动打开 =====
  var HOVER_DELAY = 600;
  var hoverTimer = 0;
  var hoverEl = null;
  var hoverSuppressUntil = 0; // 关闭浮层后的短暂抑制期，防止立刻重弹

  function hoverable(t) {
    if (!t || t.tagName !== 'IMG') return false;
    if (isEmoji(t) || isInteractive(t)) return false;
    if (Math.max(t.offsetWidth, t.offsetHeight) < 24) return false;
    var a = t.closest('a');
    return !a || isImageLink(a);
  }

  document.addEventListener('mouseover', function(e) {
    if (triggerMode !== 'hover' || !siteActive()) return;
    if (document.getElementById(OVERLAY_ID)) return; // 浮层已打开，不再触发
    if (!hoverable(e.target)) return;
    clearTimeout(hoverTimer);
    hoverEl = e.target;
    hoverTimer = setTimeout(function() {
      if (triggerMode !== 'hover' || !siteActive() || Date.now() < hoverSuppressUntil) return;
      if (document.getElementById(OVERLAY_ID)) return;
      var images = collectImages();
      var idx = images.indexOf(hoverEl);
      if (idx === -1) { images = [hoverEl]; idx = 0; }
      hoverSuppressUntil = Date.now() + 2000; // 关闭后 2 秒内重入不弹
      openViewer(images, idx);
    }, HOVER_DELAY);
  }, true);

  document.addEventListener('mouseout', function(e) {
    if (e.target === hoverEl) {
      clearTimeout(hoverTimer);
      hoverEl = null;
    }
  }, true);

  // 事件委托：捕获阶段拦截，兼容各站点的局部导航动态内容
  document.addEventListener('click', function(e) {
    if (!siteActive()) return;
    // click 模式：普通左键单击即预览；modifier 模式：需按住 Alt
    if (triggerMode !== 'click' && triggerMode !== 'modifier') return;
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    if (triggerMode === 'modifier' && !e.altKey) return;
    if (triggerMode === 'click' && e.altKey) return; // click 模式 Alt+点击保持原生

    var target = e.target;
    if (!target || target.tagName !== 'IMG') return;
    if (isEmoji(target) || isInteractive(target)) return;
    if (Math.max(target.offsetWidth, target.offsetHeight) < 24) return;

    var anchor = target.closest('a');
    if (anchor && !isImageLink(anchor)) return;

    e.preventDefault();
    e.stopPropagation();

    var images = collectImages();
    var idx = images.indexOf(target);
    if (idx === -1) {
      images = [target];
      idx = 0;
    }
    openViewer(images, idx);
  }, true);
})();
