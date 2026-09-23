import {
  AUDIT_FALLBACK_ACTION_LABEL,
  AUDIT_FALLBACK_SUBJECT_LABEL,
  auditActionLabels,
  auditSubjectLabels,
} from '../constants';
import type { AuditAction, AuditEventSummary, AuditSubjectType } from '../types';
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
          events.map((event) => {
            const actionLabel =
              auditActionLabels[event.action as AuditAction] ?? AUDIT_FALLBACK_ACTION_LABEL;
            const subjectLabel =
              auditSubjectLabels[event.subjectType as AuditSubjectType] ??
              AUDIT_FALLBACK_SUBJECT_LABEL;
            return (
              <article className="member-row" key={event.id}>
                <span className="candidate-avatar">审</span>
                <div>
                  {/* 原始英文键只放在 title 里，便于报障时复制，不作为可见文本。 */}
                  <strong title={event.action}>{actionLabel}</strong>
                  <p title={event.subjectType}>{subjectLabel}</p>
                </div>
                <time>{formatRunTime(event.createdAt)}</time>
              </article>
            );
          })
        ) : (
          <EmptyPanel text="暂无审计记录。" />
        )}
      </div>
    </section>
  );
}
