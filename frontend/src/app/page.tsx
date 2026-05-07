import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="page-shell">
      <section className="hero">
        <div className="eyebrow">Vervo Frontend</div>
        <h1>Auth and onboarding surface for the managed app.</h1>
        <p>
          This app will own Privy login, browser-to-native handoff, and future
          account and website pages. For now it is intentionally small.
        </p>
        <div className="actions">
          <Link className="button button-primary" href="/login">
            Open login flow
          </Link>
          <Link className="button" href="/handoff">
            View handoff page
          </Link>
        </div>
      </section>
    </main>
  );
}
