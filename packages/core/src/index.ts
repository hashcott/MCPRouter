export const VERSION = '0.0.0';

export {
  currentContext,
  newRequestId,
  runWithContext,
  type RequestContext,
} from './obs/context.js';
export { createLogger, redactServerConfig, type Logger, type LoggerOptions } from './obs/log.js';
