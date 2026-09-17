import { createHash } from 'node:crypto';

import type { Pool, PoolConnection } from 'mysql2/promise';

import { CAMPAIGN_RULE_SCHEMA_VERSION, createDefaultCampaignRuleSet } from '@douyin/contracts';

export const DEFAULT_WORKSPACE_ID = '00000000-0000-4000-8000-000000000001';
export const DEFAULT_CAMPAIGN_TEMPLATE_ID = '00000000-0000-4000-8000-000000000101';

export const WORKSPACE_ROLE_DEFINITIONS = [
  {
    key: 'admin',
    displayName: '管理员',
    description: '管理成员、系统配置、任务、复核与合作数据',
    permissions: ['workspace:manage', 'campaign:manage', 'candidate:write', 'outreach:write'],
  },
  {
    key: 'operator',
    displayName: '运营',
    description: '创建采集任务、复核候选并维护合作进度',
    permissions: ['campaign:manage', 'candidate:write', 'outreach:write'],
  },
  {
    key: 'readonly',
    displayName: '只读',
    description: '查看授权范围内的任务、候选与合作进度',
    permissions: ['campaign:read', 'candidate:read', 'outreach:read'],
  },
] as const;

export interface InitialWorkspaceSeedOptions {
  workspaceId?: string;
  workspaceSlug?: string;
  workspaceName?: string;
}

export interface InitialWorkspaceSeedResult {
  workspaceId: string;
  campaignTemplateId: string;
  roleCount: number;
}

export async function seedInitialWorkspace(
  pool: Pool,
  options: InitialWorkspaceSeedOptions = {},
): Promise<InitialWorkspaceSeedResult> {
  const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const workspaceSlug = options.workspaceSlug ?? 'company';
  const workspaceName = options.workspaceName ?? '公司运营工作区';
  const campaignTemplateId = getDefaultCampaignTemplateId(workspaceId);
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();
    await connection.execute(
      `INSERT INTO workspaces (id, slug, name)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE id = id`,
      [workspaceId, workspaceSlug, workspaceName],
    );
    await seedRoles(connection, workspaceId);
    await connection.execute(
      `INSERT INTO campaign_templates
       (id, workspace_id, name, description, rule_schema_version, rules_json, is_system)
       VALUES (?, ?, ?, ?, ?, ?, TRUE)
       ON DUPLICATE KEY UPDATE id = id`,
      [
        campaignTemplateId,
        workspaceId,
        '默认素人爆款筛选',
        '粉丝 0-5000、近 15 天至少一条万赞作品；年龄与素人属性由 AI 辅助，内容类型不限。',
        CAMPAIGN_RULE_SCHEMA_VERSION,
        JSON.stringify(createDefaultCampaignRuleSet()),
      ],
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  return {
    workspaceId,
    campaignTemplateId,
    roleCount: WORKSPACE_ROLE_DEFINITIONS.length,
  };
}

function getDefaultCampaignTemplateId(workspaceId: string): string {
  if (workspaceId === DEFAULT_WORKSPACE_ID) return DEFAULT_CAMPAIGN_TEMPLATE_ID;

  const digest = createHash('sha256')
    .update(`douyin-ops:default-campaign-template:${workspaceId}`)
    .digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

async function seedRoles(connection: PoolConnection, workspaceId: string): Promise<void> {
  for (const role of WORKSPACE_ROLE_DEFINITIONS) {
    await connection.execute(
      `INSERT INTO workspace_roles
       (workspace_id, role_key, display_name, description, permissions_json, is_system)
       VALUES (?, ?, ?, ?, ?, TRUE)
       ON DUPLICATE KEY UPDATE role_key = role_key`,
      [workspaceId, role.key, role.displayName, role.description, JSON.stringify(role.permissions)],
    );
  }
}
