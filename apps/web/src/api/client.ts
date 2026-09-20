export async function readResponse<T>(response: Response): Promise<T> {
  if (!response.ok)
    throw new Error(
      response.status === 401 ? '登录已过期，请重新登录。' : '请求失败，请检查网络后重试。',
    );
  return (await response.json()) as T;
}
