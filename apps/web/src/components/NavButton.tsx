export function NavButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-current={active ? 'page' : undefined}
      className={`nav-item ${active ? 'nav-item-active' : ''}`}
      onClick={onClick}
      type="button"
    >
      {label}
    </button>
  );
}
