import Link from "next/link";
import { getCertifications } from "../lib/db";
import type { Certification } from "../lib/types";

function CertificationCard({
  cert,
  index,
  latest = false,
  earlierEdition = false,
}: {
  cert: Certification;
  index: number;
  latest?: boolean;
  earlierEdition?: boolean;
}) {
  return (
    <Link
      className={`cert-card${latest ? " cert-card-latest" : ""}`}
      href={`/exams/${cert.slug}/practice`}
    >
      <div className="card-top">
        <span className="card-number">{String(index + 1).padStart(2, "0")}</span>
        <span className={latest ? "latest-badge" : "card-type"}>
          {latest ? "Latest · Second edition" : earlierEdition ? "Earlier edition" : "Practice set"}
        </span>
      </div>
      <h3>{cert.title}</h3>
      {cert.sourceRevisedAt && (
        <p className="card-revision">
          Revised{" "}
          <time dateTime={cert.sourceRevisedAt}>
            {new Intl.DateTimeFormat("en-GB", {
              day: "numeric",
              month: "long",
              year: "numeric",
              timeZone: "UTC",
            }).format(new Date(`${cert.sourceRevisedAt}T00:00:00Z`))}
          </time>
        </p>
      )}
      <p className="card-description">{cert.description}</p>
      <div className="card-footer">
        <span className="card-meta">
          {cert.questionCount} questions · {cert.domainCount} domains
        </span>
        <span className="arrow" aria-hidden="true">
          ↗
        </span>
      </div>
    </Link>
  );
}

export default function HomePage() {
  const certifications = getCertifications();
  const revised = certifications.filter((cert) => cert.sourceRevisedAt);
  const latest = revised
    .filter(
      (cert) =>
        !revised.some(
          (other) => other.title === cert.title && other.sourceRevisedAt! > cert.sourceRevisedAt!,
        ),
    )
    .sort((a, b) => b.sourceRevisedAt!.localeCompare(a.sourceRevisedAt!));
  const more = certifications.filter((cert) => !latest.includes(cert));
  const totalQuestions = certifications.reduce(
    (total, certification) => total + certification.questionCount,
    0,
  );
  return (
    <main className="site-shell">
      <header className="topbar">
        <Link className="wordmark" href="/">
          <span className="mark">B</span> BrainDump.com
        </Link>
        <span className="topbar-note">Independent exam preparation / v1.0</span>
      </header>
      <section className="hero">
        <div>
          <p className="eyebrow">Independent Claude certification practice</p>
          <h1>
            Practice with purpose. <em>Arrive ready.</em>
          </h1>
        </div>
        <div className="hero-copy">
          <p>
            Build confidence before exam day with {certifications.length} focused practice sets,
            drawn from the supplied practice PDFs and organized for deliberate study.{" "}
            <strong>Choose your track, test your thinking, and learn from every answer.</strong>
          </p>
        </div>
        <div className="hero-index">
          <b>Study index</b>
          <span>{String(certifications.length).padStart(2, "0")}</span> certification sets
          <br />
          <span>{totalQuestions}</span> source questions
          <br />
          <span>{String(latest.length).padStart(2, "0")}</span> newly revised sets
        </div>
      </section>
      {latest.length > 0 && (
        <section className="content latest-section" aria-labelledby="latest-exams">
          <div className="section-heading">
            <div>
              <p className="eyebrow">New in the practice library</p>
              <h2 id="latest-exams">Latest updated practice sets</h2>
            </div>
            <p>
              Start with these rewritten second editions. Revision dates come from the supplied
              PDFs; all questions are independent practice material.
            </p>
          </div>
          <div className="cert-grid latest-grid">
            {latest.map((cert, index) => (
              <CertificationCard cert={cert} index={index} latest key={cert.slug} />
            ))}
          </div>
        </section>
      )}
      <section className="content" aria-labelledby="choose-exam">
        <div className="section-heading">
          <h2 id="choose-exam">{latest.length ? "More practice sets" : "Find your exam track"}</h2>
          <p>
            Explore Foundations and earlier editions. Study untimed, or switch on the optional
            practice timer when you’re ready.
          </p>
        </div>
        <div className="cert-grid">
          {more.map((cert, index) => (
            <CertificationCard
              cert={cert}
              index={latest.length + index}
              earlierEdition={latest.some((updated) => updated.title === cert.title)}
              key={cert.slug}
            />
          ))}
        </div>
        <div className="disclaimer">
          <strong>Note</strong>
          <span>
            These are independent practice questions. They are not official live-exam content and do
            not guarantee a pass. Use them alongside hands-on experience and the official
            documentation.
          </span>
        </div>
      </section>
      <footer className="footer">
        <span>Practice clearly. Learn deeply.</span>
        <span>Independent study companion</span>
      </footer>
    </main>
  );
}
