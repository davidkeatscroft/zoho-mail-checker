// Email HTML is untrusted. The real protection is the frame: sandboxed with no
// allow-scripts, plus a CSP that stops all network access except opted-in images.
// Stripping elements here is a second layer, and tidies what would not work anyway.
const REMOVED_ELEMENTS = 'script, iframe, frame, frameset, object, embed, applet, link, meta, base, form, audio, video, title';
const REMOTE_URL = /url\(\s*['"]?\s*(https?:)?\/\//i;

function hasRemoteContent(doc) {
  const remoteAttr = (v) => /^\s*(https?:)?\/\//i.test(v || '');
  for (const el of doc.querySelectorAll('[src], [srcset], [background], [poster]')) {
    if (remoteAttr(el.getAttribute('src')) || remoteAttr(el.getAttribute('background')) || remoteAttr(el.getAttribute('poster')) || el.hasAttribute('srcset')) return true;
  }
  if ([...doc.querySelectorAll('[style]')].some((el) => REMOTE_URL.test(el.getAttribute('style')))) return true;
  return [...doc.querySelectorAll('style')].some((el) => REMOTE_URL.test(el.textContent));
}

export function buildEmailDocument(html, { allowRemote = false } = {}) {
  const doc = new DOMParser().parseFromString(html || '', 'text/html');
  doc.querySelectorAll(REMOVED_ELEMENTS).forEach((el) => el.remove());
  for (const el of doc.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      if (/^on/i.test(attr.name) || /^\s*javascript:/i.test(attr.value)) el.removeAttribute(attr.name);
    }
  }
  const hasRemote = hasRemoteContent(doc);
  const remote = allowRemote ? ' https: http:' : '';
  const csp = `default-src 'none'; style-src 'unsafe-inline'; img-src data:${remote}; font-src data:${remote}; form-action 'none'; base-uri 'none'`;
  const styles = [...doc.querySelectorAll('head style')].map((el) => el.outerHTML).join('');
  const srcdoc = `<!doctype html><html><head><meta charset="utf-8">`
    + `<meta http-equiv="Content-Security-Policy" content="${csp}">`
    + `<meta name="referrer" content="no-referrer">`
    + `<style>html{color-scheme:light}body{margin:12px;background:#fff;color:#1f2329;font:14px/1.5 system-ui,sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}pre{white-space:pre-wrap}</style>`
    + `${styles}</head><body>${doc.body.innerHTML}</body></html>`;
  return { srcdoc, hasRemote };
}

export function isSafeExternalLink(href) {
  try {
    return ['http:', 'https:', 'mailto:'].includes(new URL(href).protocol);
  } catch {
    return false;
  }
}
