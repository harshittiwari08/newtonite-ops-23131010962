import { useCallback, useEffect, useState } from 'react'
import {
  call,
  parseJson,
  PRIORITIES,
  STATUSES,
  type Activity,
  type ItemDetail as Detail,
  type Priority,
  type Status,
  type User,
  type WorkItem,
} from './api'

interface Props {
  user: User
  users: User[]
  itemId: string
  onClose: () => void
  onChanged: () => void
}

interface Conflict {
  message: string
  current: Partial<WorkItem> | null
}

function canAct(role: string | undefined) {
  return role === 'MEMBER' || role === 'LEAD' || role === 'ADMIN'
}

function diffSummary(a: Activity) {
  const before = parseJson(a.beforeJson) ?? {}
  const after = parseJson(a.afterJson) ?? {}
  const keys = Object.keys(after).filter((k) => k !== 'version' && JSON.stringify(before[k]) !== JSON.stringify(after[k]))
  if (keys.length === 0) return null
  return keys.map((k) => `${k}: ${before[k] === undefined ? '-' : String(before[k])} -> ${String(after[k])}`).join('  |  ')
}

export default function ItemDetail({ user, users, itemId, onClose, onChanged }: Props) {
  const [item, setItem] = useState<Detail | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [conflict, setConflict] = useState<Conflict | null>(null)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  const [target, setTarget] = useState<Status>('IN_PROGRESS')
  const [note, setNote] = useState('')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState({ title: '', description: '', priority: 'MEDIUM' as Priority, assigneeId: '', resolutionNote: '' })
  const [comment, setComment] = useState('')
  const [raceLog, setRaceLog] = useState<string | null>(null)

  const load = useCallback(async () => {
    const r = await call<Detail & { error?: string }>(`/items/${itemId}`, { userId: user.id })
    if (r.ok) {
      setItem(r.data)
      setLoadError(null)
      setNote(r.data.resolutionNote ?? '')
    } else {
      setItem(null)
      setLoadError(`${r.status}: ${r.data?.error ?? 'Failed to load'}`)
    }
    return r
  }, [itemId, user.id])

  useEffect(() => {
    setConflict(null)
    setNotice(null)
    setRaceLog(null)
    setEditing(false)
    load()
  }, [load])

  /** Shared handling for mutating calls: 409 -> conflict banner, other errors -> notice. */
  async function mutate(path: string, method: string, body: unknown, okText: string) {
    const r = await call<any>(`/items/${itemId}${path}`, { method, body, userId: user.id })
    if (r.ok) {
      setConflict(null)
      setNotice({ kind: 'ok', text: okText })
      await load()
      onChanged()
    } else if (r.status === 409) {
      setConflict({ message: r.data.error, current: r.data.currentItem })
      onChanged()
    } else {
      setNotice({ kind: 'err', text: `${r.status}: ${r.data?.error ?? 'Request failed'}` })
    }
    return r
  }

  const reloadLatest = async () => {
    await load()
    setConflict(null)
    setNotice({ kind: 'ok', text: 'Reloaded latest server state.' })
    onChanged()
  }

  if (loadError) {
    return (
      <aside className="panel">
        <div className="row between">
          <h3>Work item</h3>
          <button onClick={onClose}>Close</button>
        </div>
        <div className="banner err">{loadError}</div>
      </aside>
    )
  }
  if (!item) return <aside className="panel">Loading...</aside>

  const writable = canAct(item.currentUserRole)
  const isLead = item.currentUserRole === 'LEAD' || item.currentUserRole === 'ADMIN'
  const teamMembers = users.filter((u) => u.memberships.some((m) => m.teamId === item.teamId && m.role !== 'VIEWER'))

  const startEdit = () => {
    setDraft({
      title: item.title,
      description: item.description,
      priority: item.priority,
      assigneeId: item.assigneeId ?? '',
      resolutionNote: item.resolutionNote ?? '',
    })
    setEditing(true)
  }

  async function saveEdit() {
    const body: Record<string, unknown> = {
      title: draft.title,
      description: draft.description,
      priority: draft.priority,
      resolutionNote: draft.resolutionNote,
      version: item!.version,
    }
    if ((draft.assigneeId || null) !== item!.assigneeId) body.assigneeId = draft.assigneeId || null
    const r = await mutate('', 'PATCH', body, 'Saved.')
    if (r.ok) setEditing(false)
  }

  /** Deliberately send an out-of-date version so evaluators can see optimistic locking reject it. */
  async function simulateStale() {
    if (item!.version === 1) {
      // Make the item newer first with a no-op edit, so version 1 becomes stale.
      const bump = await call(`/items/${itemId}`, {
        method: 'PATCH',
        userId: user.id,
        body: { title: item!.title, version: 1 },
      })
      if (!bump.ok) {
        setNotice({ kind: 'err', text: `Could not prepare stale test: ${bump.data?.error}` })
        return
      }
    }
    await mutate('', 'PATCH', { title: `${item!.title} (stale write)`, version: 1 }, 'Unexpected: stale write accepted')
  }

  /** Fire two claims at once as two different team members. */
  async function simulateRace() {
    const claimers = teamMembers.filter((u) => u.memberships.some((m) => m.teamId === item!.teamId && m.role !== 'VIEWER')).slice(0, 2)
    if (claimers.length < 2) {
      setRaceLog('Need at least two non-viewer members in this team.')
      return
    }
    const results = await Promise.all(claimers.map((u) => call(`/items/${itemId}/claim`, { method: 'POST', userId: u.id })))
    setRaceLog(claimers.map((u, i) => `${u.name}: HTTP ${results[i].status}`).join('   |   '))
    await load()
    onChanged()
  }

  async function addComment() {
    if (!comment.trim()) return
    const r = await mutate('/comments', 'POST', { body: comment }, 'Comment added.')
    if (r.ok) setComment('')
  }

  return (
    <aside className="panel">
      <div className="row between">
        <h3>
          {item.title} <span className="muted small">v{item.version}</span>
        </h3>
        <button onClick={onClose}>Close</button>
      </div>

      {conflict && (
        <div className="banner conflict">
          <strong>409 Conflict.</strong> {conflict.message}
          {conflict.current && (
            <div className="small">
              Server now has: version {conflict.current.version}, status {conflict.current.status}, assignee{' '}
              {conflict.current.assignee?.name ?? 'none'}
            </div>
          )}
          <div>
            <button className="primary" onClick={reloadLatest}>
              Reload latest
            </button>
          </div>
        </div>
      )}
      {notice && <div className={`banner ${notice.kind}`}>{notice.text}</div>}

      <div className="meta">
        <span className={`pill s-${item.status}`}>{item.status}</span>
        <span className={`pill p-${item.priority}`}>{item.priority}</span>
        <span className="pill">{item.type}</span>
        <span className="pill">{item.team?.name}</span>
        <span className="pill">your role: {item.currentUserRole}</span>
      </div>
      <p>{item.description}</p>
      <dl>
        <dt>Assignee</dt>
        <dd>{item.assignee?.name ?? <em>unassigned</em>}</dd>
        <dt>Created by</dt>
        <dd>{item.createdBy?.name}</dd>
        <dt>Due</dt>
        <dd>{item.dueDate ? new Date(item.dueDate).toLocaleDateString() : '-'}</dd>
        <dt>Resolution note</dt>
        <dd>{item.resolutionNote ?? '-'}</dd>
      </dl>

      {!writable && <div className="banner">Read-only: your role in this team is {item.currentUserRole}.</div>}

      {writable && (
        <section>
          <h4>Actions</h4>
          <div className="row">
            <button
              className="primary"
              disabled={!!item.assigneeId}
              onClick={() => mutate('/claim', 'POST', undefined, 'Claimed.')}
              title={item.assigneeId ? 'Already assigned' : 'Atomic claim'}
            >
              Claim
            </button>
            <button onClick={editing ? () => setEditing(false) : startEdit}>{editing ? 'Cancel edit' : 'Edit fields'}</button>
          </div>

          <div className="row transition">
            <select value={target} onChange={(e) => setTarget(e.target.value as Status)}>
              {STATUSES.filter((s) => s !== item.status).map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
            <input
              placeholder="Resolution note (min 5 chars, needed for AWAITING_APPROVAL / RESOLVED)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <button
              className="primary"
              onClick={() => mutate('/transition', 'POST', { targetStatus: target, resolutionNote: note || undefined, version: item.version }, `Moved to ${target}.`)}
            >
              {item.status === 'AWAITING_APPROVAL' && target === 'RESOLVED' && isLead ? 'Approve & resolve' : 'Transition'}
            </button>
          </div>
          <p className="muted small">
            The server enforces the state machine, notes and lead approval; invalid choices are listed on purpose so you can see the rejection.
          </p>

          {editing && (
            <div className="edit">
              <label>
                Title
                <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
              </label>
              <label>
                Description
                <textarea rows={3} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
              </label>
              <div className="row">
                <label>
                  Priority
                  <select value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: e.target.value as Priority })}>
                    {PRIORITIES.map((p) => (
                      <option key={p}>{p}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Assignee {isLead || !item.assigneeId ? '' : '(lead only to change)'}
                  <select value={draft.assigneeId} onChange={(e) => setDraft({ ...draft, assigneeId: e.target.value })}>
                    <option value="">Unassigned</option>
                    {teamMembers.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label>
                Resolution note
                <input value={draft.resolutionNote} onChange={(e) => setDraft({ ...draft, resolutionNote: e.target.value })} />
              </label>
              <button className="primary" onClick={saveEdit}>
                Save (sends version {item.version})
              </button>
            </div>
          )}

          <h4>Concurrency demos</h4>
          <div className="row">
            <button onClick={simulateStale}>Simulate stale edit</button>
            <button onClick={simulateRace} disabled={!!item.assigneeId} title="Fires two claims at the same moment as two different users">
              Simulate simultaneous claim
            </button>
          </div>
          {raceLog && <pre className="log">{raceLog}</pre>}
          <p className="muted small">
            Tip: open this app in two browser tabs as different users, load the same item in both, then edit in each.
          </p>
        </section>
      )}

      <section>
        <h4>Comments ({item.comments.length})</h4>
        {item.comments.map((c) => (
          <div key={c.id} className="comment">
            <strong>{c.author.name}</strong> <span className="muted small">{new Date(c.createdAt).toLocaleString()}</span>
            <div>{c.body}</div>
          </div>
        ))}
        {writable && (
          <div className="row">
            <input placeholder="Add a comment" value={comment} onChange={(e) => setComment(e.target.value)} />
            <button onClick={addComment}>Post</button>
          </div>
        )}
      </section>

      <section>
        <h4>Activity history ({item.activities.length})</h4>
        <ol className="timeline">
          {item.activities.map((a) => (
            <li key={a.id}>
              <strong>{a.action}</strong> by {a.actor.name}{' '}
              <span className="muted small">{new Date(a.createdAt).toLocaleString()}</span>
              {diffSummary(a) && <div className="small mono">{diffSummary(a)}</div>}
            </li>
          ))}
        </ol>
      </section>
    </aside>
  )
}
