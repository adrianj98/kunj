// Inline client-side assets served as static routes

export const APP_JS = `
// HTMX event handlers and dashboard utilities
document.addEventListener('htmx:afterSwap', function(evt) {
  // Flash effect on updated widgets
  const target = evt.detail.target;
  if (target && target.classList) {
    target.classList.add('ring-2', 'ring-blue-400');
    setTimeout(() => target.classList.remove('ring-2', 'ring-blue-400'), 500);
  }
});

document.addEventListener('htmx:sendError', function(evt) {
  showToast('Connection error', 'error');
});

document.addEventListener('htmx:responseError', function(evt) {
  showToast('Command failed: ' + (evt.detail.xhr?.statusText || 'Unknown error'), 'error');
});

function showToast(message, type) {
  const toast = document.createElement('div');
  toast.className = 'fixed bottom-4 right-4 px-4 py-2 rounded-lg shadow-lg text-white text-sm z-50 transition-opacity duration-300 ' +
    (type === 'error' ? 'bg-red-600' : 'bg-green-600');
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// Dark mode
const darkToggle = document.getElementById('dark-toggle');
if (darkToggle) {
  darkToggle.addEventListener('click', () => {
    document.documentElement.classList.toggle('dark');
    localStorage.setItem('darkMode', document.documentElement.classList.contains('dark'));
  });
}
if (localStorage.getItem('darkMode') === 'true') {
  document.documentElement.classList.add('dark');
}
`;

export const STYLES_CSS = `
/* Minimal custom styles beyond Tailwind */
.widget-loading {
  opacity: 0.5;
  pointer-events: none;
}
.htmx-request .widget-loading-indicator {
  display: inline-block;
}
.widget-loading-indicator {
  display: none;
}
[hx-indicator] .htmx-indicator {
  display: inline-block;
}
.htmx-indicator {
  display: none;
}
`;
