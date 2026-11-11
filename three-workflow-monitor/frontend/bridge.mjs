export const call = (method, args = {}) => window.__TAURI__.core.invoke('backend_call', { method, args });
export const native = (command, args = {}) => window.__TAURI__.core.invoke(command, args);
export function notify(message = '') {
  const notice = document.getElementById('notice');
  notice.textContent = message;
  notice.hidden = !message;
}
export function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
