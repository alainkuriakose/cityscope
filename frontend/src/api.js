async function request(path, { method = 'GET', body } = {}) {
  const token = localStorage.getItem('token');
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(typeof data.detail === 'string' ? data.detail : 'Something went wrong');
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  login: (b) => request('/auth/login', { method: 'POST', body: b }),
  register: (b) => request('/auth/register', { method: 'POST', body: b }),
  search: (q) => request(`/search?q=${encodeURIComponent(q)}`),
  cities: (params) => request(`/cities?${new URLSearchParams(params)}`),
  addCity: (c) => request('/cities', { method: 'POST', body: c }),
  patchCity: (id, patch) => request(`/cities/${id}`, { method: 'PATCH', body: patch }),
  removeCity: (id) => request(`/cities/${id}`, { method: 'DELETE' }),
  weather: (id) => request(`/cities/${id}/weather`),
  stats: () => request('/stats'),
};
