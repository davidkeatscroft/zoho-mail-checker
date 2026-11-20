import { POPUP_SIZES, THEMES } from './config.js';

// Pages style themselves from these attributes: data-theme is light, dark or absent
// (follow the system), and data-size is the popup size.
export function applyAppearance({ theme, popupSize } = {}) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  else delete root.dataset.theme;
  root.dataset.size = POPUP_SIZES.includes(popupSize) ? popupSize : 'default';
}

export function effectiveTheme(theme) {
  if (THEMES.includes(theme) && theme !== 'auto') return theme;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
