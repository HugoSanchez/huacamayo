'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import styles from './triage-preview.module.css';

const sessions = [
  ['New chat', '3m', '12 messages'],
  ['Board update', '18m', '26 messages'],
  ['Weekly prep', '1h', '8 messages'],
  ['Hiring loop', '2h', '15 messages'],
  ['Personal admin', '1d', '6 messages'],
] as const;

const appConnections = [
  ['gmail', 'Gmail'],
  ['googlecalendar', 'Calendar'],
  ['googledrive', 'Drive'],
  ['granola_mcp', 'Granola'],
  ['notion', 'Notion'],
  ['slack', 'Slack'],
  ['todoist', 'Todoist'],
] as const;

const activityRows = [
  ['slack', 'wide'],
  ['gmail', 'medium'],
  ['notion', 'long'],
  ['todoist', 'short'],
  ['googlecalendar', 'medium'],
  ['googledrive', 'wide'],
] as const;

const features = [
  {
    title: 'Integrated memory system',
    desc: "The memory system is able to get full context of everything happening around you while keeping verything stored on your laptop.",
    graphic: 'bars',
  },
  {
    title: 'Connect any app',
    desc: 'Easily connect the apps you already use and automate and orchestrations amongst them.',
    graphic: 'flow',
  },
  {
    title: 'Any model, full control.',
    desc: 'Switch between model providers without losing any context: all conversations are shared across providers.',
    graphic: 'chart',
  },
] as const;

export default function TriagePreviewPage() {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');

  useEffect(() => {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    setTheme(prefersDark ? 'dark' : 'light');
  }, []);

  const currentYear = useMemo(() => new Date().getFullYear(), []);

  return (
    <main className={styles.page} data-theme={theme}>
      <nav className={styles.nav}>
        <div className={styles.navInner}>
          <Link href="/triage-preview" className={styles.brand}>
            verso.
          </Link>
          <div className={styles.navActions}>
            <button
              className={styles.iconButton}
              type="button"
              title="Toggle theme"
              aria-label="Toggle theme"
              onClick={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
            >
              {theme === 'dark' ? <MoonIcon /> : <SunIcon />}
            </button>
            <Link className={styles.textLink} href="/login">
              Log in
            </Link>
            <Link className={styles.outlineButton} href="/login">
              Sign up
            </Link>
          </div>
        </div>
      </nav>

      <section className={styles.hero}>
        <div className={styles.heroInner}>
          <div className={styles.heroTop}>
            <div className={styles.heroText}>
              <h1>Free, open-source, GUI to orchestrate Hermes Agents.</h1>
              <p>
                Verso is the easiest way to run local Hermes agents that connect to the apps you already use — email, calendar, slack, you name it — to help you do more.
              </p>
              <div className={styles.heroActions}>
                <Link className={styles.primaryButton} href="/login">
                  Download for free
                  <ArrowRightIcon />
                </Link>
              </div>
            </div>

            <LogoScene />
          </div>

          <IssueMockup />
        </div>
      </section>

      <Divider />

      <section className={styles.section}>
        <div className={styles.sectionInner}>
          <p className={styles.eyebrow}>Built for simplicity</p>
          <h2>
           Everything you need.
            <br />
           Nothing you don't.
          </h2>

          <div className={styles.featureGrid}>
            {features.map((feature) => (
              <article className={styles.feature} key={feature.title}>
                <div className={styles.featureGraphic}>
                  <FeatureGraphic kind={feature.graphic} />
                </div>
                <h3>{feature.title}</h3>
                <p>{feature.desc}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <Divider />

      <section className={styles.quoteSection}>
        <DiagonalShade />
        <div className={styles.quoteCard}>
          <blockquote>
            "Hermes is a powerful open-source AI harness that really gets work done. Under the hood, Verso leverages Hermes Agent to help you get shit done"
          </blockquote>
          <div className={styles.person}>
            <div className={styles.avatar} aria-hidden="true">
              JK
            </div>
            <div>
              <span>Jamie Kim</span>
              <span>Engineering Lead, Acme Corp</span>
            </div>
          </div>
        </div>
      </section>

      <Divider />

      <section className={styles.cta}>
        <h2>Your bugs aren't going to track themselves.</h2>
        <p>
          Two minutes to set up. No credit card. No sales call.
          <br />
          Just fewer bugs, starting now.
        </p>
        <Link className={styles.secondaryButton} href="/login">
          Start tracking now
          <ArrowRightIcon />
        </Link>
      </section>

      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          <div className={styles.brand}>
            verso.
          </div>
          <span>{currentYear}</span>
        </div>
      </footer>
    </main>
  );
}

function IssueMockup() {
  return (
    <div className={styles.mockupShell}>
      <div className={`${styles.mockup} ${styles.versoSilhouette}`}>
        <aside className={styles.silhouetteSidebar}>
          <div className={styles.traffic}>
            <i />
            <i />
            <i />
          </div>

          <div className={styles.silhouetteSidebarHead}>
            <div>
              <span>Sessions</span>
              <strong>Active workspace</strong>
            </div>
            <button type="button" aria-label="New chat">
              +
            </button>
          </div>

          <div className={styles.silhouetteConnectorRail}>
            {appConnections.slice(0, 6).map(([logo, name]) => (
              <img src={logoUrl(logo)} alt="" aria-hidden="true" key={name} />
            ))}
          </div>

          <span className={styles.silhouetteSectionTitle}>Active</span>
          <div className={styles.silhouetteSessions}>
            {sessions.map(([title, meta, preview], itemIndex) => (
              <div
                className={itemIndex === 1 ? styles.silhouetteSessionActive : styles.silhouetteSession}
                key={title}
              >
                <div>
                  <i>{title}</i>
                  <em>{meta}</em>
                </div>
                <p>{preview}</p>
              </div>
            ))}
          </div>

          <span className={styles.silhouetteSectionTitle}>Custom</span>
          <div className={styles.silhouetteCustomRow}>
            <span />
            <i />
          </div>
        </aside>

        <section className={styles.silhouetteMain}>
          <header className={styles.silhouetteHeader}>
            <div>
              <strong>Board update</strong>
              <span>26 messages · updated 18m ago</span>
            </div>
            <button type="button">Archive</button>
          </header>

          <div className={styles.silhouetteCanvas}>
            <div className={styles.silhouetteThread}>
              <div className={styles.silhouettePrompt}>
                <span />
                <span />
              </div>

              <div className={styles.silhouetteActivity}>
                <div className={styles.silhouetteActivityHead}>
                  <div className={styles.silhouetteLogoRow}>
                    {appConnections.slice(0, 5).map(([logo, name]) => (
                      <img src={logoUrl(logo)} alt="" aria-hidden="true" key={name} />
                    ))}
                  </div>
                  <span />
                </div>

                <div className={styles.silhouetteRows}>
                  {activityRows.map(([logo, length], index) => (
                    <div className={styles.silhouetteRow} data-length={length} key={`${logo}-${index}`}>
                      <img src={logoUrl(logo)} alt="" aria-hidden="true" />
                      <span />
                      <i />
                    </div>
                  ))}
                </div>
              </div>

              <div className={styles.silhouetteAnswer}>
                <span />
                <span />
                <span />
                <span />
              </div>
            </div>
          </div>

          <div className={styles.silhouetteComposer}>
            <span />
            <div>
              <i />
              <i />
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function FeatureGraphic({ kind }: { kind: (typeof features)[number]['graphic'] }) {
  if (kind === 'bars') {
    return (
      <div className={styles.bars}>
        {[
          ['100%', 'danger'],
          ['75%', 'warning'],
          ['50%', 'primary'],
          ['25%', 'success'],
        ].map(([width, color]) => (
          <span className={styles[color]} key={width} style={{ width }} />
        ))}
      </div>
    );
  }

  if (kind === 'flow') {
    return (
      <div className={styles.flow}>
        {['info', 'warning', 'success'].map((color) => (
          <span key={color}>
            <i className={styles[color]} />
            <b />
          </span>
        ))}
      </div>
    );
  }

  return (
    <div className={styles.chart}>
      {[40, 65, 45, 80, 55, 70, 90].map((height) => (
        <span key={height} style={{ height: `${height}%` }}>
          <DiagonalShade compact />
        </span>
      ))}
    </div>
  );
}

function LogoScene() {
  return (
    <div className={styles.logoScene} aria-hidden="true">
      <div className={styles.logoCube}>
        <span />
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}

function Divider() {
  return <div className={styles.divider} />;
}

function DiagonalShade({ compact = false }: { compact?: boolean }) {
  return <span className={compact ? styles.diagonalCompact : styles.diagonalShade} aria-hidden="true" />;
}

function ArrowRightIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 8h9" />
      <path d="m8.5 3.5 4.5 4.5-4.5 4.5" />
    </svg>
  );
}

function logoUrl(name: string) {
  return `https://logos.composio.dev/api/${name}`;
}

function SunIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.42 1.42M11.53 11.53l1.42 1.42M12.95 3.05l-1.42 1.42M4.47 11.53l-1.42 1.42" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M13.2 10.4A5.5 5.5 0 0 1 5.6 2.8 5.5 5.5 0 1 0 13.2 10.4Z" />
    </svg>
  );
}
