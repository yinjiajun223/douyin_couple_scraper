import { randomUUID } from 'node:crypto';

import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';

import { CAMPAIGN_RULE_SCHEMA_VERSION, campaignRuleSetSchema } from '@douyin/contracts';
import type { CampaignRuleSet } from '@douyin/contracts';

import { writeAuditEvent } from '../audit/audit-events.js';

const nullableText = z.string().trim().max(5_000).nullable().optional();

const createTemplateSchema = z
  .object({
    workspaceId: z.uuid(),
    actorUserId: z.uuid(),
    name: z.string().trim().min(2).max(200),
    description: nullableText,
    rules: campaignRuleSetSchema,
  })
  .strict();

const createCampaignSchema = z
  .object({
    workspaceId: z.uuid(),
    actorUserId: z.uuid(),
    name: z.string().trim().min(2).max(200),
    recommendationProfileDescription: nullableText,
    templateId: z.uuid().optional(),
    rules: campaignRuleSetSchema.optional(),
  })
  .strict()
  .refine((value) => value.templateId || value.rules, {
    message: '必须选择模板或提交筛选规则',
  });

const updateTemplateSchema = z
  .object({
    workspaceId: z.uuid(),
    actorUserId: z.uuid(),
    templateId: z.uuid(),
    expectedVersion: z.number().int().positive(),
    name: z.string().trim().min(2).max(200).optional(),
    description: nullableText,
    rules: campaignRuleSetSchema.optional(),
  })
  .strict();

const updateCampaignSchema = z
  .object({
    workspaceId: z.uuid(),
    actorUserId: z.uuid(),
    campaignId: z.uuid(),
    expectedVersion: z.number().int().positive(),
    name: z.string().trim().min(2).max(200).optional(),
    recommendationProfileDescription: nullableText,
    rules: campaignRuleSetSchema.optional(),
  })
  .strict();

interface TemplateRow extends RowDataPacket {
  description: string | null;
  id: string;
  name: string;
  rule_schema_version: number;
  rules_json: CampaignRuleSet;
  version: number;
}

interface CampaignRow extends RowDataPacket {
  id: string;
  name: string;
  recommendation_profile_description: string | null;
  rule_schema_version: number;
  rules_json: CampaignRuleSet;
  source_template_id: string | null;
  status: 'active' | 'archived';
  version: number;
}

export class CampaignRecordNotFoundError extends Error {
  constructor(recordType: 'template' | 'campaign') {
    super(recordType === 'template' ? '找不到筛选模板' : '找不到筛选任务');
    this.name = 'CampaignRecordNotFoundError';
  }
}

export class CampaignVersionConflictError extends Error {
  constructor(readonly currentVersion: number) {
    super(`数据已经被更新，当前版本为 ${currentVersion}`);
    this.name = 'CampaignVersionConflictError';
  }
}

export async function createCampaignTemplate(pool: Pool, rawInput: unknown) {
  const input = createTemplateSchema.parse(rawInput);
  const id = randomUUID();
  await pool.execute(
    `INSERT INTO campaign_templates
     (id, workspace_id, name, description, rule_schema_version, rules_json, created_by_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.workspaceId,
      input.name,
      input.description ?? null,
      CAMPAIGN_RULE_SCHEMA_VERSION,
      JSON.stringify(input.rules),
      input.actorUserId,
    ],
  );
  await auditRules(pool, input.workspaceId, input.actorUserId, 'campaign_template', id, 'created');
  return { id, version: 1 };
}

export async function createCampaign(pool: Pool, rawInput: unknown) {
  const input = createCampaignSchema.parse(rawInput);
  let rules = input.rules;
  if (input.templateId) {
    const template = await findTemplate(pool, input.workspaceId, input.templateId);
    rules ??= campaignRuleSetSchema.parse(template.rules_json);
  }
  if (!rules) throw new CampaignRecordNotFoundError('template');

  const id = randomUUID();
  await pool.execute(
    `INSERT INTO campaigns
     (id, workspace_id, source_template_id, name, recommendation_profile_description,
      rule_schema_version, rules_json, created_by_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.workspaceId,
      input.templateId ?? null,
      input.name,
      input.recommendationProfileDescription ?? null,
      CAMPAIGN_RULE_SCHEMA_VERSION,
      JSON.stringify(rules),
      input.actorUserId,
    ],
  );
  await auditRules(pool, input.workspaceId, input.actorUserId, 'campaign', id, 'created');
  return { id, version: 1 };
}

export async function copyCampaign(
  pool: Pool,
  workspaceId: string,
  sourceCampaignId: string,
  actorUserId: string,
  name: string,
) {
  const source = await findCampaign(pool, workspaceId, sourceCampaignId);
  return createCampaign(pool, {
    workspaceId,
    actorUserId,
    name,
    recommendationProfileDescription: source.recommendation_profile_description,
    ...(source.source_template_id ? { templateId: source.source_template_id } : {}),
    rules: campaignRuleSetSchema.parse(source.rules_json),
  });
}

export async function updateCampaignTemplate(pool: Pool, rawInput: unknown) {
  const input = updateTemplateSchema.parse(rawInput);
  return withTransaction(pool, async (connection) => {
    const current = await findTemplate(connection, input.workspaceId, input.templateId, true);
    assertVersion(current.version, input.expectedVersion);
    const rules = input.rules ?? campaignRuleSetSchema.parse(current.rules_json);
    await connection.execute(
      `UPDATE campaign_templates
       SET name = ?, description = ?, rule_schema_version = ?, rules_json = ?, version = version + 1
       WHERE workspace_id = ? AND id = ?`,
      [
        input.name ?? current.name,
        input.description === undefined ? current.description : input.description,
        CAMPAIGN_RULE_SCHEMA_VERSION,
        JSON.stringify(rules),
        input.workspaceId,
        input.templateId,
      ],
    );
    await auditRules(
      connection,
      input.workspaceId,
      input.actorUserId,
      'campaign_template',
      input.templateId,
      'updated',
    );
    return { id: input.templateId, version: current.version + 1 };
  });
}

export async function updateCampaign(pool: Pool, rawInput: unknown) {
  const input = updateCampaignSchema.parse(rawInput);
  return withTransaction(pool, async (connection) => {
    const current = await findCampaign(connection, input.workspaceId, input.campaignId, true);
    assertVersion(current.version, input.expectedVersion);
    const rules = input.rules ?? campaignRuleSetSchema.parse(current.rules_json);
    await connection.execute(
      `UPDATE campaigns
       SET name = ?, recommendation_profile_description = ?, rule_schema_version = ?,
           rules_json = ?, version = version + 1
       WHERE workspace_id = ? AND id = ?`,
      [
        input.name ?? current.name,
        input.recommendationProfileDescription === undefined
          ? current.recommendation_profile_description
          : input.recommendationProfileDescription,
        CAMPAIGN_RULE_SCHEMA_VERSION,
        JSON.stringify(rules),
        input.workspaceId,
        input.campaignId,
      ],
    );
    await auditRules(
      connection,
      input.workspaceId,
      input.actorUserId,
      'campaign',
      input.campaignId,
      'updated',
    );
    return { id: input.campaignId, version: current.version + 1 };
  });
}

export async function archiveCampaignTemplate(
  pool: Pool,
  workspaceId: string,
  templateId: string,
  actorUserId: string,
) {
  const template = await findTemplate(pool, workspaceId, templateId);
  await pool.execute(
    `UPDATE campaign_templates
     SET archived_at = CURRENT_TIMESTAMP(3), version = version + 1
     WHERE workspace_id = ? AND id = ?`,
    [workspaceId, templateId],
  );
  await auditRules(pool, workspaceId, actorUserId, 'campaign_template', templateId, 'archived');
  return { id: templateId, version: template.version + 1 };
}

export async function archiveCampaign(
  pool: Pool,
  workspaceId: string,
  campaignId: string,
  actorUserId: string,
) {
  const campaign = await findCampaign(pool, workspaceId, campaignId);
  await pool.execute(
    `UPDATE campaigns
     SET status = 'archived', archived_at = CURRENT_TIMESTAMP(3), version = version + 1
     WHERE workspace_id = ? AND id = ?`,
    [workspaceId, campaignId],
  );
  await auditRules(pool, workspaceId, actorUserId, 'campaign', campaignId, 'archived');
  return { id: campaignId, version: campaign.version + 1 };
}

export async function listCampaignTemplates(pool: Pool, workspaceId: string) {
  const [rows] = await pool.query<TemplateRow[]>(
    `SELECT id, name, description, rule_schema_version, rules_json, version
     FROM campaign_templates WHERE workspace_id = ? AND archived_at IS NULL
     ORDER BY updated_at DESC`,
    [workspaceId],
  );
  return rows;
}

export async function listCampaigns(pool: Pool, workspaceId: string) {
  const [rows] = await pool.query<CampaignRow[]>(
    `SELECT id, source_template_id, name, recommendation_profile_description,
            rule_schema_version, rules_json, status, version
     FROM campaigns WHERE workspace_id = ?
     ORDER BY updated_at DESC`,
    [workspaceId],
  );
  return rows;
}

async function findTemplate(
  executor: Pool | PoolConnection,
  workspaceId: string,
  templateId: string,
  forUpdate = false,
): Promise<TemplateRow> {
  const [rows] = await executor.query<TemplateRow[]>(
    `SELECT id, name, description, rule_schema_version, rules_json, version
     FROM campaign_templates WHERE workspace_id = ? AND id = ?${forUpdate ? ' FOR UPDATE' : ''}`,
    [workspaceId, templateId],
  );
  if (!rows[0]) throw new CampaignRecordNotFoundError('template');
  return rows[0];
}

async function findCampaign(
  executor: Pool | PoolConnection,
  workspaceId: string,
  campaignId: string,
  forUpdate = false,
): Promise<CampaignRow> {
  const [rows] = await executor.query<CampaignRow[]>(
    `SELECT id, source_template_id, name, recommendation_profile_description,
            rule_schema_version, rules_json, status, version
     FROM campaigns WHERE workspace_id = ? AND id = ?${forUpdate ? ' FOR UPDATE' : ''}`,
    [workspaceId, campaignId],
  );
  if (!rows[0]) throw new CampaignRecordNotFoundError('campaign');
  return rows[0];
}

function assertVersion(currentVersion: number, expectedVersion: number) {
  if (currentVersion !== expectedVersion) throw new CampaignVersionConflictError(currentVersion);
}

async function withTransaction<T>(pool: Pool, work: (connection: PoolConnection) => Promise<T>) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function auditRules(
  executor: Pick<Pool | PoolConnection, 'execute'>,
  workspaceId: string,
  actorUserId: string,
  subjectType: 'campaign' | 'campaign_template',
  subjectId: string,
  operation: 'created' | 'updated' | 'archived',
) {
  await writeAuditEvent(executor, {
    workspaceId,
    actorUserId,
    action: 'campaign.rules_updated',
    subjectType,
    subjectId,
    summary: { operation },
  });
}
