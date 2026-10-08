// The legacy React router has no instructor route and currently sends every
// non-admin login to /student. Record an instructor login, then turn that next
// client-side navigation into a full navigation to the dedicated workspace.
(() => {
  const isStudentRoute = (url) => {
    if (typeof url !== 'string') return false;
    try { return new URL(url, window.location.origin).pathname === '/student'; }
    catch { return false; }
  };
  const fetchOriginal = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const response = await fetchOriginal(...args);
    const requestUrl = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
    if (response.ok && /\/auth\/login(?:\?|$)/.test(requestUrl)) {
      try {
        const body = await response.clone().json();
        if (body?.user?.role === 'instructor') sessionStorage.setItem('reali_instructor_login', '1');
      } catch {}
    }
    return response;
  };
  const redirectInstructor = (url) => {
    if (isStudentRoute(url) && sessionStorage.getItem('reali_instructor_login') === '1') {
      sessionStorage.removeItem('reali_instructor_login');
      window.location.assign('/instructor');
      return true;
    }
    return false;
  };
  const pushState = history.pushState.bind(history);
  history.pushState = (state, title, url) => {
    if (redirectInstructor(url)) return;
    return pushState(state, title, url);
  };
  const replaceState = history.replaceState.bind(history);
  history.replaceState = (state, title, url) => {
    if (redirectInstructor(url)) return;
    return replaceState(state, title, url);
  };
})();
