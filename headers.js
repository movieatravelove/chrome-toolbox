// 修改 Header 工具：基于 chrome.declarativeNetRequest 动态规则修改请求头/响应头
// 支持多分组管理，选中的分组立即生效（切换分组即应用，无需手动保存）

var STORAGE_KEY = 'headerRules';
var BASE_RULE_ID = 10000; // 本工具动态规则 ID 起始段
var MAX_RULES = 5000;    // 受 DNR 动态规则上限保护
var LEGACY_EMPTY_GROUP_ID = '__empty__'; // v1.8 空白分组哨兵，迁移为「总开关关闭」

// 覆盖全部资源类型，保证页面、子框架、XHR/fetch、静态资源等都命中
var RESOURCE_TYPES = [
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font',
  'object', 'xmlhttprequest', 'ping', 'csp_report', 'media',
  'websocket', 'webtransport', 'other'
];

// Chrome 禁止通过 declarativeNetRequest 修改的常见请求头（仅用于友好提示，最终以浏览器报错为准）
var FORBIDDEN_REQUEST_HEADERS = [
  'accept-charset', 'accept-encoding', 'access-control-request-headers',
  'access-control-request-method', 'connection', 'content-length', 'cookie',
  'cookie2', 'date', 'dnt', 'expect', 'feature-policy', 'host', 'keep-alive',
  'origin', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'via'
];
var FORBIDDEN_REQUEST_PREFIXES = ['proxy-', 'sec-'];

// 常见禁止修改的响应头
var FORBIDDEN_RESPONSE_HEADERS = [
  'content-encoding', 'content-length', 'set-cookie', 'set-cookie2',
  'transfer-encoding'
];

// RFC 7230 合法 header 名称字符
var VALID_HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// urlFilter 仅允许可打印 ASCII 字符（不含空格），最终以浏览器校验为准
var VALID_URL_FILTER = /^[\x21-\x7e]*$/;

// 细描边线性图标（Lucide 风格）
var ICON_TRASH = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>';
var ICON_NOTE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8Z"/><path d="M15 3v4a2 2 0 0 0 2 2h4"/><path d="M8 13h8"/><path d="M8 17h5"/></svg>';
var ICON_X = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

var toolList = document.getElementById('toolList');
var resultDiv = document.getElementById('result');
var headerPanel = document.getElementById('headerPanel');
var groupListEl = document.getElementById('groupList');
var headerEnabledInput = document.getElementById('headerEnabled');
var headerEnabledText = document.getElementById('headerEnabledText');
var groupNameInput = document.getElementById('groupName');
var groupShortInput = document.getElementById('groupShort');
var groupUrlInput = document.getElementById('groupUrl');
var headerEnabledOuterInput = document.getElementById('headerEnabledOuter');
var headerActiveBrief = document.getElementById('headerActiveBrief');
var ruleList = document.getElementById('ruleList');
var statusEl = document.getElementById('headerStatus');

// 内存中的完整配置：{ enabled, activeGroupId, groups: [{ id, name, short, urlFilter, entries }] }
var state = { enabled: true, activeGroupId: null, groups: [] };
// 面板是否打开过：避免弹窗启动时的异步读取在面板操作后覆盖 state
var panelLoaded = false;

document.getElementById('editHeaders').addEventListener('click', openPanel);
document.getElementById('backFromHeaders').addEventListener('click', closePanel);
document.getElementById('addRule').addEventListener('click', function() {
  addRow({});
});
document.getElementById('saveRules').addEventListener('click', function() {
  // 停用时点「应用」等价于重新开启并应用当前分组
  if (!state.enabled) {
    setEnabled(true);
  } else {
    applyCurrentGroup();
  }
});
document.getElementById('addGroup').addEventListener('click', addGroup);
headerEnabledInput.addEventListener('change', function() {
  setEnabled(headerEnabledInput.checked);
});
// 外层卡片上的总开关：点击不冒泡到卡片（避免同时打开面板）
document.getElementById('headerSwitchOuter').addEventListener('click', function(e) {
  e.stopPropagation();
});
headerEnabledOuterInput.addEventListener('change', function() {
  setEnabled(headerEnabledOuterInput.checked);
});
// 卡片由 button 改为 div，补回键盘可访问性
document.getElementById('editHeaders').addEventListener('keydown', function(e) {
  if (e.target !== e.currentTarget) {
    return;
  }
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    openPanel();
  }
});

// 导入功能：粘贴 JSON 或 Key-Value 文本，自动识别格式后追加到当前分组
var importArea = document.getElementById('importArea');
var importText = document.getElementById('importText');
document.getElementById('importBtn').addEventListener('click', function() {
  var hidden = importArea.style.display === 'none';
  importArea.style.display = hidden ? 'block' : 'none';
  if (hidden) {
    importText.focus();
  }
});
document.getElementById('importCancel').addEventListener('click', function() {
  importArea.style.display = 'none';
  importText.value = '';
});
document.getElementById('importConfirm').addEventListener('click', importEntries);

// 侧边栏：点击分组名切换，点击 × 删除对应分组
groupListEl.addEventListener('click', function(e) {
  var delBtn = e.target.closest('.group-del');
  if (delBtn) {
    removeGroup(delBtn.closest('.group-item'));
    return;
  }
  var item = e.target.closest('.group-item');
  if (!item || item.classList.contains('active')) {
    return;
  }
  switchGroup(item.dataset.groupId);
});

// 编辑分组名称时同步更新当前项头像（无手动简称时取首字）与外层卡片简称
groupNameInput.addEventListener('input', function() {
  var group = getActiveGroup();
  if (!group) {
    return;
  }
  group.name = groupNameInput.value.trim() || '未命名分组';
  var avatar = groupListEl.querySelector('.group-item.active .group-avatar');
  if (avatar) {
    avatar.textContent = getGroupShort(group);
  }
  renderOuterCard();
});

// 编辑简称（一个字）时同步更新头像与外层卡片简称
groupShortInput.addEventListener('input', function() {
  var group = getActiveGroup();
  if (!group) {
    return;
  }
  group.short = groupShortInput.value.trim().charAt(0) || '';
  var avatar = groupListEl.querySelector('.group-item.active .group-avatar');
  if (avatar) {
    avatar.textContent = getGroupShort(group);
  }
  renderOuterCard();
});

// 事件委托：删除行、切换操作时联动值输入框（图标为内联 SVG，需用 closest 定位按钮）
ruleList.addEventListener('click', function(e) {
  var btn = e.target.closest('.remove-btn');
  if (btn) {
    removeRow(btn);
  }
});
ruleList.addEventListener('change', function(e) {
  if (e.target.classList.contains('operation-select')) {
    syncRowState(e.target.closest('.rule-row'));
  }
});

function genGroupId() {
  return 'g_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function createGroup(name, urlFilter, entries, short) {
  return {
    id: genGroupId(),
    name: name || '未命名分组',
    short: short || '',
    urlFilter: urlFilter || '',
    entries: Array.isArray(entries) ? entries : []
  };
}

// 分组头像文字：优先手动设置的单字简称，否则取名称首字
function getGroupShort(g) {
  var short = (g.short || '').trim();
  if (short) {
    return short.charAt(0);
  }
  return (g.name || '未命名分组').trim().charAt(0) || '?';
}

// 检查扩展是否具备所需 API（manifest 权限更新后若未重新加载扩展，API 会是 undefined）
function getApiError() {
  if (!chrome.storage || !chrome.storage.local) {
    return '缺少 storage 权限，请在 chrome://extensions 页面重新加载本扩展';
  }
  if (!chrome.declarativeNetRequest) {
    return '当前浏览器不支持 declarativeNetRequest，请使用新版 Chrome/Edge';
  }
  return '';
}

async function openPanel() {
  panelLoaded = true;
  toolList.style.display = 'none';
  resultDiv.classList.remove('show');
  headerPanel.style.display = 'block';
  document.body.classList.add('panel-open');
  setStatus('', '');

  var apiError = getApiError();
  if (apiError) {
    state = { enabled: true, activeGroupId: null, groups: [createGroup('默认组', '', [])] };
    renderEnabledUI();
    renderGroupList();
    renderGroup();
    setStatus(apiError, 'error');
    return;
  }

  try {
    state = await loadConfig();
    renderEnabledUI();
    renderGroupList();
    renderGroup();
    if (!state.enabled) {
      setStatus('当前已停用：未修改任何 Header，开启右上角开关恢复', '');
    }
  } catch (error) {
    state = { enabled: true, activeGroupId: null, groups: [createGroup('默认组', '', [])] };
    renderEnabledUI();
    renderGroupList();
    renderGroup();
    setStatus('读取配置失败：' + error.message, 'error');
  }
}

function closePanel() {
  headerPanel.style.display = 'none';
  toolList.style.display = '';
  document.body.classList.remove('panel-open');
  document.body.classList.remove('headers-disabled');
  renderOuterCard();
}

// 读取配置；兼容 v1（{ enabled, entries }）结构并迁移为分组结构
async function loadConfig() {
  var data = await chrome.storage.local.get(STORAGE_KEY);
  var config = data[STORAGE_KEY];

  if (!config || !Array.isArray(config.groups)) {
    return migrateV1(config || {});
  }

  var groups = config.groups.map(function(g) {
    return {
      id: String(g.id || genGroupId()),
      name: g.name || '未命名分组',
      short: typeof g.short === 'string' ? g.short.trim().charAt(0) : '',
      urlFilter: g.urlFilter || '',
      entries: Array.isArray(g.entries) ? g.entries : []
    };
  });
  if (groups.length === 0) {
    groups.push(createGroup('默认组', '', []));
  }

  var enabled = config.enabled !== false;
  var activeGroupId = config.activeGroupId;
  // v1.8 的空白分组哨兵迁移为「总开关关闭」
  if (activeGroupId === LEGACY_EMPTY_GROUP_ID) {
    activeGroupId = groups[0].id;
    if (config.enabled === undefined) {
      enabled = false;
    }
  } else if (!groups.some(function(g) { return g.id === activeGroupId; })) {
    activeGroupId = groups[0].id;
  }

  return { enabled: enabled, activeGroupId: activeGroupId, groups: groups };
}

// v1 配置按规则各自的 URL 过滤归并成分组
function migrateV1(old) {
  var buckets = new Map();
  (old.entries || []).forEach(function(e) {
    var key = e.urlFilter || '';
    if (!buckets.has(key)) {
      buckets.set(key, []);
    }
    buckets.get(key).push({
      direction: e.direction === 'responseHeaders' ? 'responseHeaders' : 'requestHeaders',
      operation: ['set', 'append', 'remove'].indexOf(e.operation) >= 0 ? e.operation : 'set',
      name: e.name || '',
      value: e.value || ''
    });
  });

  var groups = [];
  if (buckets.size === 0) {
    groups.push(createGroup('默认组', '', []));
  } else {
    var index = 0;
    buckets.forEach(function(entries, url) {
      index++;
      groups.push(createGroup(url ? '默认组 ' + index : '默认组', url, entries));
    });
  }

  return {
    enabled: true,
    activeGroupId: groups[0].id,
    groups: groups
  };
}

function getActiveGroup() {
  var group = state.groups.find(function(g) { return g.id === state.activeGroupId; });
  return group || state.groups[0];
}

// 持久化完整配置（总开关、选中组、全部分组）
function persistConfig() {
  return chrome.storage.local.set({
    headerRules: {
      enabled: state.enabled !== false,
      activeGroupId: state.activeGroupId,
      groups: state.groups.map(function(g) {
        return { id: g.id, name: g.name, short: g.short || '', urlFilter: g.urlFilter, entries: g.entries };
      })
    }
  });
}

// ===== 总开关 =====
function renderEnabledUI() {
  var on = state.enabled !== false;
  headerEnabledInput.checked = on;
  headerEnabledOuterInput.checked = on;
  headerEnabledText.textContent = on ? '已启用' : '已停用';
  document.body.classList.toggle('headers-disabled', !on);
  renderOuterCard();
}

// 外层卡片右侧：总开关状态 + 当前生效分组的单字简称
function renderOuterCard() {
  var on = state.enabled !== false;
  headerEnabledOuterInput.checked = on;
  var group = state.groups.length ? getActiveGroup() : null;
  var charEl = headerActiveBrief.querySelector('.brief-char');
  charEl.textContent = group ? getGroupShort(group) : '·';
  headerActiveBrief.classList.toggle('off', !on);
  headerActiveBrief.title = group
    ? (on ? '当前生效分组：' : '已停用（规则与分组保留）：') + group.name
    : '';
}

// 弹窗打开时（面板未开）读取配置，渲染外层卡片上的开关与简称
async function initOuterCard() {
  try {
    var config = await loadConfig();
    // 若期间面板已打开过，则一律以面板内的 state 为准
    if (!panelLoaded && headerPanel.style.display === 'none') {
      state = config;
    }
  } catch (error) {
    // 读取失败时外层卡片保持默认外观
  }
  renderOuterCard();
}
initOuterCard();

async function setEnabled(on) {
  state.enabled = !!on;
  renderEnabledUI();
  await persistConfig();
  if (state.enabled) {
    await applyCurrentGroup();
  } else {
    try {
      var existing = await chrome.declarativeNetRequest.getDynamicRules();
      var oldIds = existing
        .map(function(rule) { return rule.id; })
        .filter(function(id) { return id >= BASE_RULE_ID && id < BASE_RULE_ID + MAX_RULES; });
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: oldIds });
      setStatus('已停用：当前不修改任何 Header，规则与分组均已保留', '');
      renderGroupList();
    } catch (error) {
      setStatus('停用失败：' + error.message, 'error');
    }
  }
}

// 渲染侧边栏分组列表
function renderGroupList() {
  groupListEl.innerHTML = '';

  state.groups.forEach(function(g) {
    var item = document.createElement('div');
    item.className = 'group-item' + (g.id === state.activeGroupId ? ' active' : '');
    item.dataset.groupId = g.id;
    item.title = (g.name || '未命名分组') +
      '（' + (g.entries.length ? g.entries.length + ' 条规则' : '空') + '）';

    var avatar = document.createElement('span');
    avatar.className = 'group-avatar';
    avatar.textContent = getGroupShort(g);

    // 规则条数角标（无规则不显示；悬停头像时让位于删除钮）
    var count = document.createElement('span');
    count.className = 'group-count';
    count.textContent = g.entries.length > 99 ? '99+' : String(g.entries.length);
    if (!g.entries.length) {
      count.style.display = 'none';
    }

    var del = document.createElement('button');
    del.className = 'group-del';
    del.title = '删除此分组';
    del.innerHTML = ICON_X;

    item.appendChild(avatar);
    item.appendChild(count);
    item.appendChild(del);
    groupListEl.appendChild(item);
  });

  // 分组变化同步外层卡片的当前生效简称
  renderOuterCard();
}

// 切换到指定分组：先把当前 DOM 的编辑内容收回内存；启用时选中即生效，停用时仅切换视图
async function switchGroup(groupId) {
  syncActiveGroupFromDOM();
  state.activeGroupId = groupId;
  setStatus('', '');
  renderGroup();
  if (state.enabled) {
    await applyCurrentGroup();
  } else {
    await persistConfig();
  }
}

// 渲染当前选中分组的名称、URL 和规则行
function renderGroup() {
  renderGroupList();

  var group = getActiveGroup();
  state.activeGroupId = group.id;
  groupNameInput.value = group.name;
  groupShortInput.value = group.short || '';
  groupUrlInput.value = group.urlFilter;

  ruleList.innerHTML = '';
  if (group.entries.length === 0) {
    addRow({});
  } else {
    group.entries.forEach(function(entry) {
      addRow(entry);
    });
  }
}

// 渲染一行规则，entry 为空时使用默认值；名称和值在同一行（key = value）
function addRow(entry) {
  var row = document.createElement('div');
  row.className = 'rule-row';

  var direction = entry.direction === 'responseHeaders' ? 'responseHeaders' : 'requestHeaders';
  var operation = ['set', 'append', 'remove'].indexOf(entry.operation) >= 0 ? entry.operation : 'set';

  row.innerHTML =
    '<div class="row-line">' +
      '<select class="direction-select">' +
        '<option value="requestHeaders">请求头</option>' +
        '<option value="responseHeaders">响应头</option>' +
      '</select>' +
      '<select class="operation-select">' +
        '<option value="set">设置</option>' +
        '<option value="append">追加</option>' +
        '<option value="remove">删除</option>' +
      '</select>' +
      '<span class="row-hint"></span>' +
      '<button class="remove-btn" title="删除此条">' + ICON_TRASH + '</button>' +
    '</div>' +
    '<div class="row-line kv-line">' +
      '<input class="name-input" placeholder="Key，如 X-Token">' +
      '<span class="kv-sep">=</span>' +
      '<input class="value-input" placeholder="Value">' +
    '</div>' +
    '<div class="row-line">' +
      '<span class="note-icon">' + ICON_NOTE + '</span>' +
      '<input class="note-input" placeholder="备注（选填，仅本地记录，不会发送）">' +
    '</div>' +
    '<div class="row-error"></div>';

  row.querySelector('.direction-select').value = direction;
  row.querySelector('.operation-select').value = operation;
  row.querySelector('.name-input').value = entry.name || '';
  row.querySelector('.value-input').value = entry.value || '';
  row.querySelector('.note-input').value = entry.note || '';

  syncRowState(row);
  ruleList.appendChild(row);
}

function removeRow(btn) {
  var row = btn.closest('.rule-row');
  row.remove();
  // 至少保留一行，方便继续添加
  if (ruleList.querySelectorAll('.rule-row').length === 0) {
    addRow({});
  }
}

// 选择不同操作时联动：删除隐藏 value，同时更新操作说明
var OPERATION_HINTS = {
  set: '覆盖或新增该 Header',
  append: '追加同名 Header（不覆盖）',
  remove: '移除该 Header（无需填 Value）'
};
function syncRowState(row) {
  var operation = row.querySelector('.operation-select').value;
  var noValue = operation === 'remove';
  row.classList.toggle('no-value', noValue);
  row.querySelector('.value-input').disabled = noValue;
  var hint = row.querySelector('.row-hint');
  if (hint) {
    hint.textContent = OPERATION_HINTS[operation] || '';
  }
}

// 新建分组：先保存当前分组的编辑内容，再创建并切换到空分组（启用时选中即生效）
async function addGroup() {
  syncActiveGroupFromDOM();
  // 空分组最多保留 3 个，超出时提示先整理已有分组
  var emptyCount = state.groups.filter(function(g) { return g.entries.length === 0; }).length;
  if (emptyCount >= 3) {
    setStatus('空分组最多保留 3 个：请先为已有空分组添加规则，或删除后再新建', 'error');
    return;
  }
  var group = createGroup('新分组 ' + (state.groups.length + 1), '', []);
  state.groups.push(group);
  state.activeGroupId = group.id;
  renderGroup();
  if (state.enabled) {
    await applyCurrentGroup();
  } else {
    await persistConfig();
  }
  groupNameInput.focus();
  groupNameInput.select();
}

// 删除指定分组（至少保留一个）；删除非当前组时先暂存当前组的编辑
function removeGroup(itemEl) {
  var targetId = itemEl && itemEl.dataset ? itemEl.dataset.groupId : state.activeGroupId;
  var index = state.groups.findIndex(function(g) { return g.id === targetId; });
  if (index < 0) {
    return;
  }
  var target = state.groups[index];
  var isActive = targetId === state.activeGroupId;
  // 当前组以 DOM 中实际填写的规则数为准（可能有未保存的编辑）
  var ruleCount = isActive ? collectRawEntries().length : target.entries.length;
  // 空分组直接删除不打扰；含规则的分组仍需确认
  if (ruleCount > 0 &&
      !window.confirm('分组「' + (target.name || '未命名分组') + '」含 ' +
        ruleCount + ' 条规则，确定删除？')) {
    return;
  }

  if (!isActive) {
    syncActiveGroupFromDOM();
  }

  state.groups.splice(index, 1);
  if (state.groups.length === 0) {
    state.groups.push(createGroup('默认组', '', []));
  }

  if (isActive) {
    var nextIndex = Math.min(index, state.groups.length - 1);
    state.activeGroupId = state.groups[nextIndex].id;
    renderGroup();
    if (state.enabled) {
      applyCurrentGroup();
    } else {
      persistConfig();
    }
  } else {
    renderGroupList();
    setStatus('', '');
    persistConfig();
  }
}

// 把当前 DOM 中对分组名称、URL、规则的编辑收回内存
function syncActiveGroupFromDOM() {
  var group = getActiveGroup();
  if (!group) {
    return;
  }
  group.name = groupNameInput.value.trim() || '未命名分组';
  group.short = groupShortInput.value.trim().charAt(0) || '';
  group.urlFilter = groupUrlInput.value.trim();
  group.entries = collectRawEntries();
}

function readRow(row) {
  var operation = row.querySelector('.operation-select').value;
  return {
    direction: row.querySelector('.direction-select').value,
    operation: operation,
    name: row.querySelector('.name-input').value.trim(),
    value: operation === 'remove' ? '' : row.querySelector('.value-input').value,
    note: row.querySelector('.note-input').value.trim()
  };
}

// 从 DOM 收集条目（不校验），名称为空的行直接丢弃
function collectRawEntries() {
  var entries = [];
  ruleList.querySelectorAll('.rule-row').forEach(function(row) {
    var entry = readRow(row);
    if (!entry.name) {
      return;
    }
    entries.push({
      direction: entry.direction,
      operation: entry.operation,
      name: entry.name,
      value: entry.value,
      note: entry.note
    });
  });
  return entries;
}

function setRowError(row, message) {
  row.classList.add('has-error');
  row.querySelector('.row-error').textContent = message;
}

function clearRowErrors() {
  ruleList.querySelectorAll('.rule-row').forEach(function(row) {
    row.classList.remove('has-error');
    row.querySelector('.row-error').textContent = '';
  });
}

function setStatus(message, type) {
  statusEl.textContent = message;
  statusEl.className = 'status-msg' + (type ? ' ' + type : '');
}

// 检查 Chrome 不允许修改的头名称，返回错误文案，合法返回空字符串
function checkForbiddenHeader(direction, name) {
  var lower = name.toLowerCase();
  if (direction === 'requestHeaders') {
    if (FORBIDDEN_REQUEST_HEADERS.indexOf(lower) >= 0) {
      return 'Chrome 禁止修改请求头「' + name + '」';
    }
    for (var i = 0; i < FORBIDDEN_REQUEST_PREFIXES.length; i++) {
      if (lower.indexOf(FORBIDDEN_REQUEST_PREFIXES[i]) === 0) {
        return 'Chrome 禁止修改以「' + FORBIDDEN_REQUEST_PREFIXES[i] + '」开头的请求头';
      }
    }
  } else {
    if (FORBIDDEN_RESPONSE_HEADERS.indexOf(lower) >= 0) {
      return 'Chrome 禁止修改响应头「' + name + '」';
    }
  }
  return '';
}

// 面板未打开时（外层总开关启用）直接校验内存中的条目，无 DOM 行可标红
function validateMemoryEntries(entries) {
  var result = [];
  var hasError = false;

  (entries || []).forEach(function(entry) {
    if (!entry.name) {
      return;
    }
    if (!VALID_HEADER_NAME.test(entry.name)) {
      hasError = true;
    }
    if (entry.operation !== 'remove' && !String(entry.value || '').trim()) {
      hasError = true;
    }
    if (checkForbiddenHeader(entry.direction, entry.name)) {
      hasError = true;
    }
    result.push({ row: null, entry: entry });
  });

  return { entries: result, hasError: hasError };
}

// 校验当前分组的规则行，返回带 row 引用的条目列表；有错误时 hasError 为 true
function validateRows() {
  var entries = [];
  var hasError = false;

  ruleList.querySelectorAll('.rule-row').forEach(function(row) {
    var entry = readRow(row);
    if (!entry.name) {
      return; // 空行丢弃
    }

    if (!VALID_HEADER_NAME.test(entry.name)) {
      setRowError(row, 'Header 名称含有非法字符');
      hasError = true;
    }
    if (entry.operation !== 'remove' && !entry.value.trim()) {
      setRowError(row, '「' + (entry.operation === 'set' ? '设置' : '追加') + '」操作必须填写 Header 值');
      hasError = true;
    }
    var forbidden = checkForbiddenHeader(entry.direction, entry.name);
    if (forbidden) {
      setRowError(row, forbidden);
      hasError = true;
    }

    entries.push({ row: row, entry: entry });
  });

  return { entries: entries, hasError: hasError };
}

// 由条目构造一条 DNR 动态规则，URL 过滤在分组级别统一生效
function buildDynamicRule(entry, index, urlFilter) {
  var headerItem = { header: entry.name, operation: entry.operation };
  if (entry.operation !== 'remove') {
    headerItem.value = entry.value;
  }

  var action = { type: 'modifyHeaders' };
  action[entry.direction] = [headerItem];

  var condition = { resourceTypes: RESOURCE_TYPES };
  if (urlFilter) {
    condition.urlFilter = urlFilter;
  }

  return {
    id: BASE_RULE_ID + index,
    priority: 1,
    action: action,
    condition: condition
  };
}

// 应用当前选中分组：校验、持久化并写入动态规则；切换分组与「保存并生效」共用
// 先清空旧规则再写入，保证任意时刻生效的规则一定来自当前选中的分组
async function applyCurrentGroup() {
  clearRowErrors();

  var apiError = getApiError();
  if (apiError) {
    setStatus(apiError, 'error');
    return;
  }

  if (state.enabled === false) {
    setStatus('当前已停用：请先开启右上角总开关', '');
    return;
  }

  setStatus('应用中...', '');

  // 将编辑内容收回内存，同时校验规则行；外层总开关启用时面板关闭，只能基于内存条目
  var panelIsOpen = headerPanel.style.display !== 'none';
  if (panelIsOpen) {
    syncActiveGroupFromDOM();
  }
  var group = getActiveGroup();
  var validated = panelIsOpen ? validateRows() : validateMemoryEntries(group.entries);

  try {
    // 清除本工具此前写入的全部动态规则：选中分组即为唯一生效来源
    var existing = await chrome.declarativeNetRequest.getDynamicRules();
    var oldIds = existing
      .map(function(rule) { return rule.id; })
      .filter(function(id) { return id >= BASE_RULE_ID && id < BASE_RULE_ID + MAX_RULES; });
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: oldIds });

    // 持久化全部分组配置及当前选中组
    await persistConfig();

    if (validated.hasError) {
      setStatus('分组「' + group.name + '」有无效规则，已清空 Header 修改，请修正标红项', 'error');
      return;
    }
    if (group.urlFilter && !VALID_URL_FILTER.test(group.urlFilter)) {
      setStatus('当前分组的 URL 过滤含有非法字符，已清空 Header 修改', 'error');
      return;
    }

    if (validated.entries.length === 0) {
      setStatus('已生效：分组「' + group.name + '」暂无规则', 'success');
      return;
    }

    // 仅写入当前选中分组的规则；逐条写入，单条被 Chrome 拒绝不影响其他规则
    var results = await Promise.allSettled(validated.entries.map(function(item, index) {
      return chrome.declarativeNetRequest.updateDynamicRules({
        addRules: [buildDynamicRule(item.entry, index, group.urlFilter)]
      });
    }));

    var successCount = 0;
    results.forEach(function(result, index) {
      if (result.status === 'fulfilled') {
        successCount++;
      } else {
        var reason = result.reason && result.reason.message ? result.reason.message : String(result.reason);
        // 面板关闭时没有 DOM 行可标红，失败数仅体现在状态栏文案中
        if (validated.entries[index].row) {
          setRowError(validated.entries[index].row, '浏览器拒绝此规则：' + reason);
        }
      }
    });

    if (successCount === validated.entries.length) {
      setStatus('已生效：分组「' + group.name + '」共 ' + successCount + ' 条规则', 'success');
    } else {
      setStatus('已生效 ' + successCount + ' 条，' + (validated.entries.length - successCount) + ' 条失败（见行内提示）', 'error');
    }
  } catch (error) {
    setStatus('应用失败：' + error.message, 'error');
  }
}

// ===== 导入：自动识别 JSON 与 Key-Value 两种格式 =====

// 归一化一条导入条目：operation/direction 缺省用默认值，value 转字符串，note 为本地备注
function normalizeImportedEntry(e) {
  return {
    direction: e.direction === 'responseHeaders' ? 'responseHeaders' : 'requestHeaders',
    operation: ['set', 'append', 'remove'].indexOf(e.operation) >= 0 ? e.operation : 'set',
    name: String(e.name || '').trim(),
    value: e.value === undefined || e.value === null ? '' : String(e.value),
    note: e.note === undefined || e.note === null ? '' : String(e.note).trim()
  };
}

// 解析 JSON：支持 { "Key": "Value" } 与 [{ name, value, operation, direction }] 两种形态
function parseJsonImport(text) {
  var data = JSON.parse(text);
  var entries = [];
  if (Array.isArray(data)) {
    data.forEach(function(item) {
      if (item && typeof item === 'object') {
        entries.push(normalizeImportedEntry({
          name: item.name || item.header,
          value: item.value,
          operation: item.operation,
          direction: item.direction,
          note: item.note || item.remark || item.comment
        }));
      }
    });
  } else if (data && typeof data === 'object') {
    Object.keys(data).forEach(function(key) {
      entries.push(normalizeImportedEntry({ name: key, value: data[key] }));
    });
  }
  return entries;
}

// 解析 Key-Value：每行一条，支持「=」或「:」分隔（取首个分隔符，Value 可含 = 或 :）
// 兼容 DevTools / curl -v 复制出的行首「>」「<」前缀；空行与 # // 注释行跳过
function parseKeyValueImport(text) {
  var entries = [];
  var skipped = 0;
  text.split(/\r?\n/).forEach(function(line) {
    var trimmed = line.trim().replace(/^[<>]\s+/, '');
    if (!trimmed || trimmed.charAt(0) === '#' || trimmed.indexOf('//') === 0) {
      return;
    }
    var match = trimmed.match(/^([!#$%&'*+\-.^_`|~0-9A-Za-z]+)\s*[=:]\s*(.*)$/);
    if (!match) {
      skipped++;
      return;
    }
    entries.push(normalizeImportedEntry({ name: match[1], value: match[2] }));
  });
  return { entries: entries, skipped: skipped };
}

function importEntries() {
  var text = importText.value.trim();
  if (!text) {
    setStatus('请先粘贴要导入的内容', 'error');
    return;
  }

  // 以 { 或 [ 开头视为 JSON（header 名不含这两个字符，不会误判）
  var jsonMode = text.charAt(0) === '{' || text.charAt(0) === '[';
  var entries = [];
  var skipped = 0;

  if (jsonMode) {
    try {
      entries = parseJsonImport(text);
    } catch (error) {
      setStatus('JSON 解析失败：' + error.message, 'error');
      return;
    }
  } else {
    var result = parseKeyValueImport(text);
    entries = result.entries;
    skipped = result.skipped;
  }

  var valid = entries.filter(function(e) { return e.name; });
  if (valid.length === 0) {
    setStatus(jsonMode ? 'JSON 中没有可导入的 Header' : '未识别到有效的 Key-Value 行', 'error');
    return;
  }

  // 清掉列表中的空占位行，再把导入的条目追加到当前分组
  ruleList.querySelectorAll('.rule-row').forEach(function(row) {
    if (!row.querySelector('.name-input').value.trim()) {
      row.remove();
    }
  });
  valid.forEach(function(entry) {
    addRow(entry);
  });

  importArea.style.display = 'none';
  importText.value = '';

  var message = '已导入 ' + valid.length + ' 条规则，点「应用当前分组」生效';
  if (skipped > 0) {
    message += '（跳过 ' + skipped + ' 行无法识别的内容）';
  }
  setStatus(message, 'success');
}
