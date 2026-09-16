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