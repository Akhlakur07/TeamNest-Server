const BASE = 'http://localhost:5000/api';

async function request(method, path, body, token, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // ignore
  }
  return { status: res.status, body: json, headers: Object.fromEntries(res.headers.entries()) };
}

module.exports = {
  get: (path, token, options) => request('GET', path, null, token, options),
  post: (path, body, token, options) => request('POST', path, body, token, options),
  patch: (path, body, token, options) => request('PATCH', path, body, token, options),
  delete: (path, token, options) => request('DELETE', path, null, token, options),
};