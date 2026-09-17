const allowedDouyinHost = /(^|\.)douyin\.com$/iu;

export class InvalidDouyinUrlError extends Error {
  constructor(
    readonly rawUrl: string,
    readonly expectedKind: 'profile' | 'post',
  ) {
    super(`无效的抖音${expectedKind === 'profile' ? '主页' : '作品'}地址`);
    this.name = 'InvalidDouyinUrlError';
  }
}

export function normalizeDouyinProfileUrl(rawUrl: string): string {
  return normalizeDouyinUrl(rawUrl, 'profile', /^\/user\/[^/?#]+\/?$/u);
}

export function normalizeDouyinPostUrl(rawUrl: string): string {
  return normalizeDouyinUrl(rawUrl, 'post', /^\/(?:video|note)\/[^/?#]+\/?$/u);
}

function normalizeDouyinUrl(
  rawUrl: string,
  kind: 'profile' | 'post',
  acceptedPath: RegExp,
): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new InvalidDouyinUrlError(rawUrl, kind);
  }
  if (parsed.protocol !== 'https:' || !allowedDouyinHost.test(parsed.hostname)) {
    throw new InvalidDouyinUrlError(rawUrl, kind);
  }
  if (!acceptedPath.test(parsed.pathname)) throw new InvalidDouyinUrlError(rawUrl, kind);
  parsed.hostname = 'www.douyin.com';
  parsed.port = '';
  parsed.search = '';
  parsed.hash = '';
  parsed.pathname = parsed.pathname.replace(/\/$/u, '');
  return parsed.toString();
}
