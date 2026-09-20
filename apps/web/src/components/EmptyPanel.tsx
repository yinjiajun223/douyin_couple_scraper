export function EmptyPanel({ text }: { text: string }) {
  return (
    <div className="panel-empty">
      <span aria-hidden="true" className="empty-radar" />
      <p>{text}</p>
    </div>
  );
}
