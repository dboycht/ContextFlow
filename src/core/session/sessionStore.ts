import type BetterSqlite3 from 'better-sqlite3';
import type { Message, Session } from './session';
import { titleFromFirstUserInput } from './session';

/** SQLite 原始行 */
interface SessionRow {
  id: string;
  title: string;
  engine_id: string;
  created_at: number;
  updated_at: number;
  meta: string | null;
}

interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  engine_id: string | null;
  ts: number;
  usage: string | null;
}

function parseMeta(json: string | null): Record<string, unknown> | undefined {
  if (!json) {
    return undefined;
  }
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function toMessage(row: MessageRow): Message {
  const msg: Message = {
    id: row.id,
    role: row.role as Message['role'],
    content: row.content,
    ts: row.ts,
  };
  if (row.engine_id) {
    msg.engineId = row.engine_id;
  }
  if (row.usage) {
    try {
      msg.usage = JSON.parse(row.usage) as Message['usage'];
    } catch {
      /* 损坏的 usage 忽略 */
    }
  }
  return msg;
}

/**
 * 会话存储（SQLite，better-sqlite3；docs/03 第 3 节）。
 * 纯 Node：构造函数只接收 db 路径字符串，不感知 VS Code。
 */
export class SessionStore {
  private readonly db: BetterSqlite3.Database;

  constructor(dbPath: string) {
    // 惰性加载 native（同 cacheStore，ABI 问题不导致 import 期崩溃）
    const Database = require('better-sqlite3') as typeof import('better-sqlite3');
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        engine_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        meta TEXT
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        engine_id TEXT,
        ts INTEGER NOT NULL,
        usage TEXT,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session_ts
        ON messages(session_id, ts);
    `);
  }

  /** 新建会话（title 可省略，取首条用户输入自动生成） */
  create(title: string, engineId: string): Session {
    const now = Date.now();
    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO sessions (id, title, engine_id, created_at, updated_at, meta)
         VALUES (?, ?, ?, ?, ?, NULL)`,
      )
      .run(id, title || '新会话', engineId, now, now);
    return {
      id,
      title: title || '新会话',
      engineId,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
  }

  /** 会话列表（updatedAt 倒序；不含 messages，面板列表用 get 取详情） */
  list(): Session[] {
    const rows = this.db
      .prepare(`SELECT * FROM sessions ORDER BY updated_at DESC`)
      .all() as SessionRow[];
    return rows.map((row) => this.fromRow(row, []));
  }

  /** 完整会话（含 messages，按 ts 升序） */
  get(id: string): Session | undefined {
    const row = this.db
      .prepare(`SELECT * FROM sessions WHERE id = ?`)
      .get(id) as SessionRow | undefined;
    if (!row) {
      return undefined;
    }
    const messages = this.db
      .prepare(`SELECT * FROM messages WHERE session_id = ? ORDER BY ts ASC`)
      .all(id) as MessageRow[];
    return this.fromRow(row, messages.map(toMessage));
  }

  /**
   * 追加一条消息（只在回复确认后调用——未确认/中断的内容绝不能进历史，docs/03 §6）。
   * 自动更新会话 updatedAt；首条用户消息自动生成标题。
   */
  appendMessage(sessionId: string, message: Message): void {
    const session = this.get(sessionId);
    if (!session) {
      throw new Error(`session not found: ${sessionId}`);
    }
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO messages (id, session_id, role, content, engine_id, ts, usage)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.id,
        sessionId,
        message.role,
        message.content,
        message.engineId ?? null,
        message.ts,
        message.usage ? JSON.stringify(message.usage) : null,
      );
    let title = session.title;
    if (session.messages.length === 0 && message.role === 'user') {
      title = titleFromFirstUserInput(message.content);
    }
    this.db
      .prepare(`UPDATE sessions SET updated_at = ?, title = ? WHERE id = ?`)
      .run(now, title, sessionId);
  }

  delete(id: string): void {
    this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
  }

  rename(id: string, title: string): void {
    this.db.prepare(`UPDATE sessions SET title = ? WHERE id = ?`).run(title, id);
  }

  /** 更新会话归属引擎（跨引擎迁移后调用，docs/03 §5） */
  setEngine(sessionId: string, engineId: string): void {
    this.db
      .prepare(`UPDATE sessions SET engine_id = ? WHERE id = ?`)
      .run(engineId, sessionId);
  }

  /**
   * 历史前缀（docs/03 第 3 节）：把已确认消息转成缓存前缀可用的文本行。
   * 默认仅保留 user/assistant（system 消息属于固定部分，由缓存层另行组装）。
   */
  historyPrefix(sessionId: string, opts: { includeSystem?: boolean } = {}): string[] {
    const messages = this.get(sessionId)?.messages ?? [];
    return messages
      .filter((m) => opts.includeSystem || m.role !== 'system')
      .map((m) => `[${m.role}] ${m.content}`);
  }

  close(): void {
    this.db.close();
  }

  private fromRow(row: SessionRow, messages: Message[]): Session {
    const session: Session = {
      id: row.id,
      title: row.title,
      engineId: row.engine_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      messages,
    };
    const meta = parseMeta(row.meta);
    if (meta) {
      session.meta = meta;
    }
    return session;
  }
}
