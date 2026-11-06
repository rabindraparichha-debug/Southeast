import { SLOT_LABEL, formatServiceDate } from '@tiffin/core';
import { istDateTime } from '@/lib/public';
import { Badge, Card } from '@/components/ui';
import type { EngineHealth, EngineJob } from './types';

const JOB_LABEL: Record<string, string> = {
  'tiffin-lock-due-slots': 'Cutoff lock (every minute)',
  'tiffin-nightly': 'Nightly orders and states (00:30)',
  'tiffin-owner-summary': 'Owner summary (22:00)',
  'tiffin-purge': 'Retention purge (03:00)',
  'tiffin-storage-retention': 'Photo retention (03:15)',
};

const ERROR_JOB_LABEL: Record<string, string> = {
  lock: 'Cutoff lock',
  build_runs: 'Building rider runs',
  consume: 'Stock use',
  nightly_status: 'Nightly: subscription states',
  nightly_balance: 'Nightly: balance states',
  nightly_cancel: 'Nightly: auto-cancel',
  nightly_refresh: 'Nightly: meal orders',
  nightly_reminders: 'Nightly: reminders',
};

function jobState(j: EngineJob): { tone: 'green' | 'amber' | 'red'; text: string } {
  if (!j.scheduled || !j.active) return { tone: j.critical ? 'red' : 'amber', text: 'Not scheduled' };
  if (j.stale) return { tone: j.critical ? 'red' : 'amber', text: j.last_ok_at ? 'Late' : 'Never ran' };
  return { tone: 'green', text: j.last_ok_at ? 'OK' : 'Waiting for first run' };
}

/** Engine health for the founder (vendor-first item 30): jobs, counts not frozen, failed runs, engine errors. */
export function EngineTile({ h, healthUrl }: { h: EngineHealth; healthUrl: string }) {
  return (
    <Card
      title="Engine"
      actions={<Badge tone={h.ok ? 'green' : 'red'}>{h.ok ? 'Healthy' : 'Needs attention'}</Badge>}
      className="mb-6"
    >
      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <h3 className="mb-2 text-sm font-medium text-ink-700">Scheduled jobs</h3>
          <ul className="divide-y divide-ink-100 text-sm">
            {h.jobs.map((j) => {
              const st = jobState(j);
              return (
                <li key={j.job} className="flex items-start justify-between gap-2 py-1.5">
                  <span>
                    {JOB_LABEL[j.job] ?? j.job}
                    {!j.critical && <span className="text-xs text-ink-500"> · housekeeping</span>}
                    <span className="block text-xs text-ink-500">
                      {j.last_ok_at ? `Last finished ${istDateTime(j.last_ok_at)}` : 'No finished run yet'}
                      {j.last_duration_ms != null ? ` · ${j.last_duration_ms} ms` : ''}
                    </span>
                  </span>
                  <Badge tone={st.tone}>{st.text}</Badge>
                </li>
              );
            })}
          </ul>
        </div>
        <div className="space-y-4 text-sm">
          <section>
            <h3 className="mb-1 font-medium text-ink-700">Counts not frozen ({h.overdue_slots.count})</h3>
            {h.overdue_slots.count === 0 ? (
              <p className="text-ink-500">Every meal past its cutoff is locked.</p>
            ) : (
              <ul className="space-y-0.5 text-red-800">
                {h.overdue_slots.items.map((o) => (
                  <li key={`${o.kitchen_id}-${o.service_date}-${o.slot}`}>
                    {o.kitchen} · {formatServiceDate(o.service_date)} {SLOT_LABEL[o.slot]} · closed {istDateTime(o.cutoff_at)}
                  </li>
                ))}
                {h.overdue_slots.count > h.overdue_slots.items.length && (
                  <li className="text-ink-500">and {h.overdue_slots.count - h.overdue_slots.items.length} more</li>
                )}
              </ul>
            )}
          </section>
          <section>
            <h3 className="mb-1 font-medium text-ink-700">Failed job runs</h3>
            {h.cron.failing.length === 0 ? (
              <p className="text-ink-500">
                No job is failing. {h.cron.failures_24h} failed run{h.cron.failures_24h === 1 ? '' : 's'} in the last 24 hours.
              </p>
            ) : (
              <ul className="space-y-1 text-red-800">
                {h.cron.failing.map((f) => (
                  <li key={f.job} className={f.critical ? undefined : 'text-amber-800'}>
                    <strong>{JOB_LABEL[f.job] ?? f.job}</strong> · {istDateTime(f.at)}
                    {!f.critical && ' · warning (not critical)'}
                    <span className="block break-words text-xs">{f.message}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section>
            <h3 className="mb-1 font-medium text-ink-700">Engine errors ({h.engine_errors.open} open)</h3>
            {h.engine_errors.open === 0 ? (
              <p className="text-ink-500">No open engine error.</p>
            ) : (
              <>
                <p className="text-ink-500">
                  {h.engine_errors.recent} seen in the last {h.engine_errors.window_hours} hours (these make the engine unhealthy).
                  They close when the same work succeeds, or when the owner dismisses them.
                </p>
                <ul className="mt-1 space-y-1 text-red-800">
                  {h.engine_errors.items.map((e) => (
                    <li key={e.id}>
                      <strong>{e.kitchen ?? 'Platform'}</strong> · {ERROR_JOB_LABEL[e.job] ?? e.job}
                      {e.service_date && ` · ${formatServiceDate(e.service_date)}`}
                      {e.slot && ` ${SLOT_LABEL[e.slot]}`} · last {istDateTime(e.last_seen_at)}
                      {e.attempts > 1 && ` · ${e.attempts} tries`}
                      <span className="block break-words text-xs">{e.message}</span>
                    </li>
                  ))}
                  {h.engine_errors.open > h.engine_errors.items.length && (
                    <li className="text-ink-500">and {h.engine_errors.open - h.engine_errors.items.length} more</li>
                  )}
                </ul>
              </>
            )}
          </section>
          <p className="text-xs text-ink-500">
            Uptime monitor: point a free pinger at <code className="break-all">{healthUrl}</code> and alert on anything but 200.
            Checked {istDateTime(h.checked_at)}.
          </p>
        </div>
      </div>
    </Card>
  );
}
