import { useCallback, useEffect, useState } from 'react'
import { call, PRIORITIES, STATUSES, type Stats, type User, type WorkItem } from './api'
import CreateModal from './CreateModal'
import ItemDetail from './ItemDetail'
import JobsDrawer from './JobsDrawer'

const VIEWS = [
  { id: '', label: 'All' },
  { id: 'my_active', label: 'My active' },
  { id: 'unassigned_urgent', label: 'Unassigned urgent' },
  { id: 'awaiting_approval', label: 'Awaiting approval' },
]

interface Pagination { total: number; page: number; limit: number; totalPages: number }

function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

export default function App() {
  const [users, setUsers] = useState<User[]>([])
  const [userId, setUserId] = useState<string>(() => localStorage.getItem('userId') ?? '')
  const [apiError, setApiError] = useState<string | null>(null)

  const [stats, setStats] = useState<Stats | null>(null)
  const [items, setItems] = useState<WorkItem[]>([])
  const [pagination, setPagination] = useState<Pagination | null>(null)
  const [listError, setListError] = useState<string | null>(null)

  const [view, setView] = useState('')
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('')
  const [priority, setPriority] = useState('')
  const [teamId, setTeamId] = useState('')
  const [page, setPage] = useState(1)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [showJobs, setShowJobs] = useState(false)
  const [tick, setTick] = useState(0)

  const dq = useDebounced(q, 300)
  const user = users.find((u) => u.id === userId) ?? null

  useEffect(() => {
    call<User[]>('/users').then((r) => {
      if (r.ok) {
        setUsers(r.data)
        setUserId((cur) => (r.data.some((u) => u.id === cur) ? cur : r.data[0]?.id ?? ''))
      } else {
        setApiError((r.data as { error?: string } | null)?.error ?? (r.status === 0 ? 'backend unreachable' : `API returned ${r.status}`))
      }
    })
  }, [])

  const switchUser = (id: string) => {
    localStorage.setItem('userId', id)
    setUserId(id)
    setPage(1)
    setTeamId('')
  }

  const refresh = useCallback(() => setTick((t) => t + 1), [])

  // Reset to page 1 whenever a filter changes.
  useEffect(() => setPage(1), [view, dq, status, priority, teamId])

  useEffect(() => {
    if (!userId) return
    let cancelled = false
    const params = new URLSearchParams({ page: String(page), limit: '15' })
    if (view) params.set('view', view)
    if (dq.trim()) params.set('q', dq.trim())
    if (status) params.set('status', status)
    if (priority) params.set('priority', priority)
    if (teamId) params.set('teamId', teamId)
    Promise.all([
      call<{ items: WorkItem[]; pagination: Pagination; error?: string }>(`/items?${params}`, { userId }),
      call<Stats>('/stats', { userId }),
    ]).then(([list, s]) => {
      if (cancelled) return
      if (list.ok) {
        setItems(list.data.items)
        setPagination(list.data.pagination)
        setListError(null)
      } else {
        setItems([])
        setListError(list.data?.error ?? `Error ${list.status}`)
      }
      if (s.ok) setStats(s.data)
    })
    return () => {
      cancelled = true
    }
  }, [userId, page, view, dq, status, priority, teamId, tick])

  if (apiError) {
    return (
      <div className="app">
        <div className="banner err">
          Could not load users: {apiError}. Start the backend (<code>npm run dev</code> in <code>backend/</code>).
        </div>
      </div>
    )
  }

  return (
    <div className="app">
      <header className="topbar">
        <h1>Newtonite Ops Tracker</h1>
        <div className="row">
          <label className="inline">
            Acting as
            <select value={userId} onChange={(e) => switchUser(e.target.value)}>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </label>
          <button onClick={() => setShowJobs((s) => !s)}>Jobs</button>
          <button className="primary" onClick={() => setShowCreate(true)} disabled={!user}>
            + New item
          </button>
        </div>
      </header>

      {user && (
        <div className="roles">
          {user.memberships.map((m) => (
            <span key={m.teamId} className="pill">
              {m.teamName}: {m.role}
            </span>
          ))}
          <span className="muted small">Switch users with one click to test permissions and conflicts.</span>
        </div>
      )}

      <section className="cards">
        <button className={`card ${view === 'my_active' ? 'active' : ''}`} onClick={() => setView('my_active')}>
          <div className="num">{stats?.assignedToMe ?? '-'}</div>
          <div>Assigned to me</div>
        </button>
        <button className={`card ${view === 'unassigned_urgent' ? 'active' : ''}`} onClick={() => setView('unassigned_urgent')}>
          <div className="num">{stats?.unassignedUrgent ?? '-'}</div>
          <div>Unassigned urgent</div>
        </button>
        <button className={`card ${view === 'awaiting_approval' ? 'active' : ''}`} onClick={() => setView('awaiting_approval')}>
          <div className="num">{stats?.awaitingApproval ?? '-'}</div>
          <div>Awaiting approval</div>
        </button>
      </section>

      <nav className="tabs">
        {VIEWS.map((v) => (
          <button key={v.id} className={view === v.id ? 'tab active' : 'tab'} onClick={() => setView(v.id)}>
            {v.label}
          </button>
        ))}
      </nav>

      <section className="filters">
        <input placeholder="Search title or description..." value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Any status</option>
          {STATUSES.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <select value={priority} onChange={(e) => setPriority(e.target.value)}>
          <option value="">Any priority</option>
          {PRIORITIES.map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
        <select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
          <option value="">All my teams</option>
          {user?.memberships.map((m) => (
            <option key={m.teamId} value={m.teamId}>
              {m.teamName}
            </option>
          ))}
        </select>
      </section>

      {listError && <div className="banner err">{listError}</div>}

      <main className="layout">
        <div className="list">
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>Team</th>
                <th>Status</th>
                <th>Priority</th>
                <th>Assignee</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.id} className={it.id === selectedId ? 'selected' : ''} onClick={() => setSelectedId(it.id)}>
                  <td>{it.title}</td>
                  <td>{it.team?.name}</td>
                  <td>
                    <span className={`pill s-${it.status}`}>{it.status}</span>
                  </td>
                  <td>
                    <span className={`pill p-${it.priority}`}>{it.priority}</span>
                  </td>
                  <td>{it.assignee?.name ?? <em className="muted">unassigned</em>}</td>
                  <td>{new Date(it.updatedAt).toLocaleDateString()}</td>
                </tr>
              ))}
              {items.length === 0 && !listError && (
                <tr>
                  <td colSpan={6} className="muted">
                    No items match.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {pagination && (
            <div className="row between pager">
              <span className="muted">
                {pagination.total} items - page {pagination.page} of {Math.max(1, pagination.totalPages)}
              </span>
              <div className="row">
                <button disabled={page <= 1} onClick={() => setPage(page - 1)}>
                  Prev
                </button>
                <button disabled={page >= pagination.totalPages} onClick={() => setPage(page + 1)}>
                  Next
                </button>
              </div>
            </div>
          )}
        </div>

        {selectedId && user && (
          <ItemDetail
            key={`${selectedId}:${user.id}`}
            user={user}
            users={users}
            itemId={selectedId}
            onClose={() => setSelectedId(null)}
            onChanged={refresh}
          />
        )}
      </main>

      {showJobs && user && <JobsDrawer user={user} onClose={() => setShowJobs(false)} />}
      {showCreate && user && (
        <CreateModal
          user={user}
          onClose={() => setShowCreate(false)}
          onCreated={(item) => {
            refresh()
            setSelectedId(item.id)
          }}
        />
      )}
    </div>
  )
}
