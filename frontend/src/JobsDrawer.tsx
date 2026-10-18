import { useCallback, useEffect, useState } from 'react'
import { call, type Job, type User } from './api'

export default function JobsDrawer({ user, onClose }: { user: User; onClose: () => void }) {
  const [jobs, setJobs] = useState<Job[]>([])

  const refresh = useCallback(async () => {
    const r = await call<Job[]>('/jobs', { userId: user.id })
    if (r.ok) setJobs(r.data)
  }, [user.id])

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 2000)
    return () => clearInterval(t)
  }, [refresh])

  const runNow = async () => {
    const r = await call<Job[]>('/jobs/process', { method: 'POST', userId: user.id })
    if (r.ok) setJobs(r.data)
  }

  return (
    <aside className="drawer">
      <div className="row between">
        <h3>Background jobs</h3>
        <div className="row">
          <button onClick={runNow}>Process now</button>
          <button onClick={onClose}>Close</button>
        </div>
      </div>
      <p className="muted small">
        Enqueued in the same transaction as the change. The worker polls every 3s; failures retry with backoff.
      </p>
      <table>
        <thead>
          <tr>
            <th>Type</th>
            <th>Status</th>
            <th>Tries</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((j) => (
            <tr key={j.id} title={j.lastError ?? j.payload}>
              <td>{j.type}</td>
              <td>
                <span className={`pill job-${j.status}`}>{j.status}</span>
              </td>
              <td>
                {j.attempts}/{j.maxAttempts}
              </td>
              <td>{new Date(j.createdAt).toLocaleTimeString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </aside>
  )
}
