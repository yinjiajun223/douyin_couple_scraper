export function DashboardCard({
  label,
  onClick,
  value,
}: {
  label: string;
  onClick: () => void;
  value: number;
}) {
  return (
    <button className="dashboard-card" onClick={onClick} type="button">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>查看对应记录 →</small>
    </button>
  );
}
