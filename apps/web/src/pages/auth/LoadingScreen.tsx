export function LoadingScreen() {
  return (
    <main className="auth-layout" aria-busy="true">
      <section className="auth-card loading-card">
        <span className="brand-mark" aria-hidden="true">
          星
        </span>
        <p className="eyebrow">正在确认工作台权限</p>
        <div className="loading-rule" aria-hidden="true" />
      </section>
    </main>
  );
}
