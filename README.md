# 工具集 Chrome 扩展

实用的网页工具集合。

## 功能

### 查看密码
扫描当前页面所有密码输入框，直接将 `type="password"` 改为 `type="text"`，直接在原位置显示密码内容。

### 修改 Header
基于 Chrome `declarativeNetRequest` 动态规则修改网络请求的 HTTP 头：

- 支持**请求头**和**响应头**，操作包括「设置(set)」「追加(append)」「删除(remove)」，规则行采用 `Key = Value` 布局
- 支持**多个分组**：左侧边栏列出全部分组，`＋` 新建、悬停点 `×` 删除；每个分组有独立的规则列表
- 每个分组可单独设置**组级 URL 过滤**（如 `||example.com`），对组内全部规则生效，留空则对所有网站生效
- **选中分组即生效**：点击左侧分组立即切换为该组的 Header，无需手动保存；编辑规则后点「应用当前分组」生效
- 全部分组配置持久保存，重启浏览器不丢失；旧版单组配置会自动迁移，按原 URL 过滤自动归并成分组

URL 过滤使用 Chrome [urlFilter 语法](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest#property-RuleCondition-urlFilter)，例如：

- `||example.com`：匹配 example.com 及其所有子域名
- `*://*.example.com/*`：匹配 example.com 子域名下的 http/https 请求

## 安装方法

1. 打开 Chrome 浏览器，访问 `chrome://extensions/`
2. 开启右上角的「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择本文件夹

## 使用方法

### 查看密码

1. 访问任意网页
2. 点击浏览器右上角的扩展图标
3. 点击「查看密码」按钮

### 修改 Header

1. 点击扩展图标，选择「修改 Header」
2. 在左侧边栏选择分组（或点「＋ 新建分组」），在右侧填写分组名称和本组的 URL 过滤（选填）
3. 在组内设置请求头/响应头的 Key、Value（删除操作无需填值）
4. 点击左侧分组**立即切换生效**；编辑规则后点「应用当前分组」生效，新发起的网络请求即携带修改后的 Header
5. 如需暂时停用，可切换到无规则的分组

## 注意事项

- 查看密码仅在普通网页上可用，无法在 Chrome 内部页面（如 chrome://extensions/）使用；刷新页面后密码将恢复为隐藏状态
- 修改 Header 对保存后**新发起**的请求生效，已完成的请求不会变化
- 受 Chrome 安全限制，部分头无法通过扩展修改（如请求头 `Cookie`、`Host`、`Sec-*`、`Proxy-*`，响应头 `Set-Cookie` 等），保存时对应行会显示浏览器的报错
- Header 修改为全局规则，不依赖扩展弹窗保持打开；同一时刻只有选中分组的规则生效，如需恢复请切到无规则的分组或删除规则