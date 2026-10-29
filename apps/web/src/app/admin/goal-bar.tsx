// Progress toward a goal: a filled bar plus a tick at the goal when the scale goes beyond it.
export function GoalBar({ value, goal, max = goal, unit = '', label }: { value: number | null; goal: number; max?: number; unit?: string; label: string }) {
  const v = value ?? 0;
  const pct = Math.max(0, Math.min(100, (v / max) * 100));
  const goalPct = Math.min(100, (goal / max) * 100);
  const met = value != null && v >= goal;
  return (
    <div>
      <div
        className="relative h-2.5 overflow-hidden rounded-full bg-ink-100"
        role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={v}
      >
        <div className={`h-full rounded-full ${met ? 'bg-green-600' : 'bg-brand-600'}`} style={{ width: `${pct}%` }} />
        {goalPct < 100 && <div className="absolute inset-y-0 w-0.5 bg-ink-700" style={{ left: `${goalPct}%` }} title={`Goal ${goal}${unit}`} />}
      </div>
      <div className="mt-1 flex justify-between text-xs text-ink-500">
        <span>{value == null ? 'No data yet' : `${v}${unit}`}</span>
        <span>Goal {goal}{unit}{met ? ' ✓' : ''}</span>
      </div>
    </div>
  );
}
