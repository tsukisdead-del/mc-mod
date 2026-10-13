export class AuthError extends Error {}

export async function api(path, { method = 'GET', body, form } = {}) {
  const res = await fetch('/api' + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : form,
    credentials: 'same-origin',
  });
  if (res.status === 401) throw new AuthError('Please unlock the app again.');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

// POST /api/chat and dispatch its server-sent events to handlers: saved, typing, delta, done, error.
export async function streamChat(items, handlers) {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
    credentials: 'same-origin',
  });
  if (res.status === 401) throw new AuthError('Please unlock the app again.');
  if (!res.ok || !res.body) throw new Error("Couldn't reach the server.");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      let event = 'message';
      let data = '';
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (data) handlers[event]?.(JSON.parse(data));
    }
  }
}

// Uploads a file and reports how much has been sent (0 to 1). Big documents take a while, so the app shows it.
// signal: an AbortSignal that cancels the upload (they removed the file).
export function uploadFile(form, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    signal?.addEventListener('abort', () => xhr.abort());
    xhr.onabort = () => reject(Object.assign(new Error('Upload cancelled.'), { cancelled: true }));
    xhr.open('POST', '/api/upload');
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.upload.onload = () => onProgress?.(1);
    xhr.onload = () => {
      if (xhr.status === 401) return reject(new AuthError('Please unlock the app again.'));
      let data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        // not JSON (e.g. a proxy error page)
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(Object.assign(new Error(data.error || (xhr.status === 413 ? 'That file is too big to send.' : `Upload failed (${xhr.status})`)), { status: xhr.status }));
    };
    xhr.onerror = () => reject(new Error("Couldn't upload that. Check your connection and try again."));
    xhr.send(form);
  });
}
