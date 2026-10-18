export const API_BASE: string = import.meta.env.VITE_API_URL ?? 'http://localhost:4000/api'

export type Role = 'VIEWER' | 'MEMBER' | 'LEAD' | 'ADMIN'
export interface Membership { teamId: string; teamName: string; role: Role }
export interface User { id: string; email: string; name: string; memberships: Membership[] }
export type Status = 'OPEN' | 'IN_PROGRESS' | 'AWAITING_APPROVAL' | 'RESOLVED' | 'CLOSED'
export type Priority = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
export const STATUSES: Status[] = ['OPEN', 'IN_PROGRESS', 'AWAITING_APPROVAL', 'RESOLVED', 'CLOSED']
export const PRIORITIES: Priority[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']
export const TYPES = ['INCIDENT', 'CUSTOMER_ISSUE', 'PAYMENT_INVESTIGATION', 'COMPLIANCE_REQUEST', 'INTERNAL_TASK']

export interface Person { id: string; name: string; email: string }
export interface WorkItem {
  id: string
  title: string
  description: string
  type: string
  priority: Priority
  status: Status
  resolutionNote: string | null
  version: number
  teamId: string
  assigneeId: string | null
  createdById: string
  dueDate: string | null
  createdAt: string
  updatedAt: string
  team?: { id: string; name: string }
  assignee?: Person | null
  createdBy?: Person
}
export interface Activity {
  id: string
  action: string
  beforeJson: string | null
  afterJson: string | null
  createdAt: string
  actor: Person
}
export interface Comment { id: string; body: string; createdAt: string; author: Person }
export interface ItemDetail extends WorkItem {
  activities: Activity[]
  comments: Comment[]
  currentUserRole: Role
  _count: { activities: number; comments: number }
}
export interface Job {
  id: string
  type: string
  payload: string
  status: string
  attempts: number
  maxAttempts: number
  lastError: string | null
  runAt: string
  createdAt: string
}
export interface Stats {
  assignedToMe: number
  unassignedUrgent: number
  awaitingApproval: number
  byStatus: { status: Status; _count: { _all: number } }[]
}

export interface ApiResult<T> { status: number; ok: boolean; data: T; replay: boolean }

/** Raw call that never throws on HTTP errors, so callers can inspect 409 bodies. */
export async function call<T = any>(
  path: string,
  opts: { method?: string; body?: unknown; userId?: string | null; headers?: Record<string, string> } = {},
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { ...opts.headers }
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
  if (opts.userId) headers['x-user-id'] = opts.userId
  try {
    const res = await fetch(API_BASE + path, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    })
    let data: any = null
    try {
      data = await res.json()
    } catch {
      /* empty body */
    }
    return { status: res.status, ok: res.ok, data, replay: res.headers.get('X-Idempotent-Replay') === 'true' }
  } catch {
    return { status: 0, ok: false, data: { error: `Cannot reach API at ${API_BASE}. Is the backend running?` } as T, replay: false }
  }
}

export function parseJson(s: string | null): Record<string, unknown> | null {
  if (!s) return null
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

export function uuid(): string {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`
}
