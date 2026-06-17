export function connectWs({ onMessage, onStatus }) {
  let ws;
  let backoff = 1000;
  let stopped = false;

  function open() {
    onStatus('connecting');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws`;
    ws = new WebSocket(url);

    ws.addEventListener('open', () => {
      backoff = 1000;
      onStatus('connected');
    });

    ws.addEventListener('message', (ev) => {
      try {
        onMessage(JSON.parse(ev.data));
      } catch (err) {
        console.error('[ws] bad message:', err);
      }
    });

    const reopen = () => {
      if (stopped) return;
      onStatus('disconnected');
      setTimeout(open, backoff);
      backoff = Math.min(backoff * 2, 10000);
    };

    ws.addEventListener('close', reopen);
    ws.addEventListener('error', () => {
      try { ws.close(); } catch { /* noop */ }
    });
  }

  open();

  return () => {
    stopped = true;
    try { ws?.close(); } catch { /* noop */ }
  };
}
