export type CaptchaEvidence =
  | 'CAPTCHA_VERIFICATION_URL'
  | 'CAPTCHA_VISIBLE_DIALOG'
  | 'CAPTCHA_VISIBLE_WIDGET'
  | 'CAPTCHA_DOCUMENT_PROMPT';

export interface CaptchaInspectionPage {
  locator(selector: string): {
    evaluate<R>(
      fn: (element: HTMLElement) => R,
      arg?: undefined,
      options?: { timeout: number },
    ): Promise<R>;
  };
}

export async function readCaptchaEvidence(
  page: CaptchaInspectionPage,
): Promise<CaptchaEvidence | null> {
  return page.locator('body').evaluate(inspectVisibleCaptcha, undefined, { timeout: 5_000 });
}

/** Runs inside the page. Only a fixed evidence code returns; no DOM/text is persisted. */
export function inspectVisibleCaptcha(body: HTMLElement): CaptchaEvidence | null {
  const visible = (element: Element): boolean => {
    const rect = element.getBoundingClientRect();
    if (
      rect.width <= 0 ||
      rect.height <= 0 ||
      rect.bottom <= 0 ||
      rect.right <= 0 ||
      rect.top >= innerHeight ||
      rect.left >= innerWidth
    )
      return false;
    for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (
        ancestor.hasAttribute('hidden') ||
        ancestor.getAttribute('aria-hidden') === 'true' ||
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        Number(style.opacity) === 0
      )
        return false;
    }
    return true;
  };
  const verificationWords = /(安全验证|验证码|拖动滑块|完成验证|请依次点击|请选择.*图)/u;
  const prompt =
    /^(?:请(?:先|您)?\s*)?(?:完成(?:安全)?验证|拖动滑块(?:完成(?:安全)?验证|至最右边)?|按住滑块[，,]?\s*拖动(?:到|至)最右边|输入(?:短信)?验证码)[。！!]?$/u;
  const userContent =
    'article,[data-e2e*="user-post"],[data-e2e*="video-desc"],[data-e2e*="video-title"],[data-e2e*="user-title"],[data-e2e*="user-desc"],[data-e2e*="user-info"],[data-e2e*="feed-active"],[data-e2e*="feed-item"]';
  const hasPrompt = (text: string) => text.split('\n').some((line) => prompt.test(line.trim()));
  const visibleText = (root: HTMLElement): string => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const parts: string[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!node.textContent?.trim() || !parent || !visible(parent)) continue;
      const content = parent.closest(userContent);
      if (content && root.contains(content)) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rect = range.getBoundingClientRect();
      if (
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < innerHeight &&
        rect.left < innerWidth
      )
        parts.push(node.textContent.trim());
    }
    return parts.join('\n');
  };

  for (const frame of body.querySelectorAll('iframe[src]')) {
    if (!visible(frame)) continue;
    try {
      if (
        /(?:^|\/)(?:verifycenter|captcha)(?:\/|$)/iu.test(
          new URL(frame.getAttribute('src')!, location.href).pathname,
        )
      )
        return 'CAPTCHA_VISIBLE_WIDGET';
    } catch {
      /* An invalid frame URL is not verification evidence. */
    }
  }
  for (const dialog of body.querySelectorAll<HTMLElement>('[role="dialog"],[aria-modal="true"]')) {
    if (!visible(dialog)) continue;
    const text = visibleText(dialog);
    const controls = [...dialog.querySelectorAll('input,[role="slider"],canvas,button')].some(
      visible,
    );
    if (
      hasPrompt(text) ||
      (verificationWords.test(text) &&
        controls &&
        /(?:^|\n)\s*(?:安全验证|验证码)\s*(?:\n|$)/u.test(text))
    )
      return 'CAPTCHA_VISIBLE_DIALOG';
  }
  for (const widget of body.querySelectorAll<HTMLElement>(
    '[id*="captcha"],[class*="captcha"],[id*="verify"]',
  )) {
    if (!visible(widget) || widget.closest(userContent)) continue;
    const controls = [...widget.querySelectorAll('input,[role="slider"],canvas,img,button')].some(
      visible,
    );
    if (
      controls &&
      (verificationWords.test(visibleText(widget)) ||
        /captcha/iu.test(widget.id + ' ' + widget.className))
    )
      return 'CAPTCHA_VISIBLE_WIDGET';
  }
  // Standalone instructions outside creator/description/card content still fail closed,
  // including verification screens whose widget has not finished loading yet.
  for (const element of body.querySelectorAll<HTMLElement>('h1,h2,h3,p,div,span,label')) {
    const rawText = element.textContent ?? '';
    if (rawText.length > 160 || !/(验证|滑块)/u.test(rawText)) continue;
    if (!visible(element) || element.closest(userContent) || element.querySelector(userContent))
      continue;
    const text = visibleText(element).replace(/\s+/gu, '');
    if (text.length <= 160 && prompt.test(text)) return 'CAPTCHA_DOCUMENT_PROMPT';
  }
  if (!body.querySelector(userContent)) {
    const text = visibleText(body).replace(/\s+/gu, '');
    if (prompt.test(text) || text === '安全验证') return 'CAPTCHA_DOCUMENT_PROMPT';
  }
  return null;
}
