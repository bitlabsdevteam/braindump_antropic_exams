import Link from "next/link";
import { notFound } from "next/navigation";
import { getCertification, getDomains, getQuestions } from "../../../../lib/db";
import PracticeClient from "../../../../components/PracticeClient";

export default async function PracticePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const certification = getCertification(slug);
  if (!certification) notFound();
  const questions = getQuestions(slug);
  const domains = getDomains(slug);
  return (
    <main className="practice-shell">
      <header className="practice-top">
        <Link className="back-link" href="/">
          ← All certification sets
        </Link>
        <span className="practice-title">
          <span className="mark">B</span>BrainDump.com · {certification.shortTitle}
        </span>
      </header>
      <div className="practice-main">
        <section>
          <div className="practice-heading">
            <div>
              <p className="eyebrow">{certification.shortTitle} / practice set</p>
              <h1>{certification.title}</h1>
            </div>
            <div className="practice-stat">
              <strong>{questions.filter((question) => !question.reviewRequired).length}</strong>
              scorable questions
              <br />
              {questions.length} questions · 1 mark each
            </div>
          </div>
          <details className="source-disclaimer">
            <summary>Source disclaimer · {certification.sourceVersion}</summary>
            <p>{certification.disclaimer}</p>
          </details>
          <PracticeClient
            certification={slug}
            questions={questions}
            domains={domains}
            timeLimitMinutes={certification.timeLimitMinutes}
          />
        </section>
      </div>
    </main>
  );
}
