const TOKEN_KEY = 'ptyp_token';
const USER_CACHE_KEY = 'ptyp_cached_user';
const SERVER_URL_KEY = 'ptyp_server_url';

export function getApiBaseUrl() {
  try {
    const saved = (localStorage.getItem(SERVER_URL_KEY) || '').trim().replace(/\/$/, '');
    if (saved) return saved;
  } catch {
    /* yok say */
  }
  const envUrl = (import.meta.env?.VITE_API_BASE_URL || '').trim().replace(/\/$/, '');
  if (envUrl) return envUrl;
  // Capacitor / Cordova native WebView içinde çalışıyorsa varsayılan canlı sunucu adresi
  if (typeof window !== 'undefined' && (window.Capacitor || window.location.protocol === 'capacitor:')) {
    return 'https://turguz.app';
  }
  return '';
}

export function setApiBaseUrl(url) {
  try {
    const clean = (url || '').trim().replace(/\/$/, '');
    if (clean) localStorage.setItem(SERVER_URL_KEY, clean);
    else localStorage.removeItem(SERVER_URL_KEY);
  } catch {
    /* yok say */
  }
}

export function apiUrl(path) {
  if (!path || /^https?:\/\//i.test(path)) return path;
  const base = getApiBaseUrl();
  if (!base) return path;
  return `${base}${path.startsWith('/') ? path : '/' + path}`;
}

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
    else {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_CACHE_KEY);
    }
  } catch {
    /* localStorage kapalıysa sessiz geç */
  }
}

export function getCachedUser() {
  try {
    const raw = localStorage.getItem(USER_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function setCachedUser(u) {
  try {
    if (u) localStorage.setItem(USER_CACHE_KEY, JSON.stringify(u));
    else localStorage.removeItem(USER_CACHE_KEY);
  } catch {
    /* localStorage kapalıysa sessiz geç */
  }
}

export function isNetworkOrOfflineError(err) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  if (!err) return false;
  if (err.status && Number.isInteger(err.status)) return false;
  const msg = String(err.message || '');
  return msg === 'OFFLINE_MODE' || /failed to fetch|networkerror|load failed|network request failed|fetch/i.test(msg);
}

function handleUnauthorized(status) {
  if (status === 401 && getToken()) {
    setToken(null);
    if (!window.location.pathname.startsWith('/login')) window.location.href = '/login';
  }
}

async function readError(res, fallback) {
  let msg = fallback;
  try {
    const data = await res.json();
    if (data && data.error) msg = data.error;
  } catch {
    /* yanıt JSON değilse varsayılan mesaj kalır */
  }
  handleUnauthorized(res.status);
  return msg;
}

async function request(path, options = {}) {
  const token = getToken();
  const isForm = typeof FormData !== 'undefined' && options.body instanceof FormData;
  const res = await fetch(apiUrl(path), {
    ...options,
    headers: {
      ...(isForm ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const err = new Error(await readError(res, `İstek başarısız oldu (HTTP ${res.status}).`));
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}

export const api = {
  get: (p) => request(p),
  post: (p, body) => request(p, { method: 'POST', body: JSON.stringify(body) }),
  put: (p, body) => request(p, { method: 'PUT', body: JSON.stringify(body) }),
  del: (p) => request(p, { method: 'DELETE' }),
  upload: (p, formData) => request(p, { method: 'POST', body: formData }),
};

async function triggerBlobDownload(res, filename) {
  if (!res.ok) {
    throw new Error(await readError(res, `İndirme başarısız (HTTP ${res.status}).`));
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

// Excel/ikili dosya indirme (GET + Bearer token)
export async function apiDownload(path, filename) {
  const token = getToken();
  const res = await fetch(apiUrl(path), {
    headers: token ? { Authorization: 'Bearer ' + token } : {},
  });
  await triggerBlobDownload(res, filename);
}

// Gövdeli ikili dosya indirme (POST JSON + Bearer token)
export async function apiPostDownload(path, body, filename) {
  const token = getToken();
  const res = await fetch(apiUrl(path), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: JSON.stringify(body),
  });
  await triggerBlobDownload(res, filename);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// /api/kmz-generator/parse uzun işler (OCR) için 202 + job_id döner; tamamlanana kadar yoklar
export async function postParse(formData, onProgress) {
  const j = await api.upload('/api/kmz-generator/parse', formData);
  if (j && j.job_id) {
    const t0 = Date.now();
    for (;;) {
      await sleep(2000);
      const s = await api.get(`/api/kmz-generator/job/${j.job_id}`);
      if (onProgress) onProgress(s);
      if (s.status === 'done') return s.result;
      if (s.status === 'error') throw new Error(s.error || 'İşlem başarısız.');
      if (Date.now() - t0 > 25 * 60 * 1000) throw new Error('İşlem çok uzun sürdü; lütfen tekrar deneyin.');
    }
  }
  return j;
}
