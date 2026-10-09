/**
 * 二维码识别 - 后台脚本
 * 功能：右键识别网页中的二维码图片（支持 img 和 canvas）
 * 也可通过 popup 按钮触发选择模式
 */

// 创建右键菜单
function createContextMenu() {
  chrome.contextMenus.removeAll(function() {
    chrome.contextMenus.create({
      id: 'scan-qr',
      title: '识别二维码',
      contexts: ['all']
    });
    // 图片预览手动入口：右键图片 → 预览（任何触发模式下都可用）
    chrome.contextMenus.create({
      id: 'preview-image',
      title: '预览图片',
      contexts: ['image']
    });
  });
}

chrome.runtime.onInstalled.addListener(createContextMenu);
createContextMenu();

// 右键菜单点击
chrome.contextMenus.onClicked.addListener(function(info, tab) {
  if (info.menuItemId === 'preview-image') {
    // 通知 content script 打开预览（找不到原图时由其按单图处理）
    chrome.tabs.sendMessage(tab.id, { action: 'previewImage', srcUrl: info.srcUrl || null })
      .catch(function() {});
    return;
  }
  injectScanner(tab.id, info.srcUrl || null);
});

// Popup 按钮触发：进入选择模式；图片下载（单张/批量）
chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
  if (msg.action === 'scanQR') {
    chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
      if (tabs[0]) {
        injectScanner(tabs[0].id, null);
      }
    });
  } else if (msg.action === 'downloadImages') {
    var tabId = sender.tab ? sender.tab.id : null;
    downloadAll(msg.items, tabId).then(function(r) { sendResponse(r); });
    return true; // 异步响应
  }
});

/* ===== 图片下载（content script 发起，后台串行执行）===== */

var EXT_BY_TYPE = {
  'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png',
  'image/gif': '.gif', 'image/webp': '.webp', 'image/bmp': '.bmp',
  'image/avif': '.avif', 'image/svg+xml': '.svg', 'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico'
};

function extFromType(type) {
  type = (type || '').split(';')[0].trim().toLowerCase();
  return EXT_BY_TYPE[type] || '';
}

function extFromUrl(url) {
  var path = (url || '').split(/[?#]/)[0];
  var m = path.match(/\.(jpe?g|png|gif|webp|bmp|avif|svg|ico)$/i);
  return m ? '.' + m[1].toLowerCase().replace('jpeg', 'jpg') : '';
}

function chromeDownload(url, filename) {
  return new Promise(function(resolve, reject) {
    chrome.downloads.download(
      { url: url, filename: filename, conflictAction: 'uniquify' },
      function(id) {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(id);
      }
    );
  });
}

// 下载单张：后台 fetch 无 CORS 限制，可拿到真实 Content-Type 补扩展名；
// 优先用 blob URL（避免二次请求），不支持时降级为浏览器直接下载原始 URL
function downloadOne(url, nameBase) {
  var blob = null, type = '';
  return fetch(url, { credentials: 'include' }).then(function(res) {
    if (!res.ok) return;
    type = res.headers.get('content-type') || '';
    return res.blob().then(function(b) { blob = b; });
  }).catch(function() {}).then(function() {
    var filename;
    if (/\.[a-z0-9]{2,5}$/i.test(nameBase)) {
      filename = nameBase;
    } else {
      filename = nameBase + (extFromType(type) || extFromUrl(url) || '');
    }

    if (blob && typeof URL.createObjectURL === 'function') {
      var blobUrl = URL.createObjectURL(blob);
      return chromeDownload(blobUrl, filename).then(function() {
        setTimeout(function() { try { URL.revokeObjectURL(blobUrl); } catch (e) {} }, 120000);
      }).catch(function() {
        return chromeDownload(url, filename);
      });
    }
    return chromeDownload(url, filename);
  });
}

// 串行下载全部，逐张回传进度
function downloadAll(items, tabId) {
  var ok = 0, fail = 0;
  var p = Promise.resolve();
  items.forEach(function(item, i) {
    p = p.then(function() {
      return downloadOne(item.url, item.name).then(function() { ok++; }, function() { fail++; });
    }).then(function() {
      if (tabId == null) return;
      return chrome.tabs.sendMessage(tabId, {
        action: 'downloadProgress', done: i + 1, total: items.length, ok: ok, fail: fail
      }).catch(function() {});
    });
  });
  return p.then(function() { return { ok: ok, fail: fail }; });
}

// 注入 jsQR 库 + 扫描逻辑到目标页面
function injectScanner(tabId, srcUrl) {
  chrome.scripting.executeScript({
    target: { tabId: tabId },
    files: ['jsQR.js']
  }, function() {
    if (chrome.runtime.lastError) {
      console.error('注入 jsQR 失败:', chrome.runtime.lastError);
      return;
    }
    chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: scanInPage,
      args: [srcUrl]
    });
  });
}

/**
 * 以下函数注入页面执行：处理二维码识别与结果展示
 */
function scanInPage(srcUrl) {
  var oldOverlay = document.getElementById('qr-scanner-overlay');
  if (oldOverlay) oldOverlay.remove();

  function showToast(message) {
    var toast = document.createElement('div');
    toast.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:rgba(0,0,0,0.8);color:#fff;padding:12px 20px;border-radius:8px;font-family:Arial,sans-serif;font-size:14px;z-index:9999999;white-space:nowrap;';
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(function() { if (toast.parentNode) toast.remove(); }, 2000);
  }

  function handleResult(code) {
    if (!code || !code.data) {
      showToast('未能识别到二维码');
      return;
    }

    var data = code.data;
    var isLink = data.indexOf('http://') === 0 || data.indexOf('https://') === 0;

    var modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);z-index:1000001;display:flex;align-items:center;justify-content:center;';

    var box = document.createElement('div');
    box.style.cssText = 'background:#fff;border-radius:8px;padding:24px;max-width:80%;max-height:80%;overflow:auto;font-family:Arial,sans-serif;';

    var escapedData = data.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    box.innerHTML =
      '<h3 style="margin-top:0;">二维码内容：</h3>' +
      '<div style="background:#f5f5f5;padding:12px;border-radius:4px;margin:16px 0;word-break:break-all;white-space:pre-wrap;">' + escapedData + '</div>' +
      (isLink ? '<button id="qr-go-btn" style="background:#007bff;color:#fff;border:none;padding:10px 20px;border-radius:4px;cursor:pointer;font-size:14px;">打开链接</button>' : '') +
      '<button id="qr-close-btn" style="' + (isLink ? 'margin-left:10px;' : '') + 'background:#ccc;color:#000;border:none;padding:10px 20px;border-radius:4px;cursor:pointer;font-size:14px;">关闭</button>';

    modal.appendChild(box);
    document.body.appendChild(modal);

    modal.addEventListener('click', function(e) {
      if (e.target === modal) modal.remove();
    });
    document.getElementById('qr-close-btn').addEventListener('click', function() { modal.remove(); });

    if (isLink) {
      document.getElementById('qr-go-btn').addEventListener('click', function() {
        window.open(data, '_blank');
        modal.remove();
      });
    }

    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') {
        modal.remove();
        document.removeEventListener('keydown', esc);
      }
    });
  }

  function scanElement(el) {
    if (!el) {
      showToast('未能识别到二维码');
      return;
    }

    if (el.tagName === 'CANVAS') {
      var ctx = el.getContext('2d');
      var imageData = ctx.getImageData(0, 0, el.width, el.height);
      handleResult(jsQR(imageData.data, imageData.width, imageData.height));
    } else if (el.tagName === 'IMG') {
      var canvas = document.createElement('canvas');
      canvas.width = el.naturalWidth || el.width;
      canvas.height = el.naturalHeight || el.height;
      var ctx2 = canvas.getContext('2d');

      try {
        ctx2.drawImage(el, 0, 0);
        var imageData2 = ctx2.getImageData(0, 0, canvas.width, canvas.height);
        handleResult(jsQR(imageData2.data, canvas.width, canvas.height));
      } catch (e) {
        var img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = function() {
          canvas.width = img.width;
          canvas.height = img.height;
          ctx2.drawImage(img, 0, 0);
          var imageData3 = ctx2.getImageData(0, 0, canvas.width, canvas.height);
          handleResult(jsQR(imageData3.data, canvas.width, canvas.height));
        };
        img.onerror = function() { handleResult(null); };
        img.onabort = function() { handleResult(null); };
        img.src = el.src;
      }
    } else {
      showToast('未能识别到二维码');
    }
  }

  function startSelection() {
    var overlay = document.createElement('div');
    overlay.id = 'qr-scanner-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.4);z-index:999999;cursor:crosshair;pointer-events:none;';

    var tip = document.createElement('div');
    tip.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#222;color:#fff;padding:12px 24px;border-radius:6px;z-index:1000000;font-family:Arial,sans-serif;font-size:14px;pointer-events:none;';
    tip.textContent = '点击二维码（图片或canvas），按ESC取消';
    overlay.appendChild(tip);
    document.body.appendChild(overlay);

    function clickHandler(e) {
      e.preventDefault();
      e.stopPropagation();
      document.removeEventListener('click', clickHandler, true);
      document.removeEventListener('keydown', keyHandler, true);
      overlay.remove();
      var el = document.elementFromPoint(e.clientX, e.clientY);
      scanElement(el);
    }

    function keyHandler(e) {
      if (e.key === 'Escape') {
        document.removeEventListener('click', clickHandler, true);
        document.removeEventListener('keydown', keyHandler, true);
        overlay.remove();
      }
    }

    document.addEventListener('click', clickHandler, true);
    document.addEventListener('keydown', keyHandler, true);
  }

  if (srcUrl) {
    var imgs = Array.prototype.slice.call(document.querySelectorAll('img'));
    for (var i = 0; i < imgs.length; i++) {
      if (imgs[i].src === srcUrl) {
        scanElement(imgs[i]);
        return;
      }
    }
    startSelection();
  } else {
    startSelection();
  }
}
