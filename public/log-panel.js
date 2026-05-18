(function initLogPanel() {
  let open = false;
  let unread = 0;
  const MAX = 500;
  const lines = [];

  const panel   = document.getElementById('log-panel');
  const body    = document.getElementById('log-body');
  const badge   = document.getElementById('log-badge');
  const chevron = document.getElementById('log-chevron');
  const spacer  = document.getElementById('log-spacer');

  window.toggleLogPanel = function() {
    open = !open;
    panel.style.height  = open ? '272px' : '32px';
    spacer.style.height = open ? '272px' : '0px';
    chevron.textContent = open ? '▼' : '▲';
    if (open) { unread = 0; badge.style.display = 'none'; body.scrollTop = body.scrollHeight; }
  };

  window.clearLogs = function() { lines.length = 0; body.innerHTML = ''; };

  function addLine(level, msg, ts) {
    const time = new Date(ts).toTimeString().slice(0,8);
    const color = level === 'error' ? '#ff6b6b' : level === 'warn' ? '#ffd93d' : '#ccc';
    const prefix = level === 'error' ? '✖' : level === 'warn' ? '⚠' : '›';
    const div = document.createElement('div');
    div.style.cssText = `padding:1px 10px; color:${color}; white-space:pre-wrap; word-break:break-all; border-bottom:1px solid #111;`;
    div.textContent = `${time} ${prefix} ${msg}`;
    body.appendChild(div);
    lines.push(div);
    if (lines.length > MAX) { lines.shift().remove(); }
    if (open) body.scrollTop = body.scrollHeight;
    if (!open) {
      unread++;
      badge.textContent = unread > 99 ? '99+' : unread;
      badge.style.display = 'inline';
    }
  }

  // Expose addLine so the SSE init (above) can call it
  window.__logPanelReady = addLine;
})();
