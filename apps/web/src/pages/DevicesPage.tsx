import { useState } from 'react';

import type { Device } from '../types';
import { readResponse } from '../api/client';
import { COLLECTOR_URL } from '../constants';
import { formatRunTime } from '../lib/format';
import { EmptyPanel } from '../components/EmptyPanel';

export function DevicesPage({
  devices,
  csrfToken,
  onChanged,
}: {
  devices: Device[];
  csrfToken: string;
  onChanged: () => void;
}) {
  const [pairingCode, setPairingCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [confirmDevice, setConfirmDevice] = useState<string | null>(null);
  const [showRevoked, setShowRevoked] = useState(false);

  // 已撤销设备无法删除（被采集观测记录外键引用），默认隐藏以免列表越用越长。
  const activeDevices = devices.filter((device) => device.status === 'active');
  const revokedCount = devices.length - activeDevices.length;
  const visibleDevices = showRevoked ? devices : activeDevices;

  async function createPairingCode() {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch('/devices/pairing-codes', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ expiresInMinutes: 10 }),
      });
      const result = await readResponse<{ code: string }>(response);
      setPairingCode(result.code);
    } catch {
      setMessage('配对码生成失败，请检查登录状态和网络后重试。');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(deviceId: string) {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch(`/devices/${encodeURIComponent(deviceId)}/revoke`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'x-csrf-token': csrfToken },
      });
      if (!response.ok) throw new Error('revoke failed');
      setConfirmDevice(null);
      setMessage('授权已撤销，该设备不能继续同步；如需继续使用，请在本机重新配对。');
      onChanged();
    } catch {
      setMessage('撤销失败。请确认你有权管理该设备，并检查网络。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <header className="section-page-header">
        <div>
          <p className="eyebrow">LOCAL / COLLECTOR</p>
          <h1>采集设备</h1>
          <p className="lede">每台运营电脑使用独立令牌，抖音 Cookie 和养号画像始终留在本机。</p>
        </div>
        <button
          className="primary-action"
          disabled={busy}
          onClick={() => void createPairingCode()}
          type="button"
        >
          {busy ? '正在处理…' : '生成配对码'}
        </button>
      </header>
      <div className="workflow-callout">
        <div>
          <strong>首次连接，只需配对一次。</strong>
          <p>
            生成配对码 → 打开本机助手 →
            填写设备名称和配对码。配对成功后，设备列表会自动更新。助手打不开时，请先运行 npm run
            dev:local。
          </p>
        </div>
        <a className="secondary-action" href={COLLECTOR_URL} target="_blank" rel="noreferrer">
          打开本机助手 ↗
        </a>
      </div>
      {message ? (
        <p className="notice-banner" role="status">
          {message}
        </p>
      ) : null}
      {pairingCode ? (
        <div className="pairing-strip">
          <span>10 分钟内在采集助手输入</span>
          <strong>{pairingCode}</strong>
          <small>使用后立即失效</small>
          <button
            className="secondary-action"
            type="button"
            onClick={() =>
              void navigator.clipboard
                .writeText(pairingCode)
                .then(() => setMessage('配对码已复制。'))
                .catch(() => setMessage('浏览器不允许自动复制，请手动选择配对码复制。'))
            }
          >
            复制配对码
          </button>
        </div>
      ) : null}
      <div className="data-panel">
        <div className="table-heading">
          <span>已授权设备</span>
          <span className="table-heading-actions">
            <span>
              {showRevoked
                ? `${activeDevices.length} 台在用 · ${revokedCount} 台已撤销`
                : `${activeDevices.length} 台在用`}
            </span>
            {revokedCount ? (
              <button
                className="text-button dark-text-button"
                onClick={() => setShowRevoked((value) => !value)}
                type="button"
              >
                {showRevoked ? '隐藏已撤销' : `显示已撤销 (${revokedCount})`}
              </button>
            ) : null}
          </span>
        </div>
        {visibleDevices.length ? (
          visibleDevices.map((device) => (
            <article className="device-row" key={device.id}>
              <span className={`device-light ${device.status}`} aria-hidden="true" />
              <div>
                <strong>{device.name}</strong>
                <span>
                  {device.ownerDisplayName} · Collector {device.collectorVersion ?? '未知'}
                </span>
              </div>
              <span>
                {device.status === 'revoked'
                  ? device.revokedAt
                    ? `已撤销 · ${formatRunTime(device.revokedAt)}`
                    : '已撤销'
                  : device.lastSeenAt
                    ? `最近连接 ${formatRunTime(device.lastSeenAt)}`
                    : '尚未上线'}
              </span>
              {device.status === 'active' ? (
                <div className="device-actions">
                  {confirmDevice === device.id ? (
                    <>
                      <span>确认撤销这台设备？</span>
                      <button
                        className="text-button dark-text-button"
                        disabled={busy}
                        onClick={() => void revoke(device.id)}
                        type="button"
                      >
                        确认撤销
                      </button>
                      <button
                        className="text-button dark-text-button"
                        onClick={() => setConfirmDevice(null)}
                        type="button"
                      >
                        取消
                      </button>
                    </>
                  ) : (
                    <button
                      className="text-button dark-text-button"
                      onClick={() => setConfirmDevice(device.id)}
                      type="button"
                    >
                      撤销授权
                    </button>
                  )}
                </div>
              ) : null}
            </article>
          ))
        ) : (
          <EmptyPanel
            text={
              revokedCount
                ? '当前没有在用的设备。已撤销的设备可以用上方开关查看。'
                : '还没有配对设备。生成配对码后，在同事电脑的采集助手中输入。'
            }
          />
        )}
        {showRevoked && revokedCount ? (
          <p className="device-history-note">
            已撤销设备保留为历史记录，无法删除；成员需在本机重新配对后才能继续同步。
          </p>
        ) : null}
      </div>
    </section>
  );
}
