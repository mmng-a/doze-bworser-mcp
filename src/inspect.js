(() => {
  const snapshot = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const elements = new Map();
  const controls = [];
  for (const element of document.querySelectorAll('a[href],button,input,select,textarea,[role="button"],[contenteditable="true"]')) {
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height || getComputedStyle(element).visibility === 'hidden') continue;
    const reference = `${snapshot}:${controls.length}`;
    elements.set(reference, element);
    controls.push({ element: reference, tag: element.tagName.toLowerCase(),
      role: element.getAttribute('role'), type: element.getAttribute('type'),
      name: element.getAttribute('aria-label') || element.labels?.[0]?.innerText || element.innerText?.trim().slice(0, 200) || element.getAttribute('placeholder') || '',
      disabled: !!element.disabled,
      href: element instanceof HTMLAnchorElement ? element.href : undefined,
    });
    if (controls.length >= 200) break;
  }
  globalThis.__dozeElements = elements;
  return { url: location.href, title: document.title, width: innerWidth, height: innerHeight,
    text: document.body?.innerText.slice(0, 16000) || '', elements: controls,
    note: 'Element references are replaced by the next inspect_page call and expire on navigation. Input values are omitted.' };
})()
