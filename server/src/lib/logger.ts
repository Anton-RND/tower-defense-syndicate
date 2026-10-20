export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60
};

export interface LogRecord {
  ts: string;
  level: LogLevel;
  msg: string;
  [key: string]: unknown;
}

/**
 * Форма логгера для инъекций.
 *
 * Модулям, которые пишут в лог (сторы, фоновые циклы, очередь уведомлений), нужен не
 * класс `Logger`, а его сигнатура: иначе тесты вынуждены создавать настоящий логгер и
 * перехватывать `process.stdout`, а структура, описывающая «куда пишет мой модуль»,
 * оказалась бы привязана к конкретной реализации. `Logger` удовлетворяет этой форме
 * структурно, а заглушка в тесте собирает записи в массив.
 */
export interface LogSink {
  trace(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  fatal(msg: string, meta?: Record<string, unknown>): void;
}

/**
 * Мини-логгер (JSON-строки). Нужен недлинным модулям (сторы, экономика), которые
 * живут вне request-scoped pino-логгера Fastify и должны писать в один формат.
 */
export class Logger implements LogSink {
  constructor(
    private readonly level: LogLevel = 'info',
    private readonly bindings: Record<string, unknown> = {},
    private readonly sink: (line: string) => void = (line) => process.stdout.write(`${line}\n`)
  ) {}

  child(bindings: Record<string, unknown>): Logger {
    return new Logger(this.level, { ...this.bindings, ...bindings }, this.sink);
  }

  trace(msg: string, meta?: Record<string, unknown>): void {
    this.write('trace', msg, meta);
  }
  debug(msg: string, meta?: Record<string, unknown>): void {
    this.write('debug', msg, meta);
  }
  info(msg: string, meta?: Record<string, unknown>): void {
    this.write('info', msg, meta);
  }
  warn(msg: string, meta?: Record<string, unknown>): void {
    this.write('warn', msg, meta);
  }
  error(msg: string, meta?: Record<string, unknown>): void {
    this.write('error', msg, meta);
  }
  fatal(msg: string, meta?: Record<string, unknown>): void {
    this.write('fatal', msg, meta);
  }

  private write(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.level]) return;
    const record: LogRecord = { ts: new Date().toISOString(), level, msg, ...this.bindings, ...(meta ?? {}) };
    if (meta?.error instanceof Error) {
      record.error = { name: meta.error.name, message: meta.error.message };
    }
    try {
      this.sink(JSON.stringify(record));
    } catch {
      // Циклические ссылки в метаданных не должны ронять игровой процесс.
      this.sink(JSON.stringify({ ts: record.ts, level, msg }));
    }
  }
}

export function parseLogLevel(input: string | undefined): LogLevel {
  const value = (input ?? 'info').toLowerCase();
  return value in LEVEL_WEIGHT ? (value as LogLevel) : 'info';
}
