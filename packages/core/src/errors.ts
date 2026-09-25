export class ToolUnavailableError extends Error {
  readonly code = 'TOOL_UNAVAILABLE';
  /** ONE template string, ONE construction site: hidden, missing and disabled are indistinguishable. */
  constructor(name: string) {
    super(`Tool not found: ${name}`);
    this.name = 'ToolUnavailableError';
  }
}

export class UpstreamUnavailableError extends Error {
  readonly code = 'UPSTREAM_UNAVAILABLE';
  constructor(
    readonly server: string,
    readonly state: string,
    cause?: Error,
  ) {
    super(`Upstream unavailable: ${server}`, cause ? { cause } : undefined);
    this.name = 'UpstreamUnavailableError';
  }
}

export class UpstreamAuthRequiredError extends Error {
  readonly code = 'UPSTREAM_AUTH_REQUIRED';
  constructor(
    readonly server: string,
    readonly authorizationUrl?: string,
  ) {
    super(`Upstream requires authorization: ${server}`);
    this.name = 'UpstreamAuthRequiredError';
  }
}

export class CredentialsRequiredError extends Error {
  readonly code = 'CREDENTIALS_REQUIRED';
  constructor(server: string) {
    super(`Credentials required: ${server}`);
    this.name = 'CredentialsRequiredError';
  }
}

export class UpstreamBusyError extends Error {
  readonly code = 'UPSTREAM_BUSY';
  constructor(server: string) {
    super(`Upstream busy: ${server}`);
    this.name = 'UpstreamBusyError';
  }
}

export class PayloadTooLargeError extends Error {
  readonly code = 'PAYLOAD_TOO_LARGE';
  constructor(message: string) {
    super(message);
    this.name = 'PayloadTooLargeError';
  }
}

export class UnsafeUrlError extends Error {
  readonly code = 'UNSAFE_URL';
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

/**
 * Applied to EVERY error leaving core. Strips any resolved credential value verbatim
 * from the message, the stack and the stringified cause chain. An empty secret is
 * ignored — `String.replaceAll('')` would otherwise splice the censor between every
 * character.
 */
export function redact(err: Error, secrets: readonly string[]): Error {
  const real = secrets.filter((s) => s.length > 0);
  if (real.length === 0) return err;
  const scrub = (s: string): string =>
    real.reduce((acc, secret) => acc.split(secret).join('[redacted]'), s);

  err.message = scrub(err.message);
  if (typeof err.stack === 'string') err.stack = scrub(err.stack);
  if (err.cause !== undefined) {
    err.cause =
      err.cause instanceof Error ? redact(err.cause, real) : new Error(scrub(String(err.cause)));
  }
  return err;
}
