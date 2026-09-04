export const GITHUB_LOGIN_PATH = "/.auth/login/github?post_login_redirect_uri=/app";

export const LoginPage = (): React.JSX.Element => (
  <div className="route-page">
    <header className="route-header">
      <span className="brand">NXT</span>
    </header>
    <main className="route-main" aria-labelledby="login-title">
      <section className="login-panel">
        <p className="login-owner">Owner workspace</p>
        <h1 id="login-title">Private Markdown workspace</h1>
        <p>Owner access only. GitHub verifies identity; notes remain in Google Drive.</p>
        <a className="primary-link touch-target" href={GITHUB_LOGIN_PATH}>Continue with GitHub</a>
        <p className="login-trust">Private by default · Unlisted snapshots only</p>
      </section>
    </main>
  </div>
);
