export function RunMetric({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: number | string;
  accent?: boolean;
}) {
  return (
    <div className={accent ? 'run-metric run-metric-accent' : 'run-metric'}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
