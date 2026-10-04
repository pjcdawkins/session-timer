/**
 * Light/dark theme toggle. With no saved choice the page follows the system
 * theme (via the prefers-color-scheme CSS media query). Picking the theme that
 * matches the system clears the saved choice, so it goes back to following it.
 *
 * The saved choice is applied before first paint by an inline script in each
 * page's <head>; keep STORAGE_KEY in sync with it.
 */

const STORAGE_KEY = "theme";

const ICON_SUN = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="12" cy="12" r="4"/>
  <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>
</svg>`;

const ICON_MOON = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
</svg>`;

const systemDark = window.matchMedia("(prefers-color-scheme: dark)");

function systemTheme() {
  return systemDark.matches ? "dark" : "light";
}

function currentTheme() {
  return document.documentElement.dataset.theme || systemTheme();
}

function applyTheme(theme) {
  if (theme === systemTheme()) {
    delete document.documentElement.dataset.theme;
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
  } else {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem(STORAGE_KEY, theme); } catch {}
  }
}

export function initTheme() {
  const btn = document.createElement("button");
  btn.id = "btn-theme";
  document.body.appendChild(btn);

  function update() {
    // Show the icon for the theme a click will switch to.
    const isDark = currentTheme() === "dark";
    btn.innerHTML = isDark ? ICON_SUN : ICON_MOON;
    btn.setAttribute("aria-label", isDark ? "Switch to light mode" : "Switch to dark mode");
  }

  btn.addEventListener("click", () => {
    applyTheme(currentTheme() === "dark" ? "light" : "dark");
    update();
  });

  // Safari < 14 only supports the deprecated addListener().
  if (systemDark.addEventListener) {
    systemDark.addEventListener("change", update);
  } else {
    systemDark.addListener(update);
  }
  update();
}
