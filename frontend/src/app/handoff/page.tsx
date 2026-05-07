import Link from 'next/link';

export default function HandoffPage() {
  return (
    <main className="page-shell">
      <section className="card">
        <div className="eyebrow">Browser to native</div>
        <h1>macOS handoff placeholder</h1>
        <p>
          This page is where the web auth flow will redirect once the backend
          has issued a short-lived handoff token. The final version will send
          the user back into the app through a custom URL scheme.
        </p>

        <div className="notice">
          <div className="status-row">
            <span>Target callback</span>
            <strong className="mono">vervo://auth/callback</strong>
          </div>
        </div>

        <div className="grid">
          <div className="card">
            <div className="eyebrow">Current scope</div>
            <div className="status-list">
              <div className="status-row">
                <span>Redirect format</span>
                <strong>Pending</strong>
              </div>
              <div className="status-row">
                <span>Token exchange</span>
                <strong>Pending</strong>
              </div>
              <div className="status-row">
                <span>Keychain storage</span>
                <strong>Native</strong>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="eyebrow">Next integration</div>
            <div className="status-list">
              <div className="status-row">
                <span>Privy login</span>
                <strong>Web</strong>
              </div>
              <div className="status-row">
                <span>App session</span>
                <strong>Backend</strong>
              </div>
              <div className="status-row">
                <span>Deep link</span>
                <strong>macOS</strong>
              </div>
            </div>
          </div>
        </div>

        <div className="actions">
          <Link className="button" href="/login">
            Back to login
          </Link>
          <Link className="button" href="/">
            Home
          </Link>
        </div>
      </section>
    </main>
  );
}
