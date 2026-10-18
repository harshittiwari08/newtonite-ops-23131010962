import { useRef, useState } from 'react'
import { call, PRIORITIES, TYPES, uuid, type ApiResult, type User, type WorkItem } from './api'

interface Props {
  user: User
  onClose: () => void
  onCreated: (item: WorkItem) => void
}

type CreateResponse = WorkItem & { error?: string }

export default function CreateModal({ user, onClose, onCreated }: Props) {
  const writable = user.memberships.filter((m) => m.role !== 'VIEWER')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [type, setType] = useState('INTERNAL_TASK')
  const [priority, setPriority] = useState('MEDIUM')
  const [teamId, setTeamId] = useState(writable[0]?.teamId ?? '')
  const [dueDate, setDueDate] = useState('')
  const [log, setLog] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  // One key per form session: every retry / double click of THIS form reuses it.
  const keyRef = useRef(uuid())

  const send = () =>
    call<CreateResponse>('/items', {
      method: 'POST',
      userId: user.id,
      headers: { 'Idempotency-Key': keyRef.current },
      body: { title, description, type, priority, teamId, dueDate: dueDate || null },
    })

  const describe = (r: ApiResult<CreateResponse>, label: string) =>
    `${label}: HTTP ${r.status}${r.replay ? ' (X-Idempotent-Replay: true)' : ''} -> ${
      r.ok ? `item ${r.data.id.slice(0, 8)}` : r.data?.error
    }`

  const valid = title.trim() && description.trim() && teamId

  async function submit(copies: number) {
    setBusy(true)
    const results = await Promise.all(Array.from({ length: copies }, () => send()))
    setLog(results.map((r, i) => describe(r, `request ${i + 1}`)))
    setBusy(false)
    const first = results.find((r) => r.ok)
    if (first) onCreated(first.data)
  }

  if (writable.length === 0) {
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <p>{user.name} only has VIEWER access and cannot create items.</p>
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    )
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Create work item</h2>
        <label>
          Title
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label>
          Description
          <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <div className="row">
          <label>
            Team
            <select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
              {writable.map((m) => (
                <option key={m.teamId} value={m.teamId}>
                  {m.teamName}
                </option>
              ))}
            </select>
          </label>
          <label>
            Type
            <select value={type} onChange={(e) => setType(e.target.value)}>
              {TYPES.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
          <label>
            Priority
            <select value={priority} onChange={(e) => setPriority(e.target.value)}>
              {PRIORITIES.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </label>
          <label>
            Due
            <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </label>
        </div>
        <p className="muted small">
          Idempotency-Key for this form: <code>{keyRef.current}</code>
        </p>
        <div className="row">
          <button className="primary" disabled={!valid || busy} onClick={() => submit(1)}>
            Create
          </button>
          <button
            disabled={!valid || busy}
            onClick={() => submit(2)}
            title="Sends two identical requests at once with the same key"
          >
            Test: submit twice at once
          </button>
          <button onClick={onClose}>Close</button>
        </div>
        {log.length > 0 && <pre className="log">{log.join('\n')}</pre>}
      </div>
    </div>
  )
}
