export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'HttpError';
  }
  get retryable(): boolean {
    return this.status === 408 || this.status === 409 || this.status === 425 || this.status === 429 || this.status >= 500;
  }
}

/** Permanent configuration problem — never retried. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Model returned something we could not parse. Retried with smaller batches. */
export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

export async function ensureOk(res: Response, label: string): Promise<Response> {
  if (res.ok) return res;
  let body = '';
  try {
    body = await res.text();
  } catch {
    /* ignore */
  }
  const detail = body.slice(0, 300);
  // Gemini puts the wait time in the JSON body (google.rpc.RetryInfo: "retryDelay": "36s"),
  // not in a Retry-After header.
  const bodyDelay = body.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  const retryAfter = parseRetryAfter(res.headers.get('retry-after')) ?? (bodyDelay ? Math.round(Number(bodyDelay[1]) * 1000) : undefined);
  const hint =
    res.status === 401 || res.status === 403
      ? ' (check the API key / permissions)'
      : res.status === 429
        ? ' (rate limited)'
        : '';
  throw new HttpError(res.status, `${label} HTTP ${res.status}${hint}${detail ? ': ' + detail : ''}`, retryAfter);
}
