import type { AuditEventSummary } from '../types';
import { formatRunTime } from '../lib/format';
import { EmptyPanel } from '../components/EmptyPanel';

export function AuditPage({ events }: { events: AuditEventSummary[] }) {
  return (
    <section>
      <header className="section-page-header">
        <div>
          <p className="eyebrow">SETTINGS / AUDIT</p>
          <h1>审计记录</h1>
          <p className="lede">关键设置、设备、复核、联系状态与导出操作都会留痕。</p>
        </div>
      </header>
      <div className="data-panel">
        {events.length ? (
          events.map((event) => (
            <article className="member-row" key={event.id}>
              <span className="candidate-avatar">审</span>
              <div>
                <strong>{event.action}</strong>
                <p>{event.subjectType}</p>
              </div>
              <time>{formatRunTime(event.createdAt)}</time>
            </article>
          ))
        ) : (
          <EmptyPanel text="暂无审计记录。" />
        )}
      </div>
    </section>
  );
}
