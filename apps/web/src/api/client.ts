export interface ApiErrorBody {
  code?: string;
  currentVersion?: number;
  from?: string;
  message?: string;
  permission?: string;
  to?: string;
}

/**
 * 带状态码与服务端错误码的失败响应。
 *
 * `readResponse` 过去把所有非 401 失败压成同一句「请求失败」，调用方无从区分
 * 「同事刚改过」「护栏不允许」和「网络断了」，只能把三种情况都说成重试。
 * 现在把状态码与响应体带出来，界面才能给出可执行的下一步。
 */
export class ApiError extends Error {
  public readonly body: ApiErrorBody;
  public readonly status: number;

  public constructor(status: number, body: ApiErrorBody, message: string) {
    super(message);
    this.name = 'ApiError';
    this.body = body;
    this.status = status;
  }

  public get code(): string {
    return this.body.code ?? '';
  }
}

const FALLBACK_MESSAGE = '请求失败，请检查网络后重试。';

export async function readResponse<T>(response: Response): Promise<T> {
  if (!response.ok) throw await toApiError(response);
  return (await response.json()) as T;
}

/** 读取失败响应的 JSON 体；响应体不是 JSON 时返回空对象而不是抛错。 */
export async function readErrorBody(response: Response): Promise<ApiErrorBody> {
  try {
    const parsed: unknown = await response.clone().json();
    return parsed !== null && typeof parsed === 'object' ? (parsed as ApiErrorBody) : {};
  } catch {
    return {};
  }
}

export async function toApiError(response: Response): Promise<ApiError> {
  const body = await readErrorBody(response);
  const message =
    response.status === 401 ? '登录已过期，请重新登录。' : describeApiError(response.status, body);
  return new ApiError(response.status, body, message);
}

/**
 * 已知错误码 → 面向运营的中文说明。
 * 护栏类拒绝优先使用服务端给出的 message：那才是「为什么不能这么做」的准确原因，
 * 前端复制一份文案只会与服务端逐渐走偏。
 */
export function describeApiError(status: number, body: ApiErrorBody = {}): string {
  switch (body.code) {
    case 'INVALID_BATCH_REQUEST':
      return '批量请求不合法：一次最多 100 条，且不能重复选择同一条。';
    case 'VERSION_CONFLICT':
      return '这条记录已被同事修改，请刷新后重试。';
    case 'LAST_ACTIVE_ADMIN':
    case 'SELF_DISABLE_NOT_ALLOWED':
    case 'INVALID_PIPELINE_TRANSITION':
      return body.message || FALLBACK_MESSAGE;
    case 'CANDIDATE_NOT_FOUND':
    case 'CANDIDATE_WORKFLOW_NOT_FOUND':
    case 'MEMBER_NOT_FOUND':
    case 'INVITATION_NOT_FOUND':
      return '找不到这条记录，可能已被同事处理或不在你的可见范围内，请刷新列表。';
    case 'INVITATION_REVOKED':
      return status === 410
        ? '这个邀请已被撤销，无法再用于创建账户。'
        : '这个邀请已经撤销过了，不需要重复操作。';
    case 'INVITATION_ALREADY_USED':
      return '这个邀请已经被使用，不能再撤销。';
    case 'INVITATION_EXPIRED':
      return '这个邀请已过期，请重新发出一个。';
    case 'INVALID_CSRF_TOKEN':
      return '页面已过期，请刷新页面后重试。';
    case 'FORBIDDEN':
      return '当前角色没有执行这个操作的权限。';
    default:
      break;
  }
  if (status === 400) return '提交内容不完整或格式不正确，请检查后重试。';
  if (status === 403) return '当前角色没有执行这个操作的权限。';
  if (status === 404) return '找不到这条记录，请刷新后重试。';
  if (status >= 500) return '服务端处理失败，请稍后重试；反复出现请联系管理员。';
  return FALLBACK_MESSAGE;
}
