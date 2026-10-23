// Before the first paint, as a classic script in <head> (an extension page runs no inline script): the saved theme,
// so a dark choice never flashes light (app.js keeps it in step), and data-context="extension" in the Chrome side
// panel, for its tighter layout and Add PDF from this tab (style.css, app.js).
try { const t = localStorage.getItem('theme'); if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; } catch {}
if (location.protocol === 'chrome-extension:') document.documentElement.dataset.context = 'extension';
