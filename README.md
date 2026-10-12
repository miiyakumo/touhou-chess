# touhou-chess（旧版归档）

此仓库不再承载《幻翼合体：空袭升级》的源码或部署流程。游戏现由独立仓库维护：

- 源码：https://github.com/miiyakumo/phantom-air-raid
- 在线游玩：https://miiyakumo.github.io/phantom-air-raid/

本仓库保留旧东方棋页面和其他独立网页原型：

- 东方棋归档：https://miiyakumo.github.io/touhou-chess/legacy/touhou-chess.html
- 人类杀原型：https://miiyakumo.github.io/touhou-chess/hx.html
- 斑鸠骑行原型：https://miiyakumo.github.io/touhou-chess/spotted-dove-cycling.html

## 人类杀开发与验证

人类杀 v0.4.1 的可编辑 JavaScript 模块在 `src/`，页面模板在 `src/page.html`。这些模块由仓库已有的单文件发布包拆出；`hx.html` 是确定性生成的独立页面，运行时不依赖 npm 或外部 JavaScript 库。

需要 Node.js 22 或更新版本：

```bash
npm ci
npm run build
npm run check
npx playwright install --with-deps chromium
npm run test:browser
```

修改 `src/` 后运行 `npm run build`，将源码和生成的 `hx.html` 一起提交。不要另建 `public/hx.html`，它会覆盖 Pages 发布入口；构建检查会拒绝该重复文件。

`npm test` 覆盖协议、保存与重试、连接生命周期、语音和渲染，以及 6 / 8 / 10 / 12 人完整对局。浏览器测试使用本地信令服务和真实 Chromium WebRTC、DOM、IndexedDB、麦克风轨道，不依赖公共信令或 TURN 服务。可用 `CHROMIUM_EXECUTABLE_PATH` 指定本机已有的 Chromium。PR 和 Pages 发布前均运行回归与浏览器检查。

### 从 v0.4.0 升级

- 所有玩家都需刷新到 v0.4.1，再进行联机；本版使用 `renleisha/3` 协议。
- 原 schema 2 房主存档可恢复并保存为 schema 3，进行中的对局先暂停，待原玩家重新连接后由房主继续。
- 旧版未确认操作会保留在本机归档并显示提示。请查看原操作、对照最新房间状态和记录后决定下一步；程序不会把旧操作自动改成新版命令重发。
- 房主恢复后若连接标识被占用，会生成新邀请。原玩家使用“房主给了新链接”恢复原座位。

协议、边界和审查问题对应关系见 [联机维护说明](docs/networking.md)。
