import Link from "next/link";
import { getCertifications } from "../lib/db";

export default function HomePage() {
  const certifications = getCertifications();
  const totalQuestions = certifications.reduce((total, certification) => total + certification.questionCount, 0);
  return (
    <main className="site-shell">
      <header className="topbar"><Link className="wordmark" href="/"><span className="mark">B</span> BrainDump.com</Link><span className="topbar-note">Independent exam preparation / v1.0</span></header>
      <section className="hero">
        <div><p className="eyebrow">Independent Claude certification practice</p><h1>Practice with purpose. <em>Arrive ready.</em></h1></div>
        <div className="hero-copy"><p>Build confidence before exam day with four focused practice sets, sourced from real certification blueprints and organized for deliberate study. <strong>Choose your track, test your thinking, and learn from every answer.</strong></p></div>
        <div className="hero-index"><b>Study index</b><span>{String(certifications.length).padStart(2, "0")}</span> certification sets<br /><span>{totalQuestions}</span> source questions<br /><span>03</span> question formats</div>
      </section>
      <section className="content" aria-labelledby="choose-exam"><div className="section-heading"><h2 id="choose-exam">Find your exam track</h2><p>Start with the certification you’re preparing for. Study untimed, or switch on the 120-minute exam simulation when you’re ready.</p></div>
        <div className="cert-grid">{certifications.map((cert, index) => <Link className="cert-card" href={`/exams/${cert.slug}/practice`} key={cert.slug}><div className="card-top"><span className="card-number">0{index + 1}</span><span className="card-type">Practice set</span></div><h3>{cert.title}</h3><p className="card-description">{cert.description}</p><div className="card-footer"><span className="card-meta">{cert.questionCount} questions · {cert.questionCount} marks · {cert.domainCount} domains</span><span className="arrow" aria-hidden="true">↗</span></div></Link>)}</div>
        <div className="disclaimer"><strong>Note</strong><span>These are independent practice questions. They are not official live-exam content and do not guarantee a pass. Use them alongside hands-on experience and the official documentation.</span></div>
      </section>
      <footer className="footer"><span>Practice clearly. Learn deeply.</span><span>Independent study companion · authentication coming later</span></footer>
    </main>
  );
}
