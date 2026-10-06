// Small fetch-based API client. Attaches X-Demo-User from the current demo
// identity (AGENTS.md section 7). Patient pay pages use token URLs and pass
// `{ auth: false }` so no identity header is sent.
import { currentUserId } from './session'

export interface RequestOptions {
  method?: string
  body?: unknown
  /** Set false for patient token routes (no X-Demo-User). Defaults to true. */
  auth?: boolean
  headers?: Record<string, string>
}

export class ApiError extends Error {
  code: string
  status: number
  details: Record<string, unknown>

  constructor(status: number, code: string, message: string, details: Record<string, unknown>) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

export async function apiRequest<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) }
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
  if (opts.auth !== false) headers['X-Demo-User'] = currentUserId.value

  const res = await fetch(`/api${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
  })

  const text = await res.text()
  const data = text ? JSON.parse(text) : null

  if (!res.ok) {
    const err = (data && data.error) || {}
    throw new ApiError(res.status, err.code ?? 'UNKNOWN', err.message ?? res.statusText, err.details ?? {})
  }
  return data as T
}

export interface HealthResponse {
  status: string
  db: { connected: boolean; error?: string }
}

export function getHealth(): Promise<HealthResponse> {
  return apiRequest<HealthResponse>('/health', { auth: false })
}
