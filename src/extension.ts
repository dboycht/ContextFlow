import * as vscode from 'vscode';
import { createCore, type Core } from './core/bootstrap';
import { PanelProvider } from './webview/panel';

/**
 * ContextFlow 扩展入口。
 * 面板三大区块（会话列表 / 模型切换 / 缓存状态条）由 PanelProvider 呈现，
 * 全部能力经 core 编排层（orchestrator）驱动（docs/04）。
 */
export function activate(context: vscode.ExtensionContext): void {
  // 诊断：扩展宿主运行时版本（better-sqlite3 ABI 排查用，见 DEVELOPMENT.md 排坑记录）
  console.log('[ContextFlow] runtime', JSON.stringify(process.versions));

  let core: Core;
  try {
    // 扩展宿主 cwd 是 VS Code 启动目录，不等于工作区；把工作区文件夹作为配置搜索目录传入
    const workspaceDirs = (vscode.workspace.workspaceFolders ?? []).map(
      (f) => f.uri.fsPath,
    );
    core = createCore(context.globalStorageUri.fsPath, workspaceDirs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`ContextFlow 初始化失败: ${message}`);
    return;
  }

  // 侧边栏面板
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'contextflow.panel',
      new PanelProvider(core.orchestrator),
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  // 命令：新建会话
  context.subscriptions.push(
    vscode.commands.registerCommand('contextflow.newSession', async () => {
      const session = await core.orchestrator.newSession();
      void vscode.window.showInformationMessage(
        `ContextFlow：已创建会话（引擎 ${session.engineId}），在侧边栏面板中开始提问。`,
      );
    }),
  );

  // 退出时关闭 SQLite 连接
  context.subscriptions.push({ dispose: () => core.cacheStore.close() });
  context.subscriptions.push({ dispose: () => core.sessionStore.close() });
}

export function deactivate(): void {
  // 连接清理由 subscription dispose 负责
}
