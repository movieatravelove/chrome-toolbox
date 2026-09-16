// 修改 Header 工具：基于 chrome.declarativeNetRequest 动态规则修改请求头/响应头
// 支持多分组管理，选中的分组立即生效（切换分组即应用，无需手动保存）

var STORAGE_KEY = 'headerRules';
var BASE_RULE_ID = 10000; // 本工具动态规则 ID 起始段
var MAX_RULES = 5000;    // 受 DNR 动态规则上限保护

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
var ICON_X = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

var toolList = document.getElementById('toolList');
var resultDiv = document.getElementById('result');
var headerPanel = document.getElementById('headerPanel');
var groupListEl = document.getElementById('groupList');
var groupNameInput = document.getElementById('groupName');
var groupUrlInput = document.getElementById('groupUrl');
var ruleList = document.getElementById('ruleList');
var statusEl = document.getElementById('headerStatus');

// 内存中的完整配置：{ activeGroupId, groups: [{ id, name, urlFilter, entries }] }
var state = { activeGroupId: null, groups: [] };

document.getElementById('editHeaders').addEventListener('click', openPanel);
document.getElementById('backFromHeaders').addEventListener('click', closePanel);
document.getElementById('addRule').addEventListener('click', function() {
  addRow({});
});
document.getElementById('saveRules').addEventListener('click', applyCurrentGroup);
document.getElementById('addGroup').addEventListener('click', addGroup);

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

// 编辑分组名称时同步更新侧边栏当前项文案
groupNameInput.addEventListener('input', function() {
  var label = groupListEl.querySelector('.group-item.active .group-label');
  if (label) {
    label.textContent = groupNameInput.value.trim() || '未命名分组';
  }
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

function createGroup(name, urlFilter, entries) {
  return {
    id: genGroupId(),
    name: name || '未命名分组',
    urlFilter: urlFilter || '',
    entries: Array.isArray(entries) ? entries : []
  };
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
  toolList.style.display = 'none';
  resultDiv.classList.remove('show');
  headerPanel.style.display = 'block';
  document.body.classList.add('panel-open');
  setStatus('', '');

  var apiError = getApiError();
  if (apiError) {
    state = { activeGroupId: null, groups: [createGroup('默认组', '', [])] };
    renderGroupList();
    renderGroup();
    setStatus(apiError, 'error');
    return;
  }

  try {
    state = await loadConfig();
    renderGroupList();
    renderGroup();
  } catch (error) {
    state = { activeGroupId: null, groups: [createGroup('默认组', '', [])] };
    renderGroupList();
    renderGroup();
    setStatus('读取配置失败：' + error.message, 'error');
  }
}

function closePanel() {
  headerPanel.style.display = 'none';
  toolList.style.display = '';
  document.body.classList.remove('panel-open');
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
      urlFilter: g.urlFilter || '',
      entries: Array.isArray(g.entries) ? g.entries : []
    };
  });
  if (groups.length === 0) {
    groups.push(createGroup('默认组', '', []));
  }

  var activeGroupId = config.activeGroupId;
  if (!groups.some(function(g) { return g.id === activeGroupId; })) {
    activeGroupId = groups[0].id;
  }

  return { activeGroupId: activeGroupId, groups: groups };
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
    activeGroupId: groups[0].id,
    groups: groups
  };
}

function getActiveGroup() {
  var group = state.groups.find(function(g) { return g.id === state.activeGroupId; });
  return group || state.groups[0];
}

// 渲染侧边栏分组列表
function renderGroupList() {
  groupListEl.innerHTML = '';
  state.groups.forEach(function(g) {
    var item = document.createElement('div');
    item.className = 'group-item' + (g.id === state.activeGroupId ? ' active' : '');
    item.dataset.groupId = g.id;
    item.title = g.name || '未命名分组';

    var label = document.createElement('span');
    label.className = 'group-label';
    label.textContent = g.name || '未命名分组';

    var del = document.createElement('button');
    del.className = 'group-del';
    del.title = '删除此分组';
    del.innerHTML = ICON_X;

    item.appendChild(label);
    item.appendChild(del);
    groupListEl.appendChild(item);
  });
}

// 切换到指定分组：先把当前 DOM 的编辑内容收回内存，选中即生效
async function switchGroup(groupId) {
  syncActiveGroupFromDOM();
  state.activeGroupId = groupId;
  setStatus('', '');
  renderGroupList();
  renderGroup();
  await applyCurrentGroup();
}

// 渲染当前选中分组的名称、URL 和规则行
function renderGroup() {
  var group = getActiveGroup();
  state.activeGroupId = group.id;
  renderGroupList();
  groupNameInput.value = group.name;
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
    '<div class="row-error"></div>';

  row.querySelector('.direction-select').value = direction;
  row.querySelector('.operation-select').value = operation;
  row.querySelector('.name-input').value = entry.name || '';
  row.querySelector('.value-input').value = entry.value || '';

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

// 新建分组：先保存当前分组的编辑内容，再创建并切换到空分组（选中即生效）
async function addGroup() {
  syncActiveGroupFromDOM();
  var group = createGroup('新分组 ' + (state.groups.length + 1), '', []);
  state.groups.push(group);
  state.activeGroupId = group.id;
  renderGroupList();
  renderGroup();
  await applyCurrentGroup();
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
  if (!window.confirm('确定删除分组「' + (target.name || '未命名分组') + '」？')) {
    return;
  }

  var isActive = targetId === state.activeGroupId;
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
    renderGroupList();
    renderGroup();
    applyCurrentGroup();
  } else {
    renderGroupList();
    setStatus('', '');
  }
}

// 把当前 DOM 中对分组名称、URL、规则的编辑收回内存
function syncActiveGroupFromDOM() {
  var group = getActiveGroup();
  if (!group) {
    return;
  }
  group.name = groupNameInput.value.trim() || '未命名分组';
  group.urlFilter = groupUrlInput.value.trim();
  group.entries = collectRawEntries();
}

function readRow(row) {
  var operation = row.querySelector('.operation-select').value;
  return {
    direction: row.querySelector('.direction-select').value,
    operation: operation,
    name: row.querySelector('.name-input').value.trim(),
    value: operation === 'remove' ? '' : row.querySelector('.value-input').value
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
      value: entry.value
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

  setStatus('应用中...', '');

  // 将编辑内容收回内存，同时校验当前分组规则行
  syncActiveGroupFromDOM();
  var group = getActiveGroup();
  var validated = validateRows();

  try {
    // 清除本工具此前写入的全部动态规则：选中分组即为唯一生效来源
    var existing = await chrome.declarativeNetRequest.getDynamicRules();
    var oldIds = existing
      .map(function(rule) { return rule.id; })
      .filter(function(id) { return id >= BASE_RULE_ID && id < BASE_RULE_ID + MAX_RULES; });
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: oldIds });

    if (validated.hasError) {
      setStatus('分组「' + group.name + '」有无效规则，已清空 Header 修改，请修正标红项', 'error');
      return;
    }
    if (group.urlFilter && !VALID_URL_FILTER.test(group.urlFilter)) {
      setStatus('当前分组的 URL 过滤含有非法字符，已清空 Header 修改', 'error');
      return;
    }

    // 持久化全部分组配置及当前选中组
    await chrome.storage.local.set({
      headerRules: {
        activeGroupId: state.activeGroupId,
        groups: state.groups.map(function(g) {
          return { id: g.id, name: g.name, urlFilter: g.urlFilter, entries: g.entries };
        })
      }
    });

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
        setRowError(validated.entries[index].row, '浏览器拒绝此规则：' + reason);
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

// 归一化一条导入条目：operation/direction 缺省用默认值，value 转字符串
function normalizeImportedEntry(e) {
  return {
    direction: e.direction === 'responseHeaders' ? 'responseHeaders' : 'requestHeaders',
    operation: ['set', 'append', 'remove'].indexOf(e.operation) >= 0 ? e.operation : 'set',
    name: String(e.name || '').trim(),
    value: e.value === undefined || e.value === null ? '' : String(e.value)
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
          direction: item.direction
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
