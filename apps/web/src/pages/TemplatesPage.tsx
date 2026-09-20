import type { CampaignTemplateSummary } from '../types';
import { EmptyPanel } from '../components/EmptyPanel';

export function TemplatesPage({ templates }: { templates: CampaignTemplateSummary[] }) {
  return (
    <section>
      <header className="section-page-header">
        <div>
          <p className="eyebrow">SETTINGS / TEMPLATES</p>
          <h1>筛选模板</h1>
          <p className="lede">管理员维护团队共用的规则起点，运行时仍会冻结独立快照。</p>
        </div>
      </header>
      <div className="data-panel">
        {templates.length ? (
          templates.map((template) => (
            <article className="member-row" key={template.id}>
              <span className="candidate-avatar">模</span>
              <div>
                <strong>{template.name}</strong>
                <p>{template.description ?? '暂无说明'}</p>
              </div>
              <span className="role-chip">v{template.version}</span>
            </article>
          ))
        ) : (
          <EmptyPanel text="还没有团队筛选模板。" />
        )}
      </div>
    </section>
  );
}
