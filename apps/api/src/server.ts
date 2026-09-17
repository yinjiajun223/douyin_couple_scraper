import cookie from '@fastify/cookie';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'mysql2/promise';

import {
  assertCollectorProtocolCompatible,
  IncompatibleCollectorProtocolError,
} from '@douyin/contracts';
import {
  acceptInvitation,
  AiAnalysisNotFoundError,
  AiConnectionNotFoundError,
  appendCandidateNote,
  archiveCampaign,
  archiveCampaignTemplate,
  authenticateDevice,
  authenticateSession,
  deriveSessionCsrfToken,
  CampaignNotActiveError,
  CandidateAccessDeniedError,
  CandidateNotFoundError,
  CandidateVersionConflictError,
  CandidateWorkflowNotFoundError,
  claimCollectionRun,
  confirmMediaUpload,
  CollectorDeviceIdentityMismatchError,
  CollectorRunAccessDeniedError,
  CollectorRunNotIngestibleError,
  CollectionRunDeviceMismatchError,
  CollectionRunNotFoundError,
  CollectionRunNotRunningError,
  createDevicePairingCode,
  createCampaign,
  createCampaignTemplate,
  createCollectionRun,
  createInvitation,
  createAiConnection,
  createMysqlPool,
  exportCandidateCsv,
  InvalidCredentialsError,
  CampaignRecordNotFoundError,
  CampaignVersionConflictError,
  InvitationAlreadyUsedError,
  InvitationExpiredError,
  InvitationNotFoundError,
  InvitedEmailAlreadyExistsError,
  InvalidPipelineTransitionError,
  InvalidRunStatusTransitionError,
  IngestionAlreadyProcessingError,
  IngestionIdempotencyConflictError,
  ingestCollectorBatch,
  issueMediaAccessUrl,
  issueMediaUpload,
  getCandidateDetail,
  getCandidateWorkflow,
  getOperationsDashboard,
  listAiAnalysisHistory,
  listAuditEvents,
  listAiConnections,
  listCampaigns,
  listCandidatePage,
  listCollectionRuns,
  listCampaignTemplates,
  listReadyCollectionRuns,
  listCollectorRuns,
  listWorkspaceDevices,
  listWorkspaceMembers,
  hasPermission,
  DeviceAccessDeniedError,
  DeviceNotActiveError,
  isValidCsrfToken,
  loginWithPassword,
  MediaObservationAccessDeniedError,
  MediaConfirmationMismatchError,
  MediaObjectNotFoundError,
  MediaRunAccessDeniedError,
  MediaRunNotAcceptingUploadError,
  MediaStoredObjectUnavailableError,
  MediaUploadExpiredError,
  pairDevice,
  copyCampaign,
  PairingCodeAlreadyUsedError,
  PairingCodeExpiredError,
  PairingCodeInvalidError,
  parseApiConfig,
  pauseCollectionRun,
  pauseCollectionRunByDevice,
  reportCollectionRunProgress,
  queueAiReanalysis,
  resumeCollectionRun,
  resumeCollectionRunByDevice,
  revokeAllUserSessions,
  revokeDevice,
  revokeSession,
  rotateDeviceToken,
  replaceAiConnectionCredential,
  RunProgressRegressionError,
  SESSION_TTL_SECONDS,
  startClaimedCollectionRun,
  submitManualReview,
  testAiConnection,
  terminateCollectionRun,
  terminateCollectionRunByDevice,
  transitionCandidatePipeline,
  updateCampaign,
  updateCampaignTemplate,
  updateCandidateOutreach,
  AliyunObjectStorageClient,
  CredentialCipher,
  OutreachVersionConflictError,
} from '@douyin/domain';
import type {
  DevicePrincipal,
  ObjectStorageClient,
  Permission,
  AiProvider,
  OpenAiCompatibleProviderConfig,
  SessionPrincipal,
} from '@douyin/domain';
import { runReadinessChecks } from './health.js';
import type { ReadinessChecks } from './health.js';

const SESSION_COOKIE_NAME = 'douyin_session';

export interface BuildServerOptions {
  aiProviderFactory?: (config: OpenAiCompatibleProviderConfig) => AiProvider;
  credentialCipher?: CredentialCipher;
  collectorMinVersion?: string;
  pool: Pool;
  logger?: boolean;
  objectStorage?: ObjectStorageClient;
  readinessChecks?: ReadinessChecks;
  secureCookies?: boolean;
}

export async function authorizeBrowserRequest(
  pool: Pool,
  request: FastifyRequest,
  reply: FastifyReply,
  permission?: Permission,
  requireCsrf = false,
): Promise<SessionPrincipal | null> {
  const principal = await authenticateSession(pool, request.cookies[SESSION_COOKIE_NAME]);
  if (!principal) {
    void reply.code(401).send({ code: 'UNAUTHENTICATED' });
    return null;
  }
  if (permission && !hasPermission(principal.role, permission)) {
    void reply.code(403).send({ code: 'FORBIDDEN', permission });
    return null;
  }
  if (
    requireCsrf &&
    !isValidCsrfToken(principal, request.headers['x-csrf-token'] as string | undefined)
  ) {
    void reply.code(403).send({ code: 'INVALID_CSRF_TOKEN' });
    return null;
  }
  return principal;
}

async function authorizeCollectorRequest(
  pool: Pool,
  request: FastifyRequest,
  reply: FastifyReply,
  collectorMinVersion: string,
): Promise<DevicePrincipal | null> {
  const device = await authenticateDevice(pool, bearerToken(request.headers.authorization));
  if (!device) {
    void reply.code(401).send({ code: 'INVALID_DEVICE_TOKEN' });
    return null;
  }
  const reportedProtocol = singleHeader(request.headers['x-collector-protocol-version']);
  const reportedCollector = singleHeader(request.headers['x-collector-version']);
  const reportedParser = singleHeader(request.headers['x-parser-version']);
  try {
    if (reportedProtocol) assertCollectorProtocolCompatible(reportedProtocol);
  } catch (error) {
    if (error instanceof IncompatibleCollectorProtocolError) {
      void reply.code(426).send({
        code: 'COLLECTOR_UPGRADE_REQUIRED',
        minimumCollectorVersion: collectorMinVersion,
        requiredProtocolVersion: '1.0.0',
      });
      return null;
    }
    throw error;
  }
  const effectiveCollectorVersion = reportedCollector ?? device.collectorVersion;
  if (
    !effectiveCollectorVersion ||
    !isSemanticVersion(effectiveCollectorVersion) ||
    compareSemanticVersions(effectiveCollectorVersion, collectorMinVersion) < 0 ||
    (reportedParser !== undefined && !isSemanticVersion(reportedParser))
  ) {
    void reply.code(426).send({
      code: 'COLLECTOR_UPGRADE_REQUIRED',
      currentCollectorVersion: effectiveCollectorVersion,
      minimumCollectorVersion: collectorMinVersion,
      requiredProtocolVersion: '1.0.0',
    });
    return null;
  }
  if (reportedCollector || reportedParser) {
    await pool.execute(
      `UPDATE devices
       SET collector_version = COALESCE(?, collector_version),
           parser_version = COALESCE(?, parser_version),
           updated_at = CURRENT_TIMESTAMP(3)
       WHERE id = ?`,
      [reportedCollector ?? null, reportedParser ?? null, device.deviceId],
    );
  }
  request.log.info(
    { deviceId: device.deviceId, workspaceId: device.workspaceId },
    'collector request authenticated',
  );
  return device;
}

export function buildServer({
  aiProviderFactory,
  collectorMinVersion = '0.1.0',
  credentialCipher,
  pool,
  logger = true,
  objectStorage,
  readinessChecks,
  secureCookies = process.env.NODE_ENV === 'production',
}: BuildServerOptions) {
  const server = Fastify({
    genReqId(request) {
      const supplied = request.headers['x-request-id'];
      return typeof supplied === 'string' && supplied.length <= 128 ? supplied : randomUUID();
    },
    logger: logger
      ? {
          level: process.env.LOG_LEVEL ?? 'info',
          redact: {
            censor: '[REDACTED]',
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'res.headers.set-cookie',
              '*.password',
              '*.token',
              '*.apiKey',
              '*.accessKeyId',
              '*.accessKeySecret',
              '*.credential',
              '*.secret',
            ],
          },
        }
      : false,
  });
  const cookieOptions = {
    httpOnly: true,
    secure: secureCookies,
    sameSite: 'strict' as const,
    path: '/',
  };

  void server.register(cookie);

  server.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });
  server.addHook('preHandler', async (request) => {
    const params = request.params as Record<string, unknown> | undefined;
    const correlationIds = Object.fromEntries(
      ['runId', 'deviceId', 'jobId', 'candidateId']
        .map((key) => [key, params?.[key]] as const)
        .filter((entry): entry is readonly [string, string] => typeof entry[1] === 'string'),
    );
    if (Object.keys(correlationIds).length > 0) {
      request.log.info(correlationIds, 'request resource context');
    }
  });

  server.get('/health/live', async () => ({ status: 'ok' }));
  server.get('/health/ready', async (_request, reply) => {
    const checks =
      readinessChecks ??
      ({
        mysql: {
          check: async () => {
            await pool.query('SELECT 1');
          },
          required: true,
        },
      } satisfies ReadinessChecks);
    const report = await runReadinessChecks(checks);
    return reply.code(report.status === 'unavailable' ? 503 : 200).send(report);
  });

  server.post<{ Body: unknown }>('/auth/login', async (request, reply) => {
    try {
      const login = await loginWithPassword(pool, request.body);
      reply.setCookie(SESSION_COOKIE_NAME, login.sessionToken, {
        ...cookieOptions,
        maxAge: SESSION_TTL_SECONDS,
        expires: login.expiresAt,
      });
      return {
        csrfToken: login.csrfToken,
        user: {
          id: login.principal.userId,
          workspaceId: login.principal.workspaceId,
          email: login.principal.email,
          displayName: login.principal.displayName,
          role: login.principal.role,
        },
      };
    } catch (error) {
      if (error instanceof InvalidCredentialsError) {
        return reply.code(401).send({ code: 'INVALID_CREDENTIALS', message: error.message });
      }
      if (error instanceof Error && error.name === 'ZodError') {
        return reply.code(400).send({ code: 'INVALID_REQUEST', message: '登录信息格式不正确' });
      }
      throw error;
    }
  });

  server.get('/auth/me', async (request, reply) => {
    const principal = await authenticateSession(pool, request.cookies[SESSION_COOKIE_NAME]);
    if (!principal) return reply.code(401).send({ code: 'UNAUTHENTICATED' });
    const csrfToken = deriveSessionCsrfToken(request.cookies[SESSION_COOKIE_NAME]!);
    reply.header('cache-control', 'no-store');
    return {
      ...(isValidCsrfToken(principal, csrfToken) ? { csrfToken } : {}),
      user: {
        id: principal.userId,
        workspaceId: principal.workspaceId,
        email: principal.email,
        displayName: principal.displayName,
        role: principal.role,
      },
    };
  });

  server.post('/auth/logout', async (request, reply) => {
    const sessionToken = request.cookies[SESSION_COOKIE_NAME];
    const principal = await authenticateSession(pool, sessionToken);
    if (!principal) return reply.code(401).send({ code: 'UNAUTHENTICATED' });
    if (!isValidCsrfToken(principal, request.headers['x-csrf-token'] as string | undefined)) {
      return reply.code(403).send({ code: 'INVALID_CSRF_TOKEN' });
    }

    await revokeSession(pool, sessionToken!);
    reply.clearCookie(SESSION_COOKIE_NAME, cookieOptions);
    return reply.code(204).send();
  });

  server.post('/auth/sessions/revoke-all', async (request, reply) => {
    const principal = await authenticateSession(pool, request.cookies[SESSION_COOKIE_NAME]);
    if (!principal) return reply.code(401).send({ code: 'UNAUTHENTICATED' });
    if (!isValidCsrfToken(principal, request.headers['x-csrf-token'] as string | undefined)) {
      return reply.code(403).send({ code: 'INVALID_CSRF_TOKEN' });
    }

    await revokeAllUserSessions(pool, principal.userId);
    reply.clearCookie(SESSION_COOKIE_NAME, cookieOptions);
    return reply.code(204).send();
  });

  server.post<{ Body: unknown }>('/invitations', async (request, reply) => {
    const principal = await authorizeBrowserRequest(pool, request, reply, 'members:manage', true);
    if (!principal) return;

    const body = request.body as {
      email?: unknown;
      expiresInHours?: unknown;
      role?: unknown;
    };
    try {
      const invitation = await createInvitation(pool, {
        workspaceId: principal.workspaceId,
        email: body.email,
        role: body.role,
        invitedByUserId: principal.userId,
        expiresInSeconds:
          typeof body.expiresInHours === 'number' ? body.expiresInHours * 60 * 60 : Number.NaN,
      });
      return reply.code(201).send(invitation);
    } catch (error) {
      if (error instanceof Error && error.name === 'ZodError') {
        return reply.code(400).send({ code: 'INVALID_REQUEST', message: '邀请信息格式不正确' });
      }
      throw error;
    }
  });

  server.post<{ Body: unknown }>('/auth/invitations/accept', async (request, reply) => {
    try {
      const accepted = await acceptInvitation(pool, request.body);
      return reply.code(201).send(accepted);
    } catch (error) {
      if (error instanceof InvitationNotFoundError) {
        return reply.code(404).send({ code: 'INVITATION_NOT_FOUND' });
      }
      if (error instanceof InvitationExpiredError) {
        return reply.code(410).send({ code: 'INVITATION_EXPIRED' });
      }
      if (error instanceof InvitationAlreadyUsedError) {
        return reply.code(409).send({ code: 'INVITATION_ALREADY_USED' });
      }
      if (error instanceof InvitedEmailAlreadyExistsError) {
        return reply.code(409).send({ code: 'EMAIL_ALREADY_EXISTS' });
      }
      if (error instanceof Error && error.name === 'ZodError') {
        return reply.code(400).send({ code: 'INVALID_REQUEST', message: '账户信息格式不正确' });
      }
      throw error;
    }
  });

  server.post<{ Body: unknown }>('/devices/pairing-codes', async (request, reply) => {
    const principal = await authorizeBrowserRequest(pool, request, reply, 'device:manage', true);
    if (!principal) return;
    const body = request.body as { expiresInMinutes?: unknown };
    const expiresInSeconds =
      typeof body.expiresInMinutes === 'number' ? body.expiresInMinutes * 60 : undefined;
    try {
      const pairing = await createDevicePairingCode(
        pool,
        principal.workspaceId,
        principal.userId,
        expiresInSeconds,
      );
      return reply.code(201).send(pairing);
    } catch (error) {
      if (error instanceof RangeError) {
        return reply.code(400).send({ code: 'INVALID_PAIRING_EXPIRY' });
      }
      throw error;
    }
  });

  server.post<{ Body: unknown }>('/collector/pair', async (request, reply) => {
    try {
      const device = await pairDevice(pool, request.body);
      return reply.code(201).send(device);
    } catch (error) {
      if (error instanceof PairingCodeInvalidError) {
        return reply.code(404).send({ code: 'PAIRING_CODE_INVALID' });
      }
      if (error instanceof PairingCodeExpiredError) {
        return reply.code(410).send({ code: 'PAIRING_CODE_EXPIRED' });
      }
      if (error instanceof PairingCodeAlreadyUsedError) {
        return reply.code(409).send({ code: 'PAIRING_CODE_ALREADY_USED' });
      }
      if (error instanceof Error && error.name === 'ZodError') {
        return reply.code(400).send({ code: 'INVALID_REQUEST' });
      }
      throw error;
    }
  });

  server.get('/collector/me', async (request, reply) => {
    const device = await authenticateDevice(pool, bearerToken(request.headers.authorization));
    if (!device) return reply.code(401).send({ code: 'INVALID_DEVICE_TOKEN' });
    return { device };
  });

  server.get('/collector/runs', async (request, reply) => {
    const device = await authorizeCollectorRequest(pool, request, reply, collectorMinVersion);
    if (!device) return;
    return { runs: await listCollectorRuns(pool, device.workspaceId, device.deviceId) };
  });

  server.get<{ Querystring: { limit?: string } }>(
    '/collector/runs/ready',
    async (request, reply) => {
      const device = await authorizeCollectorRequest(pool, request, reply, collectorMinVersion);
      if (!device) return;
      const requestedLimit = Number(request.query.limit ?? 20);
      return {
        runs: await listReadyCollectionRuns(
          pool,
          device.workspaceId,
          Number.isFinite(requestedLimit) ? requestedLimit : 20,
        ),
      };
    },
  );

  server.post<{ Params: { runId: string } }>(
    '/collector/runs/:runId/claim',
    async (request, reply) => {
      const device = await authorizeCollectorRequest(pool, request, reply, collectorMinVersion);
      if (!device) return;
      try {
        return await claimCollectionRun(pool, {
          workspaceId: device.workspaceId,
          runId: request.params.runId,
          deviceId: device.deviceId,
        });
      } catch (error) {
        return handleCollectionRunError(error, reply);
      }
    },
  );

  server.post<{ Params: { runId: string } }>(
    '/collector/runs/:runId/start',
    async (request, reply) => {
      const device = await authorizeCollectorRequest(pool, request, reply, collectorMinVersion);
      if (!device) return;
      try {
        return await startClaimedCollectionRun(pool, {
          workspaceId: device.workspaceId,
          runId: request.params.runId,
          deviceId: device.deviceId,
        });
      } catch (error) {
        return handleCollectionRunError(error, reply);
      }
    },
  );

  server.post<{ Body: unknown; Params: { runId: string } }>(
    '/collector/runs/:runId/progress',
    async (request, reply) => {
      const device = await authorizeCollectorRequest(pool, request, reply, collectorMinVersion);
      if (!device) return;
      try {
        return await reportCollectionRunProgress(pool, {
          workspaceId: device.workspaceId,
          runId: request.params.runId,
          deviceId: device.deviceId,
          progress: request.body,
        });
      } catch (error) {
        return handleCollectionRunError(error, reply);
      }
    },
  );

  for (const [action, handler] of [
    ['pause', pauseCollectionRunByDevice],
    ['resume', resumeCollectionRunByDevice],
    ['terminate', terminateCollectionRunByDevice],
  ] as const) {
    server.post<{ Params: { runId: string } }>(
      `/collector/runs/:runId/${action}`,
      async (request, reply) => {
        const device = await authorizeCollectorRequest(pool, request, reply, collectorMinVersion);
        if (!device) return;
        try {
          return await handler(pool, {
            workspaceId: device.workspaceId,
            runId: request.params.runId,
            deviceId: device.deviceId,
          });
        } catch (error) {
          return handleCollectionRunError(error, reply);
        }
      },
    );
  }

  server.post<{ Body: unknown; Params: { mediaId: string; runId: string } }>(
    '/collector/runs/:runId/media/:mediaId/confirm',
    async (request, reply) => {
      const device = await authorizeCollectorRequest(pool, request, reply, collectorMinVersion);
      if (!device) return;
      if (!objectStorage) {
        return reply.code(503).send({ code: 'OBJECT_STORAGE_UNAVAILABLE' });
      }
      try {
        return await confirmMediaUpload(
          pool,
          objectStorage,
          device,
          request.params.runId,
          request.params.mediaId,
          request.body,
        );
      } catch (error) {
        return handleMediaError(error, reply);
      }
    },
  );

  server.post<{ Body: unknown }>('/collector/ingestion/batches', async (request, reply) => {
    const device = await authorizeCollectorRequest(pool, request, reply, collectorMinVersion);
    if (!device) return;
    try {
      return await ingestCollectorBatch(pool, device, request.body);
    } catch (error) {
      return handleCollectorIngestionError(error, reply);
    }
  });

  server.post<{ Body: unknown; Params: { runId: string } }>(
    '/collector/runs/:runId/media/uploads',
    async (request, reply) => {
      const device = await authorizeCollectorRequest(pool, request, reply, collectorMinVersion);
      if (!device) return;
      if (!objectStorage) {
        return reply.code(503).send({ code: 'OBJECT_STORAGE_UNAVAILABLE' });
      }
      try {
        return reply
          .code(201)
          .send(
            await issueMediaUpload(pool, objectStorage, device, request.params.runId, request.body),
          );
      } catch (error) {
        return handleMediaError(error, reply);
      }
    },
  );

  server.get<{ Querystring: { limit?: string } }>('/audit-events', async (request, reply) => {
    const principal = await authorizeBrowserRequest(pool, request, reply, 'audit:read');
    if (!principal) return;
    const requestedLimit = request.query.limit ? Number(request.query.limit) : 100;
    return {
      events: await listAuditEvents(
        pool,
        principal.workspaceId,
        Number.isFinite(requestedLimit) ? requestedLimit : 100,
      ),
    };
  });

  server.get<{ Params: { mediaId: string } }>('/media/:mediaId/access', async (request, reply) => {
    const principal = await authorizeBrowserRequest(pool, request, reply, 'candidate:read');
    if (!principal) return;
    if (!objectStorage) {
      return reply.code(503).send({ code: 'OBJECT_STORAGE_UNAVAILABLE' });
    }
    try {
      return await issueMediaAccessUrl(
        pool,
        objectStorage,
        {
          actorRole: principal.role,
          actorUserId: principal.userId,
          workspaceId: principal.workspaceId,
        },
        request.params.mediaId,
      );
    } catch (error) {
      return handleMediaError(error, reply);
    }
  });

  server.get('/members', async (request, reply) => {
    const principal = await authorizeBrowserRequest(pool, request, reply, 'members:manage');
    if (!principal) return;
    return { members: await listWorkspaceMembers(pool, principal.workspaceId) };
  });

  server.get('/members/assignable', async (request, reply) => {
    const principal = await authorizeBrowserRequest(pool, request, reply, 'outreach:write');
    if (!principal) return;
    const members = await listWorkspaceMembers(pool, principal.workspaceId);
    return {
      members: members
        .filter((member) => member.status === 'active')
        .map((member) => ({ id: member.id, displayName: member.displayName })),
    };
  });

  server.get('/dashboard', async (request, reply) => {
    const principal = await authorizeBrowserRequest(pool, request, reply, 'candidate:read');
    if (!principal) return;
    return getOperationsDashboard(pool, {
      actorRole: principal.role,
      actorUserId: principal.userId,
      workspaceId: principal.workspaceId,
    });
  });

  server.get('/ai-connections', async (request, reply) => {
    const principal = await authorizeBrowserRequest(pool, request, reply, 'ai-connection:manage');
    if (!principal) return;
    return { connections: await listAiConnections(pool, principal.workspaceId) };
  });

  server.post<{ Body: unknown }>('/ai-connections', async (request, reply) => {
    const principal = await authorizeBrowserRequest(
      pool,
      request,
      reply,
      'ai-connection:manage',
      true,
    );
    if (!principal) return;
    if (!credentialCipher) return reply.code(503).send({ code: 'AI_CONFIG_UNAVAILABLE' });
    try {
      return reply.code(201).send(
        await createAiConnection(pool, credentialCipher, {
          ...(request.body as Record<string, unknown>),
          actorUserId: principal.userId,
          workspaceId: principal.workspaceId,
        }),
      );
    } catch (error) {
      return handleAiConnectionError(error, reply);
    }
  });

  server.put<{ Body: unknown; Params: { connectionId: string } }>(
    '/ai-connections/:connectionId/credential',
    async (request, reply) => {
      const principal = await authorizeBrowserRequest(
        pool,
        request,
        reply,
        'ai-connection:manage',
        true,
      );
      if (!principal) return;
      if (!credentialCipher) return reply.code(503).send({ code: 'AI_CONFIG_UNAVAILABLE' });
      try {
        const body = request.body as { apiKey?: unknown };
        await replaceAiConnectionCredential(pool, credentialCipher, {
          actorUserId: principal.userId,
          apiKey: typeof body.apiKey === 'string' ? body.apiKey : '',
          connectionId: request.params.connectionId,
          workspaceId: principal.workspaceId,
        });
        return reply.code(204).send();
      } catch (error) {
        return handleAiConnectionError(error, reply);
      }
    },
  );

  server.post<{ Params: { connectionId: string } }>(
    '/ai-connections/:connectionId/test',
    async (request, reply) => {
      const principal = await authorizeBrowserRequest(
        pool,
        request,
        reply,
        'ai-connection:manage',
        true,
      );
      if (!principal) return;
      if (!credentialCipher) return reply.code(503).send({ code: 'AI_CONFIG_UNAVAILABLE' });
      try {
        return await testAiConnection(
          pool,
          credentialCipher,
          principal.workspaceId,
          request.params.connectionId,
          aiProviderFactory,
        );
      } catch (error) {
        return handleAiConnectionError(error, reply);
      }
    },
  );

  server.get('/devices', async (request, reply) => {
    const principal = await authorizeBrowserRequest(pool, request, reply, 'device:manage');
    if (!principal) return;
    return {
      devices: await listWorkspaceDevices(
        pool,
        principal.workspaceId,
        principal.userId,
        principal.role,
      ),
    };
  });

  server.get('/campaign-templates', async (request, reply) => {
    const principal = await authorizeBrowserRequest(pool, request, reply, 'workspace:manage');
    if (!principal) return;
    return { templates: await listCampaignTemplates(pool, principal.workspaceId) };
  });

  server.post<{ Body: unknown }>('/campaign-templates', async (request, reply) => {
    const principal = await authorizeBrowserRequest(pool, request, reply, 'workspace:manage', true);
    if (!principal) return;
    try {
      return reply.code(201).send(
        await createCampaignTemplate(pool, {
          ...(request.body as Record<string, unknown>),
          workspaceId: principal.workspaceId,
          actorUserId: principal.userId,
        }),
      );
    } catch (error) {
      return handleCampaignError(error, reply);
    }
  });

  server.patch<{ Body: unknown; Params: { templateId: string } }>(
    '/campaign-templates/:templateId',
    async (request, reply) => {
      const principal = await authorizeBrowserRequest(
        pool,
        request,
        reply,
        'workspace:manage',
        true,
      );
      if (!principal) return;
      try {
        return await updateCampaignTemplate(pool, {
          ...(request.body as Record<string, unknown>),
          workspaceId: principal.workspaceId,
          actorUserId: principal.userId,
          templateId: request.params.templateId,
        });
      } catch (error) {
        return handleCampaignError(error, reply);
      }
    },
  );

  server.post<{ Params: { templateId: string } }>(
    '/campaign-templates/:templateId/archive',
    async (request, reply) => {
      const principal = await authorizeBrowserRequest(
        pool,
        request,
        reply,
        'workspace:manage',
        true,
      );
      if (!principal) return;
      try {
        return await archiveCampaignTemplate(
          pool,
          principal.workspaceId,
          request.params.templateId,
          principal.userId,
        );
      } catch (error) {
        return handleCampaignError(error, reply);
      }
    },
  );

  server.get('/campaigns', async (request, reply) => {
    const principal = await authorizeBrowserRequest(pool, request, reply, 'campaign:read');
    if (!principal) return;
    return { campaigns: await listCampaigns(pool, principal.workspaceId) };
  });

  server.get<{
    Querystring: {
      campaignId?: string;
      cursor?: string;
      discoveredFrom?: string;
      discoveredTo?: string;
      observedFrom?: string;
      observedTo?: string;
      followerMin?: string;
      followerMax?: string;
      hardFilterStatus?: string;
      manualDecision?: string;
      pipelineStatus?: string;
      ownerUserId?: string;
      tags?: string;
      limit?: string;
      memberUserId?: string;
    };
  }>('/candidates', async (request, reply) => {
    const principal = await authorizeBrowserRequest(pool, request, reply, 'candidate:read');
    if (!principal) return;
    const query = request.query;
    try {
      return await listCandidatePage(pool, {
        actorRole: principal.role,
        actorUserId: principal.userId,
        workspaceId: principal.workspaceId,
        ...(query.campaignId ? { campaignId: query.campaignId } : {}),
        ...(query.cursor ? { cursor: query.cursor } : {}),
        ...(query.discoveredFrom ? { discoveredFrom: query.discoveredFrom } : {}),
        ...(query.discoveredTo ? { discoveredTo: query.discoveredTo } : {}),
        ...(query.observedFrom ? { observedFrom: query.observedFrom } : {}),
        ...(query.observedTo ? { observedTo: query.observedTo } : {}),
        ...(query.followerMin ? { followerMin: Number(query.followerMin) } : {}),
        ...(query.followerMax ? { followerMax: Number(query.followerMax) } : {}),
        ...(query.hardFilterStatus ? { hardFilterStatus: query.hardFilterStatus } : {}),
        ...(query.manualDecision ? { manualDecision: query.manualDecision } : {}),
        ...(query.pipelineStatus ? { pipelineStatus: query.pipelineStatus } : {}),
        ...(query.ownerUserId ? { ownerUserId: query.ownerUserId } : {}),
        ...(principal.role === 'admin' && query.memberUserId
          ? { memberUserId: query.memberUserId }
          : {}),
        ...(query.tags
          ? {
              tagNames: query.tags
                .split(',')
                .map((tag) => tag.trim())
                .filter(Boolean),
            }
          : {}),
        ...(query.limit ? { limit: Number(query.limit) } : {}),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'ZodError') {
        return reply.code(400).send({ code: 'INVALID_CANDIDATE_FILTERS' });
      }
      throw error;
    }
  });

  server.get<{
    Querystring: {
      campaignId?: string;
      discoveredFrom?: string;
      discoveredTo?: string;
      followerMax?: string;
      followerMin?: string;
      hardFilterStatus?: string;
      limit?: string;
      manualDecision?: string;
      memberUserId?: string;
      observedFrom?: string;
      observedTo?: string;
      ownerUserId?: string;
      pipelineStatus?: string;
      tags?: string;
    };
  }>('/exports/candidates.csv', async (request, reply) => {
    const principal = await authorizeBrowserRequest(pool, request, reply, 'export:run');
    if (!principal) return;
    const query = request.query;
    try {
      const result = await exportCandidateCsv(pool, {
        actorRole: principal.role,
        actorUserId: principal.userId,
        filters: {
          ...(query.campaignId ? { campaignId: query.campaignId } : {}),
          ...(query.followerMin ? { followerMin: Number(query.followerMin) } : {}),
          ...(query.followerMax ? { followerMax: Number(query.followerMax) } : {}),
          ...(query.hardFilterStatus ? { hardFilterStatus: query.hardFilterStatus } : {}),
          ...(query.discoveredFrom ? { discoveredFrom: query.discoveredFrom } : {}),
          ...(query.discoveredTo ? { discoveredTo: query.discoveredTo } : {}),
          ...(query.limit ? { limit: Number(query.limit) } : {}),
          ...(query.manualDecision ? { manualDecision: query.manualDecision } : {}),
          ...(query.observedFrom ? { observedFrom: query.observedFrom } : {}),
          ...(query.observedTo ? { observedTo: query.observedTo } : {}),
          ...(query.ownerUserId ? { ownerUserId: query.ownerUserId } : {}),
          ...(principal.role === 'admin' && query.memberUserId
            ? { memberUserId: query.memberUserId }
            : {}),
          ...(query.pipelineStatus ? { pipelineStatus: query.pipelineStatus } : {}),
          ...(query.tags
            ? {
                tagNames: query.tags
                  .split(',')
                  .map((tag) => tag.trim())
                  .filter(Boolean),
              }
            : {}),
        },
        workspaceId: principal.workspaceId,
      });
      return reply
        .header('content-disposition', 'attachment; filename="candidates.csv"')
        .type('text/csv; charset=utf-8')
        .send(result.csv);
    } catch (error) {
      if (error instanceof Error && error.name === 'ZodError') {
        return reply.code(400).send({ code: 'INVALID_CANDIDATE_FILTERS' });
      }
      throw error;
    }
  });

  server.get<{ Params: { candidateId: string } }>(
    '/candidates/:candidateId',
    async (request, reply) => {
      const principal = await authorizeBrowserRequest(pool, request, reply, 'candidate:read');
      if (!principal) return;
      try {
        const detail = await getCandidateDetail(
          pool,
          {
            actorRole: principal.role,
            actorUserId: principal.userId,
            workspaceId: principal.workspaceId,
          },
          request.params.candidateId,
        );
        return {
          ...detail,
          aiAnalyses: await listAiAnalysisHistory(
            pool,
            principal.workspaceId,
            request.params.candidateId,
          ),
          workflow: await getCandidateWorkflow(
            pool,
            {
              actorRole: principal.role,
              actorUserId: principal.userId,
              workspaceId: principal.workspaceId,
            },
            request.params.candidateId,
          ),
        };
      } catch (error) {
        if (
          error instanceof CandidateNotFoundError ||
          error instanceof CandidateAccessDeniedError ||
          error instanceof CandidateWorkflowNotFoundError
        ) {
          return reply.code(404).send({ code: 'CANDIDATE_NOT_FOUND' });
        }
        throw error;
      }
    },
  );

  server.post<{ Params: { candidateId: string } }>(
    '/candidates/:candidateId/ai-analyses',
    async (request, reply) => {
      const principal = await authorizeBrowserRequest(
        pool,
        request,
        reply,
        'candidate:write',
        true,
      );
      if (!principal) return;
      try {
        return reply.code(202).send(
          await queueAiReanalysis(pool, {
            actorRole: principal.role,
            actorUserId: principal.userId,
            candidateId: request.params.candidateId,
            workspaceId: principal.workspaceId,
          }),
        );
      } catch (error) {
        if (error instanceof CandidateAccessDeniedError) {
          return reply.code(404).send({ code: 'CANDIDATE_NOT_FOUND' });
        }
        if (error instanceof AiAnalysisNotFoundError) {
          return reply.code(409).send({ code: 'AI_ANALYSIS_UNAVAILABLE' });
        }
        throw error;
      }
    },
  );

  server.post<{ Body: unknown; Params: { candidateId: string } }>(
    '/candidates/:candidateId/reviews',
    async (request, reply) => {
      const principal = await authorizeBrowserRequest(
        pool,
        request,
        reply,
        'candidate:write',
        true,
      );
      if (!principal) return;
      try {
        return reply.code(201).send(
          await submitManualReview(pool, {
            ...(request.body as Record<string, unknown>),
            actorRole: principal.role,
            actorUserId: principal.userId,
            candidateId: request.params.candidateId,
            workspaceId: principal.workspaceId,
          }),
        );
      } catch (error) {
        return handleCandidateWorkflowError(error, reply);
      }
    },
  );

  server.post<{ Body: unknown; Params: { candidateId: string } }>(
    '/candidates/:candidateId/pipeline',
    async (request, reply) => {
      const principal = await authorizeBrowserRequest(pool, request, reply, 'outreach:write', true);
      if (!principal) return;
      try {
        return await transitionCandidatePipeline(pool, {
          ...(request.body as {
            expectedVersion: number;
            nextStatus: import('@douyin/domain').PipelineStatus;
            note?: string;
          }),
          actorRole: principal.role,
          actorUserId: principal.userId,
          candidateId: request.params.candidateId,
          workspaceId: principal.workspaceId,
        });
      } catch (error) {
        return handleCandidateWorkflowError(error, reply);
      }
    },
  );

  server.put<{ Body: unknown; Params: { candidateId: string } }>(
    '/candidates/:candidateId/outreach',
    async (request, reply) => {
      const principal = await authorizeBrowserRequest(pool, request, reply, 'outreach:write', true);
      if (!principal) return;
      try {
        return await updateCandidateOutreach(pool, {
          ...(request.body as Record<string, unknown>),
          actorRole: principal.role,
          actorUserId: principal.userId,
          candidateId: request.params.candidateId,
          workspaceId: principal.workspaceId,
        });
      } catch (error) {
        return handleCandidateWorkflowError(error, reply);
      }
    },
  );

  server.post<{ Body: unknown; Params: { candidateId: string } }>(
    '/candidates/:candidateId/notes',
    async (request, reply) => {
      const principal = await authorizeBrowserRequest(pool, request, reply, 'outreach:write', true);
      if (!principal) return;
      try {
        const body = request.body as { body?: unknown };
        return reply.code(201).send(
          await appendCandidateNote(pool, {
            actorRole: principal.role,
            actorUserId: principal.userId,
            body: typeof body.body === 'string' ? body.body : '',
            candidateId: request.params.candidateId,
            workspaceId: principal.workspaceId,
          }),
        );
      } catch (error) {
        return handleCandidateWorkflowError(error, reply);
      }
    },
  );

  server.get<{ Querystring: { campaignId?: string; limit?: string } }>(
    '/runs',
    async (request, reply) => {
      const principal = await authorizeBrowserRequest(pool, request, reply, 'campaign:read');
      if (!principal) return;
      const requestedLimit = Number(request.query.limit ?? 100);
      return {
        runs: await listCollectionRuns(
          pool,
          principal.workspaceId,
          request.query.campaignId,
          Number.isFinite(requestedLimit) ? requestedLimit : 100,
        ),
      };
    },
  );

  server.post<{ Body: unknown }>('/campaigns', async (request, reply) => {
    const principal = await authorizeBrowserRequest(pool, request, reply, 'campaign:write', true);
    if (!principal) return;
    try {
      return reply.code(201).send(
        await createCampaign(pool, {
          ...(request.body as Record<string, unknown>),
          workspaceId: principal.workspaceId,
          actorUserId: principal.userId,
        }),
      );
    } catch (error) {
      return handleCampaignError(error, reply);
    }
  });

  server.post<{ Body: unknown; Params: { campaignId: string } }>(
    '/campaigns/:campaignId/copy',
    async (request, reply) => {
      const principal = await authorizeBrowserRequest(pool, request, reply, 'campaign:write', true);
      if (!principal) return;
      const name = (request.body as { name?: unknown }).name;
      if (typeof name !== 'string' || name.trim().length < 2) {
        return reply.code(400).send({ code: 'INVALID_REQUEST' });
      }
      try {
        return reply
          .code(201)
          .send(
            await copyCampaign(
              pool,
              principal.workspaceId,
              request.params.campaignId,
              principal.userId,
              name.trim(),
            ),
          );
      } catch (error) {
        return handleCampaignError(error, reply);
      }
    },
  );

  server.patch<{ Body: unknown; Params: { campaignId: string } }>(
    '/campaigns/:campaignId',
    async (request, reply) => {
      const principal = await authorizeBrowserRequest(pool, request, reply, 'campaign:write', true);
      if (!principal) return;
      try {
        return await updateCampaign(pool, {
          ...(request.body as Record<string, unknown>),
          workspaceId: principal.workspaceId,
          actorUserId: principal.userId,
          campaignId: request.params.campaignId,
        });
      } catch (error) {
        return handleCampaignError(error, reply);
      }
    },
  );

  server.post<{ Params: { campaignId: string } }>(
    '/campaigns/:campaignId/archive',
    async (request, reply) => {
      const principal = await authorizeBrowserRequest(pool, request, reply, 'campaign:write', true);
      if (!principal) return;
      try {
        return await archiveCampaign(
          pool,
          principal.workspaceId,
          request.params.campaignId,
          principal.userId,
        );
      } catch (error) {
        return handleCampaignError(error, reply);
      }
    },
  );

  server.post<{ Params: { campaignId: string } }>(
    '/campaigns/:campaignId/runs',
    async (request, reply) => {
      const principal = await authorizeBrowserRequest(pool, request, reply, 'campaign:write', true);
      if (!principal) return;
      try {
        return reply.code(201).send(
          await createCollectionRun(pool, {
            workspaceId: principal.workspaceId,
            campaignId: request.params.campaignId,
            actorUserId: principal.userId,
          }),
        );
      } catch (error) {
        return handleCampaignError(error, reply);
      }
    },
  );

  server.post<{ Params: { runId: string } }>('/runs/:runId/pause', async (request, reply) => {
    const principal = await authorizeBrowserRequest(pool, request, reply, 'campaign:write', true);
    if (!principal) return;
    try {
      return await pauseCollectionRun(pool, {
        workspaceId: principal.workspaceId,
        runId: request.params.runId,
        actorUserId: principal.userId,
      });
    } catch (error) {
      return handleCollectionRunError(error, reply);
    }
  });

  server.post<{ Params: { runId: string } }>('/runs/:runId/resume', async (request, reply) => {
    const principal = await authorizeBrowserRequest(pool, request, reply, 'campaign:write', true);
    if (!principal) return;
    try {
      return await resumeCollectionRun(pool, {
        workspaceId: principal.workspaceId,
        runId: request.params.runId,
        actorUserId: principal.userId,
      });
    } catch (error) {
      return handleCollectionRunError(error, reply);
    }
  });

  server.post<{ Params: { runId: string } }>('/runs/:runId/terminate', async (request, reply) => {
    const principal = await authorizeBrowserRequest(pool, request, reply, 'campaign:write', true);
    if (!principal) return;
    try {
      return await terminateCollectionRun(pool, {
        workspaceId: principal.workspaceId,
        runId: request.params.runId,
        actorUserId: principal.userId,
      });
    } catch (error) {
      return handleCollectionRunError(error, reply);
    }
  });

  server.post<{ Params: { deviceId: string } }>(
    '/devices/:deviceId/rotate-token',
    async (request, reply) => {
      const principal = await authorizeBrowserRequest(pool, request, reply, 'device:manage', true);
      if (!principal) return;
      try {
        const token = await rotateDeviceToken(
          pool,
          principal.workspaceId,
          request.params.deviceId,
          principal.userId,
          principal.role,
        );
        return token;
      } catch (error) {
        return handleDeviceManagementError(error, reply);
      }
    },
  );

  server.post<{ Params: { deviceId: string } }>(
    '/devices/:deviceId/revoke',
    async (request, reply) => {
      const principal = await authorizeBrowserRequest(pool, request, reply, 'device:manage', true);
      if (!principal) return;
      try {
        await revokeDevice(
          pool,
          principal.workspaceId,
          request.params.deviceId,
          principal.userId,
          principal.role,
        );
        return reply.code(204).send();
      } catch (error) {
        return handleDeviceManagementError(error, reply);
      }
    },
  );

  return server;
}

function bearerToken(authorization: string | undefined): string | undefined {
  if (!authorization?.startsWith('Bearer ')) return undefined;
  return authorization.slice('Bearer '.length).trim() || undefined;
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isSemanticVersion(value: string): boolean {
  return /^\d+\.\d+\.\d+$/u.test(value);
}

function compareSemanticVersions(left: string, right: string): number {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function handleDeviceManagementError(error: unknown, reply: FastifyReply) {
  if (error instanceof DeviceAccessDeniedError) {
    return reply.code(403).send({ code: 'DEVICE_ACCESS_DENIED' });
  }
  if (error instanceof DeviceNotActiveError) {
    return reply.code(404).send({ code: 'DEVICE_NOT_ACTIVE' });
  }
  throw error;
}

function handleCampaignError(error: unknown, reply: FastifyReply) {
  if (error instanceof CampaignRecordNotFoundError) {
    return reply.code(404).send({ code: 'CAMPAIGN_RECORD_NOT_FOUND' });
  }
  if (error instanceof CampaignVersionConflictError) {
    return reply.code(409).send({ code: 'VERSION_CONFLICT', currentVersion: error.currentVersion });
  }
  if (error instanceof CampaignNotActiveError) {
    return reply.code(409).send({ code: 'CAMPAIGN_NOT_ACTIVE' });
  }
  if (error instanceof Error && error.name === 'ZodError') {
    return reply.code(400).send({ code: 'INVALID_REQUEST', message: '筛选任务信息格式不正确' });
  }
  throw error;
}

function handleCollectionRunError(error: unknown, reply: FastifyReply) {
  if (error instanceof CollectionRunNotFoundError) {
    return reply.code(404).send({ code: 'COLLECTION_RUN_NOT_FOUND' });
  }
  if (error instanceof CollectionRunDeviceMismatchError) {
    return reply.code(403).send({ code: 'COLLECTION_RUN_DEVICE_MISMATCH' });
  }
  if (error instanceof InvalidRunStatusTransitionError) {
    return reply.code(409).send({
      code: 'INVALID_RUN_STATUS_TRANSITION',
      from: error.from,
      to: error.to,
    });
  }
  if (error instanceof CollectionRunNotRunningError) {
    return reply.code(409).send({ code: 'COLLECTION_RUN_NOT_RUNNING', status: error.status });
  }
  if (error instanceof RunProgressRegressionError) {
    return reply.code(409).send({ code: 'RUN_PROGRESS_REGRESSION' });
  }
  if (error instanceof Error && error.name === 'ZodError') {
    return reply.code(400).send({ code: 'INVALID_REQUEST', message: '运行请求格式不正确' });
  }
  throw error;
}

function handleCollectorIngestionError(error: unknown, reply: FastifyReply) {
  if (error instanceof IncompatibleCollectorProtocolError) {
    return reply.code(426).send({
      code: 'COLLECTOR_UPGRADE_REQUIRED',
      requiredProtocolVersion: '1.0.0',
    });
  }
  if (error instanceof CollectorDeviceIdentityMismatchError) {
    return reply.code(403).send({ code: 'COLLECTOR_DEVICE_IDENTITY_MISMATCH' });
  }
  if (error instanceof CollectorRunAccessDeniedError) {
    return reply.code(403).send({ code: 'COLLECTOR_RUN_ACCESS_DENIED' });
  }
  if (error instanceof CollectorRunNotIngestibleError) {
    return reply.code(409).send({ code: 'COLLECTOR_RUN_NOT_INGESTIBLE', status: error.status });
  }
  if (error instanceof IngestionIdempotencyConflictError) {
    return reply.code(409).send({ code: 'INGESTION_IDEMPOTENCY_CONFLICT' });
  }
  if (error instanceof IngestionAlreadyProcessingError) {
    return reply.code(409).send({ code: 'INGESTION_ALREADY_PROCESSING' });
  }
  if (error instanceof Error && error.name === 'ZodError') {
    return reply.code(400).send({ code: 'INVALID_COLLECTOR_BATCH' });
  }
  if (error instanceof Error && error.name === 'InvalidDouyinUrlError') {
    return reply.code(400).send({ code: 'INVALID_DOUYIN_URL' });
  }
  throw error;
}

function handleMediaError(error: unknown, reply: FastifyReply) {
  if (error instanceof MediaRunAccessDeniedError) {
    return reply.code(403).send({ code: 'MEDIA_RUN_ACCESS_DENIED' });
  }
  if (error instanceof MediaObservationAccessDeniedError) {
    return reply.code(403).send({ code: 'MEDIA_OBSERVATION_ACCESS_DENIED' });
  }
  if (error instanceof MediaObjectNotFoundError) {
    return reply.code(404).send({ code: 'MEDIA_OBJECT_NOT_FOUND' });
  }
  if (error instanceof MediaRunNotAcceptingUploadError) {
    return reply.code(409).send({ code: 'MEDIA_RUN_NOT_ACCEPTING_UPLOAD', status: error.status });
  }
  if (error instanceof MediaStoredObjectUnavailableError) {
    return reply.code(409).send({ code: 'MEDIA_STORED_OBJECT_UNAVAILABLE' });
  }
  if (error instanceof MediaConfirmationMismatchError) {
    return reply.code(409).send({ code: 'MEDIA_CONFIRMATION_MISMATCH', fields: error.fields });
  }
  if (error instanceof MediaUploadExpiredError) {
    return reply.code(410).send({ code: 'MEDIA_UPLOAD_EXPIRED' });
  }
  if (error instanceof Error && error.name === 'ZodError') {
    return reply.code(400).send({ code: 'INVALID_MEDIA_UPLOAD' });
  }
  throw error;
}

function handleAiConnectionError(error: unknown, reply: FastifyReply) {
  if (error instanceof AiConnectionNotFoundError) {
    return reply.code(404).send({ code: 'AI_CONNECTION_NOT_FOUND' });
  }
  if (error instanceof Error && error.name === 'ZodError') {
    return reply.code(400).send({ code: 'INVALID_AI_CONNECTION' });
  }
  throw error;
}

function handleCandidateWorkflowError(error: unknown, reply: FastifyReply) {
  if (error instanceof CandidateWorkflowNotFoundError) {
    return reply.code(404).send({ code: 'CANDIDATE_WORKFLOW_NOT_FOUND' });
  }
  if (error instanceof CandidateVersionConflictError) {
    return reply.code(409).send({ code: 'VERSION_CONFLICT', currentVersion: error.currentVersion });
  }
  if (error instanceof OutreachVersionConflictError) {
    return reply.code(409).send({ code: 'VERSION_CONFLICT', currentVersion: error.currentVersion });
  }
  if (error instanceof InvalidPipelineTransitionError) {
    return reply
      .code(409)
      .send({ code: 'INVALID_PIPELINE_TRANSITION', from: error.from, to: error.to });
  }
  if (error instanceof Error && error.name === 'ZodError') {
    return reply.code(400).send({ code: 'INVALID_CANDIDATE_WORKFLOW' });
  }
  throw error;
}

async function start() {
  const config = parseApiConfig(process.env);
  const pool = createMysqlPool(config.DATABASE_URL);
  const objectStorage = new AliyunObjectStorageClient({
    accessKeyId: config.OSS_ACCESS_KEY_ID,
    accessKeySecret: config.OSS_ACCESS_KEY_SECRET,
    bucket: config.OSS_BUCKET,
    endpoint: config.OSS_ENDPOINT,
    region: config.OSS_REGION,
  });
  const server = buildServer({
    collectorMinVersion: config.COLLECTOR_MIN_VERSION,
    credentialCipher: CredentialCipher.fromSingleKey(config.CREDENTIAL_ENCRYPTION_KEY),
    pool,
    readinessChecks: {
      ai: {
        check: async () => {
          const [rows] = await pool.query(
            "SELECT id FROM ai_connections WHERE status = 'enabled' LIMIT 1",
          );
          if (!Array.isArray(rows) || rows.length === 0) {
            const error = new Error('No active AI connection is configured.');
            error.name = 'AiNotConfigured';
            throw error;
          }
        },
        required: false,
      },
      mysql: {
        check: async () => {
          await pool.query('SELECT 1');
        },
        required: true,
      },
      oss: {
        check: async () => {
          if (process.env.OSS_READINESS_PROBE === 'false') return;
          if (!objectStorage.checkConnectivity)
            throw new Error('OSS connectivity check unavailable.');
          await objectStorage.checkConnectivity();
        },
        required: true,
      },
    },
    objectStorage,
    secureCookies: config.NODE_ENV === 'production',
  });
  server.addHook('onClose', async () => pool.end());
  await server.listen({ host: config.API_HOST, port: config.API_PORT });
}

if (process.env.NODE_ENV !== 'test') {
  await start();
}
