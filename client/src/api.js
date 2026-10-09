const TOKEN_KEY = 'ptyp_token';

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(t) {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* localStorage kapalıysa sessiz geç */
  }
}

async function request(path, options = {}) {
  const token = getToken();
  const res = await fetch(path, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    ...options,
  });
  if (!res.ok) {
    let msg = `İstek başarısız oldu (HTTP ${res.status}).`;
    try {
      const data = await res.json();
      if (data && data.error) msg = data.error;
    } catch {
      /* yanıt JSON değilse varsayılan mesaj kalır */
    }
    // Oturum geçersizse (ama aktif giriş varsa) giriş sayfasına yönlendir
    if (res.status === 401 && getToken()) {
      setToken(null);
      if (!window.location.pathname.startsWith('/login')) window.location.href = '/login';
    }
    throw new Error(msg);
  }
  if (res.status === 204) return null;
  return res.json();
}

export const api = {
  get: (p) => request(p),
  post: (p, body) => request(p, { method: 'POST', body: JSON.stringify(body) }),
  put: (p, body) => request(p, { method: 'PUT', body: JSON.stringify(body) }),
  del: (p) => request(p, { method: 'DELETE' }),
};

// Excel/ikili dosya indirme (Bearer token ile)
export async function apiDownload(path, filename) {
  const token = getToken();
  const res = await fetch(path, {
    headers: token ? { Authorization: 'Bearer ' + token } : {},
  });
  if (!res.ok) {
    let msg = `İndirme başarısız (HTTP ${res.status}).`;
    try {
      const data = await res.json();
      if (data && data.error) msg = data.error;
    } catch {
      /* ikili yanıt */
    }
    throw new Error(msg);
  }
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}
