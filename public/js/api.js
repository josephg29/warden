async function request(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  let data = {};
  try { data = await res.json(); } catch { /* allow empty */ }
  if (!res.ok) {
    const err = new Error(data.error || `${res.status} ${res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  list:        ()     => request('GET',    '/bots'),
  create:      (bot)  => request('POST',   '/bots', bot),
  update:      (id,p) => request('PATCH',  `/bots/${id}`, p),
  remove:      (id)   => request('DELETE', `/bots/${id}`),
  connect:     (id)   => request('POST',   `/bots/${id}/connect`),
  disconnect:  (id)   => request('POST',   `/bots/${id}/disconnect`),
  botState:    (id)   => request('GET',    `/bots/${id}/state`),
  botMemory:   (id)   => request('GET',    `/bots/${id}/memory`),
  botDecision: (id)   => request('GET',    `/bots/${id}/decision`),
  world:       ()     => request('GET',    '/world'),

  server: {
    status:  ()    => request('GET',  '/server'),
    start:   ()    => request('POST', '/server/start'),
    stop:    ()    => request('POST', '/server/stop'),
    command: (cmd) => request('POST', '/server/command', { command: cmd }),
  },

  settings: {
    get:  ()    => request('GET',   '/settings'),
    save: (key) => request('PATCH', '/settings', { cerebrasApiKey: key }),
  },

  logs: {
    list:    ()   => request('GET', '/logs'),
    session: (id) => request('GET', `/logs/${id}`),
  },
};
