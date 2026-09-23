import { candidateSections } from '../constants';
import { roleLabel } from '../lib/format';
import type { Role } from '../types';

const workflowSections = candidateSections
  .filter((section) => section.value !== 'all')
  .map((section) => section.label)
  .join('、');

export function HelpPage({ role }: { role: Role }) {
  const isAdmin = role === 'admin';

  return (
    <section className="help-page">
      <header className="section-page-header">
        <div>
          <p className="eyebrow">FIELD GUIDE / OPERATIONS</p>
          <h1>操作手册</h1>
          <p className="lede">按真实工作顺序查步骤；遇到异常时，先确认数据停在哪一段。</p>
        </div>
        <span className={`help-role role-chip role-${role}`}>当前身份 · {roleLabel(role)}</span>
      </header>

      <div aria-label="从采集到跟进" className="help-route">
        <article>
          <span>01</span>
          <strong>筛选任务</strong>
          <p>保存规则，创建运行</p>
        </article>
        <article>
          <span>02</span>
          <strong>本机助手</strong>
          <p>选择画像，人工开始</p>
        </article>
        <article>
          <span>03</span>
          <strong>达人库</strong>
          <p>核对证据，完成人工复核</p>
        </article>
        <article>
          <span>04</span>
          <strong>合作跟进</strong>
          <p>分配负责人，追加沟通记录</p>
        </article>
      </div>

      {role === 'readonly' ? (
        <p className="help-role-note">
          只读成员可以查看运行、达人证据和复核历史；修改任务、复核结论与跟进资料需要运营或管理员处理。
        </p>
      ) : null}

      <div className="help-grid">
        <article className="help-card">
          <header className="help-card-heading">
            <span>OPERATIONS</span>
            <h2>运营快速上手</h2>
          </header>

          <section>
            <h3>配对与人工开始</h3>
            <ol>
              <li>在「采集设备」生成配对码。</li>
              <li>
                启动本机助手；控制页未自动打开时，手动访问 <code>http://127.0.0.1:43127</code>。
              </li>
              <li>选择已人工登录的抖音画像，在对应运行点击「人工开始」。</li>
            </ol>
            <p>创建运行、刷新后台或重启助手都不会自动操作抖音。</p>
          </section>

          <section>
            <h3>复核、批量与跟进</h3>
            <ol>
              <li>在「运行监控」查看停止原因和每位达人的判定依据。</li>
              <li>进入「达人库」，在待复核分区核对主页截图和硬筛证据。</li>
              <li>少量逐条保存结论；同一结论较多时勾选后使用「批量通过复核」或批量归档。</li>
              <li>人工通过后自动进入「待联系」，再填写负责人、联系方式和下一步。</li>
            </ol>
            <p>达人库按 {workflowSections} 分区；沟通记录只追加，不覆盖历史。</p>
          </section>

          <section>
            <h3>标签与归档</h3>
            <p>
              标签用于团队分类和筛选，不改变硬筛与复核结论。归档是把达人移出在用列表的唯一方式；
              事实观察和证据不能手工删除或改写，需要时可在「已归档」视图恢复。
            </p>
          </section>
        </article>

        {isAdmin ? (
          <article className="help-card help-admin-card">
            <header className="help-card-heading">
              <span>ADMIN</span>
              <h2>管理员护栏与救援路径</h2>
            </header>

            <section>
              <h3>成员与邀请</h3>
              <p>
                在「成员与邀请」发出或撤销一次性邀请、调整角色、停用和启用成员。停用会立即撤销该成员的会话和设备；
                重新启用不会恢复设备，成员必须在本机重新配对。
              </p>
            </section>

            <section>
              <h3>不可越过的护栏</h3>
              <p>
                不能停用当前登录的自己，工作区也必须保留至少一名启用状态的管理员。
                如果因账号或密码问题已经没有可用管理员，不要直接改业务数据；由具备服务器权限的人按《管理员手册》的救援路径处理并留痕。
              </p>
            </section>

            <section>
              <h3>设备与筛选模板</h3>
              <p>
                设备丢失、换人或授权异常时立即撤销；已撤销设备只能查看历史，不能恢复或删除。
                「筛选模板」由管理员维护，新建、编辑和归档只影响之后创建的任务，不改变旧运行的规则快照。
              </p>
            </section>
          </article>
        ) : (
          <aside className="help-boundary-card">
            <span>TEAM BOUNDARY</span>
            <strong>看不见的管理入口不是故障</strong>
            <p>
              成员生命周期、邀请撤销、设备历史和筛选模板只对管理员开放。需要这些操作时，请联系团队管理员处理。
            </p>
          </aside>
        )}
      </div>

      <section className="help-faq">
        <header>
          <span>QUICK DIAGNOSIS</span>
          <h2>常见问题</h2>
        </header>
        <dl>
          <div>
            <dt>刚采集的达人为什么没进达人库？</dt>
            <dd>
              到「运行监控」打开「本次运行观察到的达人」。任一硬筛为不通过或未知（unknown）都不会创建候选，缺失数据绝不按
              0 猜测。
            </dd>
          </div>
          <div>
            <dt>保存时提示版本冲突怎么办？</dt>
            <dd>
              说明同事先一步保存了修改。刷新到最新版本，重新核对内容后再提交，不要覆盖对方结果。
            </dd>
          </div>
          <div>
            <dt>批量操作显示部分失败怎么办？</dt>
            <dd>成功项已经生效；按页面归并的失败原因处理冲突或权限问题，再只重试失败项。</dd>
          </div>
          <div>
            <dt>归档后找不到达人？</dt>
            <dd>在达人库切换到「已归档」视图。归档不会删除观察、截图或跟进历史，可以逐条恢复。</dd>
          </div>
          <div>
            <dt>成员重新启用后为什么仍不能采集？</dt>
            <dd>
              停用成员会撤销其全部设备，重新启用不会恢复旧令牌。请生成新配对码，并让成员在本机重新配对。
            </dd>
          </div>
        </dl>
      </section>
    </section>
  );
}
