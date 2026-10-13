// 资源预览总开关：首页卡片与二级设置页各有一个，双向同步；
// 图片 / Markdown 等所有就地预览类型共用，content script 实时读取。
// 首次升级时从旧版图片开关（imagePreviewEnabled / ghImagePreviewEnabled）继承一次状态
const previewToggle = document.getElementById('previewToggle');
const previewToggleDetail = document.getElementById('previewToggleDetail');
const previewToggles = [previewToggle, previewToggleDetail];

function applyPreviewState(on) {
  previewToggles.forEach(t => { t.checked = on; });
  document.body.classList.toggle('preview-disabled', !on);
  var stateText = document.getElementById('previewStateText');
  if (stateText) stateText.textContent = on ? '已启用' : '已停用';
}
chrome.storage.local.get(
  ['previewEnabled', 'imagePreviewEnabled', 'ghImagePreviewEnabled'],
  (res) => {
    let on;
    if (res.previewEnabled !== undefined) {
      on = res.previewEnabled;
    } else {
      on = res.imagePreviewEnabled !== undefined
        ? res.imagePreviewEnabled
        : res.ghImagePreviewEnabled !== false;
      chrome.storage.local.set({ previewEnabled: on }); // 固化迁移结果
    }
    applyPreviewState(on);
  }
);
previewToggles.forEach(t => {
  t.addEventListener('change', () => {
    chrome.storage.local.set({ previewEnabled: t.checked });
  });
});
// storage 变化时同步两处（如一处切换、或 content/其他视图改动）
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.previewEnabled) {
    applyPreviewState(changes.previewEnabled.newValue !== false);
  }
});

// 资源预览设置二级页：整卡点击进入 / 返回（与修改 Header 卡片同样的模式）
const previewPanel = document.getElementById('previewSettingsPanel');
const previewEntry = document.getElementById('previewSettingsEntry');
previewEntry.addEventListener('click', () => {
  previewPanel.style.display = 'block';
  document.body.classList.add('preview-settings-open');
});
// 点开关只切换总开关，不进入设置页
document.getElementById('previewSwitchOuter').addEventListener('click', (e) => {
  e.stopPropagation();
});
// div 卡片补回键盘可访问性
previewEntry.addEventListener('keydown', (e) => {
  if (e.target !== e.currentTarget) return;
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    previewEntry.click();
  }
});
document.getElementById('backFromPreviewSettings').addEventListener('click', () => {
  previewPanel.style.display = 'none';
  document.body.classList.remove('preview-settings-open');
});

// 左侧分类导航：打开方式 / 网站名单 / 预览类型，右侧只显示当前分类
const previewNav = document.getElementById('previewNav');
previewNav.querySelectorAll('.ps-nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    const section = btn.dataset.section;
    previewNav.querySelectorAll('.ps-nav-item').forEach((b) => {
      b.classList.toggle('selected', b === btn);
    });
    previewPanel.querySelectorAll('.ps-section').forEach((s) => {
      s.classList.toggle('active', s.dataset.section === section);
    });
  });
});

// ===== 资源预览详细设置：打开方式 / 黑白名单 / 手动添加（对图片与链接资源同时生效）=====
const filterModeSeg = document.getElementById('filterModeSeg');
const blockSiteBtn = document.getElementById('blockSiteBtn');
const currentHostEl = document.getElementById('currentHost');
const addHostInput = document.getElementById('addHostInput');
const addHostBtn = document.getElementById('addHostBtn');
const addHostError = document.getElementById('addHostError');
const blockListCard = document.getElementById('blockListCard');
const blockedListEl = document.getElementById('blockedList');
const listLabel = document.getElementById('listLabel');

let currentHost = '';
let filterMode = 'blacklist';
let blockedSites = [];
let allowedSites = [];

function currentList() {
  return filterMode === 'whitelist' ? allowedSites : blockedSites;
}

// ===== 打开方式（图片与 Markdown / PDF / 音视频 / 文本代码链接共用）=====
const linkTriggerModeList = document.getElementById('linkTriggerModeList');
const hoverDelayRow = document.getElementById('hoverDelayRow');
const longPressDelayRow = document.getElementById('longPressDelayRow');
const linkHoverMsInput = document.getElementById('linkHoverMs');
const linkLongPressMsInput = document.getElementById('linkLongPressMs');

let linkTriggerMode = 'click';
let linkHoverMs = 600;
let linkLongPressMs = 500;

linkTriggerModeList.querySelectorAll('.radio-row').forEach((row) => {
  row.addEventListener('click', () => {
    linkTriggerMode = row.dataset.mode;
    chrome.storage.local.set({ linkTriggerMode });
    renderLinkTriggerRows();
  });
});
function renderLinkTriggerRows() {
  linkTriggerModeList.querySelectorAll('.radio-row').forEach((row) => {
    row.classList.toggle('selected', row.dataset.mode === linkTriggerMode);
  });
  hoverDelayRow.style.display = linkTriggerMode === 'hover' ? 'flex' : 'none';
  longPressDelayRow.style.display = linkTriggerMode === 'longpress' ? 'flex' : 'none';
}

// 延时输入：change 时夹取到 200–3000ms 并保存（content script 实时生效）
function bindDelayInput(input, key, getFallback) {
  input.addEventListener('change', () => {
    let v = parseInt(input.value, 10);
    if (!Number.isFinite(v)) v = getFallback();
    v = Math.max(200, Math.min(3000, v));
    input.value = v;
    chrome.storage.local.set({ [key]: v });
  });
}
bindDelayInput(linkHoverMsInput, 'linkHoverMs', () => linkHoverMs);
bindDelayInput(linkLongPressMsInput, 'linkLongPressMs', () => linkLongPressMs);

// ===== 预览类型：图片 / Markdown / PDF / 音视频 / 文本代码 分别启停（缺省视为开启）=====
const typeSwitches = document.querySelectorAll('#previewTypesCard input[type="checkbox"][data-type]');
let previewTypes = {};
function renderTypeSwitches() {
  typeSwitches.forEach((cb) => { cb.checked = previewTypes[cb.dataset.type] !== false; });
}
typeSwitches.forEach((cb) => {
  cb.addEventListener('change', () => {
    previewTypes[cb.dataset.type] = cb.checked;
    chrome.storage.local.set({ previewTypes });
  });
});

// 名单模式分段切换
filterModeSeg.querySelectorAll('.seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    filterMode = btn.dataset.mode;
    chrome.storage.local.set({ siteFilterMode: filterMode });
    renderFilterSeg();
    renderBlockUI();
  });
});
function renderFilterSeg() {
  filterModeSeg.querySelectorAll('.seg-btn').forEach((btn) => {
    btn.classList.toggle('selected', btn.dataset.mode === filterMode);
  });
}

// 当前网站加入/移出当前名单
blockSiteBtn.addEventListener('click', () => {
  if (currentList().includes(currentHost)) {
    if (filterMode === 'whitelist') allowedSites = allowedSites.filter(h => h !== currentHost);
    else blockedSites = blockedSites.filter(h => h !== currentHost);
  } else {
    if (filterMode === 'whitelist') allowedSites = allowedSites.concat(currentHost);
    else blockedSites = blockedSites.concat(currentHost);
  }
  saveSites().then(renderBlockUI);
});

// 手动添加：接受域名或粘贴完整网址（自动提取主机名）
function parseHost(raw) {
  raw = raw.trim().toLowerCase();
  if (!raw) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(raw)) raw = 'http://' + raw;
  try {
    return new URL(raw).hostname;
  } catch (e) {
    return '';
  }
}
function addManualHost() {
  addHostError.textContent = '';
  const host = parseHost(addHostInput.value);
  if (!host || !/\.[a-z]/.test(host)) {
    addHostError.textContent = '请输入有效域名';
    return;
  }
  if (currentList().includes(host)) {
    addHostError.textContent = '该域名已在列表中';
    return;
  }
  if (filterMode === 'whitelist') allowedSites = allowedSites.concat(host);
  else blockedSites = blockedSites.concat(host);
  addHostInput.value = '';
  saveSites().then(renderBlockUI);
}
addHostBtn.addEventListener('click', addManualHost);
addHostInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addManualHost(); });

function saveSites() {
  return chrome.storage.local.set({ blockedSites, allowedSites });
}
function removeHost(host) {
  if (filterMode === 'whitelist') allowedSites = allowedSites.filter(h => h !== host);
  else blockedSites = blockedSites.filter(h => h !== host);
  saveSites().then(renderBlockUI);
}

async function initPreviewSettings() {
  const tab = await getActiveTab();
  let pageUrl = null;
  try {
    pageUrl = tab.url ? new URL(tab.url) : null;
  } catch (e) {}

  currentHost = pageUrl ? pageUrl.hostname : '';

  const res = await chrome.storage.local.get(
    ['blockedSites', 'allowedSites', 'siteFilterMode',
     'linkTriggerMode', 'linkHoverMs', 'linkLongPressMs', 'previewTypes']
  );
  blockedSites = res.blockedSites || [];
  allowedSites = res.allowedSites || [];
  if (res.siteFilterMode) filterMode = res.siteFilterMode;
  if (res.linkTriggerMode) linkTriggerMode = res.linkTriggerMode;
  if (res.linkHoverMs) linkHoverMs = res.linkHoverMs;
  if (res.linkLongPressMs) linkLongPressMs = res.linkLongPressMs;
  if (res.previewTypes) previewTypes = res.previewTypes;
  linkHoverMsInput.value = linkHoverMs;
  linkLongPressMsInput.value = linkLongPressMs;
  renderTypeSwitches();

  const applicable = !!(pageUrl && /^https?:$/.test(pageUrl.protocol));
  currentHostEl.textContent = applicable ? currentHost : '当前页面不适用';
  blockSiteBtn.disabled = !applicable;

  renderLinkTriggerRows();
  renderFilterSeg();
  renderBlockUI();
}

function renderBlockUI() {
  const isBlack = filterMode === 'blacklist';
  listLabel.textContent = isBlack ? '已屏蔽网站' : '已允许网站';

  const inList = currentList().includes(currentHost);
  blockSiteBtn.textContent = isBlack
    ? (inList ? '取消屏蔽' : '屏蔽此站')
    : (inList ? '取消允许' : '允许此站');
  blockSiteBtn.classList.toggle('blocked', inList);

  const list = currentList();
  blockListCard.style.display = list.length ? 'block' : 'none';
  blockedListEl.innerHTML = '';
  list.forEach((host) => {
    const row = document.createElement('div');
    row.className = 'blocked-item';
    const name = document.createElement('span');
    name.className = 'host-line';
    name.textContent = host;
    const unblock = document.createElement('button');
    unblock.type = 'button';
    unblock.className = 'unblock';
    unblock.title = '移除';
    unblock.textContent = '×';
    unblock.addEventListener('click', () => removeHost(host));
    row.appendChild(name);
    row.appendChild(unblock);
    blockedListEl.appendChild(row);
  });
}

initPreviewSettings();

// 获取当前标签页
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// 查看密码
document.getElementById('showPasswords').addEventListener('click', async () => {
  const resultDiv = document.getElementById('result');
  resultDiv.classList.add('show');
  resultDiv.innerHTML = '<div class="empty">正在处理...</div>';

  try {
    const tab = await getActiveTab();

    // 检查是否是特殊页面
    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('about:')) {
      resultDiv.innerHTML = '<div class="empty">无法在当前页面使用此功能，请在普通网页上使用</div>';
      return;
    }

    // 直接在页面中显示密码
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: function() {
        const inputs = document.querySelectorAll('input[type="password"]');
        let count = 0;

        inputs.forEach(function(input) {
          // 尝试获取关联的标签文本
          let labelText = input.id || input.name || input.placeholder || '密码';
          const labelElement = document.querySelector('label[for="' + input.id + '"]');
          if (labelElement) {
            labelText = labelElement.textContent.trim();
          }

          // 尝试获取父级元素中的文本作为标签
          if (!input.id && !input.name) {
            const parent = input.closest('form, div, section, td');
            if (parent) {
              const walker = document.createTreeWalker(parent, NodeFilter.SHOW_TEXT, null, false);
              let text = '';
              let node;
              while (node = walker.nextNode()) {
                if (node === input) break;
                text += node.textContent;
              }
              const prevText = text.trim().replace(/\s+/g, ' ').slice(-15);
              if (prevText) labelText = prevText;
            }
          }

          // 直接将 type 改为 text 显示密码
          input.type = 'text';
          count++;
        });

        return { count: count, labels: Array.from(inputs).map(i => i.id || i.name || i.placeholder || '密码') };
      }
    });

    const result = results[0]?.result;

    if (!result || result.count === 0) {
      resultDiv.innerHTML = '<div class="empty">未找到密码输入框</div>';
      return;
    }

    resultDiv.innerHTML = '<div class="empty">已显示 ' + result.count + ' 个密码</div>';

  } catch (error) {
    resultDiv.innerHTML = '<div class="empty">操作失败: ' + escapeHtml(error.message) + '</div>';
  }
});

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// 识别二维码：发消息给 background 注入扫描逻辑，popup 随即关闭
document.getElementById('scanQR').addEventListener('click', async () => {
  const tab = await getActiveTab();
  if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('about:')) {
    const resultDiv = document.getElementById('result');
    resultDiv.classList.add('show');
    resultDiv.innerHTML = '<div class="empty">无法在当前页面使用此功能，请在普通网页上使用</div>';
    return;
  }
  chrome.runtime.sendMessage({ action: 'scanQR' });
  window.close();
});