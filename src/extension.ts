import * as vscode from 'vscode';
import { createCore, type Core } from './core/bootstrap';
import { PanelProvider } from './webview/panel';

/**
 * ContextFlow 扩展入口。
 *
 * 本里程碑（1.0.1）只负责：
 * 1. 初始化 core（缓存层 SQLite 落盘路径注入）；
 * 2. 注册侧边栏 WebviewView（空面板骨架）；
 * 3. 注册命令占位。
 *
 * 会话 / 路由 / Adapter / 面板交互在 P1 里程碑接入（见 docs/）。
 */
export function activate(context: vscode.ExtensionContext): void {
  const core: Core = createCore(context.globalStorageUri.fsPath);

  // 侧边栏面板
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'contextflow.panel',
      new PanelProvider(context, core),
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  // 命令占位（P1 接入真实会话）
  context.subscriptions.push(
    vscode.commands.registerCommand('contextflow.newSession', () => {
      void vscode.window.showInformationMessage(
        'ContextFlow：会话管理将在 P1 里程碑提供（当前为工程骨架 + 缓存层）。',
      );
    }),
  );

  // 退出时关闭 SQLite 连接
  context.subscriptions.push({ dispose: () => core.cacheStore.close() });
}

export function deactivate(): void {
  // 连接清理由 subscription dispose 负责
}
