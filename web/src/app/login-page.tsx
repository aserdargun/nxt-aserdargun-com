export const GITHUB_LOGIN_PATH = "/.auth/login/github?post_login_redirect_uri=/app";

export const LoginPage = (): React.JSX.Element => (
  <div className="route-page">
    <header className="route-header">
      <span className="brand">NXT</span>
    </header>
    <main className="route-main" aria-labelledby="login-title">
      <h1 id="login-title" className="sr-only">NXT</h1>
      <a className="primary-link touch-target" href={GITHUB_LOGIN_PATH}>
        Continue with GitHub
      </a>
    </main>
  </div>
);
