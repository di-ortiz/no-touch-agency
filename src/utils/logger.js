import winston from 'winston';

const { combine, timestamp, printf, colorize, errors } = winston.format;

const logFormat = printf(({ level, message, timestamp, workflow, client, ...meta }) => {
  let line = `${timestamp} [${level}]`;
  if (workflow) line += ` [${workflow}]`;
  if (client) line += ` [${client}]`;
  line += ` ${message}`;
  const extra = Object.keys(meta).filter(k => k !== 'level' && k !== 'splat');
  if (extra.length > 0) {
    const metaObj = {};
    for (const k of extra) metaObj[k] = meta[k];
    line += ` ${JSON.stringify(metaObj)}`;
  }
  return line;
});

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: combine(
    errors({ stack: true }),
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    logFormat,
  ),
  defaultMeta: {},
  transports: [
    new winston.transports.Console({
      format: combine(colorize(), logFormat),
    }),
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: 'logs/combined.log',
      maxsize: 10 * 1024 * 1024,
      maxFiles: 10,
    }),
  ],
});

/**
 * Create a child logger scoped to a workflow/client context.
 */
export function createWorkflowLogger(workflow, client) {
  return logger.child({ workflow, client });
}

export default logger;
