import Link from "next/link";
import { PixelAgent } from "../pixel-agent";
import { LogoFlower } from "./meadow";
import { MeadowScene, Roamers } from "./scene";

/*
 * The about page: what moa does and why, as a short illustrated write-up between
 * two strips of the landing meadow.
 */

const REPO_URL = "https://github.com/petersenmatthew/moa";
const DEMO_URL = "https://www.youtube.com/watch?v=K_pESfSqoDQ";

const TEAM = [
  { id: "agent.compute", name: "GPU Auditor", line: "Checks what actually ran against what was billed." },
  { id: "agent.finance", name: "Cost Allocator", line: "Reads the contract, works out what is owed, and drafts the dispute." },
  { id: "agent.vendor", name: "Vendor Liaison", line: "Emails the vendor, reads the replies, and closes the case." },
  { id: "agent.capacity", name: "Capacity Planner", line: "Splits shared GPU reservations between the teams that used them." },
  { id: "agent.budget", name: "Budget Analyst", line: "Watches each team's compute spend and warns before it runs over." },
  { id: "agent.policy", name: "Controls Lead", line: "Turns your past decisions into rules you can approve." },
];

function Shot({ src, alt, caption, width = 1920, height = 1280 }: { src: string; alt: string; caption: string; width?: number; height?: number }) {
  return (
    <figure className="!my-10">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        width={width}
        height={height}
        loading="lazy"
        className="h-auto w-full rounded-2xl border-4 border-white bg-white shadow-[0_6px_0_rgb(31_59_90/0.14)] ring-1 ring-[#1f3b5a]/10"
      />
      <figcaption className="mt-3 text-center text-[14px] leading-relaxed text-[#1f3b5a]/60">{caption}</figcaption>
    </figure>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-16 first:mt-0">
      <h2 className="text-[30px] leading-tight font-semibold tracking-[-0.03em] text-[#1f3b5a] sm:text-[36px]">
        {title}
      </h2>
      <div className="mt-4 space-y-4 text-[17px] leading-[1.7] text-[#2c4560]">{children}</div>
    </section>
  );
}

export function About() {
  return (
    <div className="h-dvh overflow-y-auto bg-[#fbf8ef]">

      {/* Grows with the width; the scene is cut just below the hills, so they always sit along the bottom edge. */}
      <header className="relative h-[clamp(300px,30vw,520px)] overflow-hidden bg-[#45b4ee]">
        <div className="absolute bottom-0 left-1/2 aspect-video w-[max(100%,760px)]" style={{ transform: "translate(-50%, 38%)" }}>
          <MeadowScene />
          {/* In scene coordinates: the title rests just above the dithered band at row 62 of 180. */}
          <div className="absolute inset-x-0 bottom-[65.6%] px-6 pb-[0.4%] text-center">
            <h1 className="text-[52px] leading-[0.9] font-semibold tracking-[-0.04em] text-white sm:text-[80px]">About moa</h1>
          </div>
        </div>
        <nav className="absolute inset-x-0 top-0 z-10 px-6 py-5">
          <Link href="/" className="inline-flex items-center gap-2 text-[24px] leading-none font-semibold tracking-[-0.03em] text-white">
            <LogoFlower size={22} />
            moa
          </Link>
        </nav>
      </header>

      <main className="mx-auto max-w-[760px] px-6 py-16 sm:py-20">
        <Section title="The problem">
          <p>
            AI labs rent GPUs by the hour from several clouds at once, and the bills are long. Nobody has time to check each line against what actually ran.
            So when a provider keeps billing after an instance was shut down, the lab usually pays it.
          </p>
        </Section>

        <Section title="What moa does">
          <p>
            moa checks each invoice line against three other records: the cluster&apos;s shutdown log, the provider&apos;s usage meter, and the training job logs.
            When they disagree, it works out what the contract says is owed, asks you to approve a dispute, emails the vendor, and books the credit when it
            arrives.
          </p>
          <Shot
            src="/landing/about-canvas.jpg"
            alt="The moa canvas with six agents around the controller"
            caption="The canvas. You sit in the middle, the six agents sit around you, and their work shows up as cards while it happens."
          />
          <p>
            Take a Lambda bill for 36 hours. The job ran for 22 hours, and the instance was shut down at hour 24. moa disputes 12 hours, not 14, because the
            contract counts idle time on a running instance as billable. A dispute that asks for exactly what the contract supports is hard for the vendor to
            refuse.
          </p>
          <Shot
            src="/landing/about-findings.jpg"
            alt="The GPU Auditor's findings for a Lambda invoice"
            caption="The GPU Auditor lines up the bill, the instance lifetime, the job logs, and the contract. 12 of the 36 billed hours have no support."
          />
        </Section>

        <Section title="Meet the team">
          <p>Six agents, each with one job and only the tools that job needs.</p>
          <ul className="!mt-8 grid gap-3 sm:grid-cols-2">
            {TEAM.map((m) => (
              <li key={m.id} className="flex items-center gap-4 rounded-2xl border-2 border-white bg-white/70 p-4 shadow-[0_4px_0_rgb(31_59_90/0.08)]">
                <span className="flex size-14 shrink-0 items-center justify-center rounded-xl bg-[#e7f4fb]">
                  <PixelAgent actorId={m.id} size={40} />
                </span>
                <span>
                  <span className="block text-[16px] font-semibold text-[#1f3b5a]">{m.name}</span>
                  <span className="block text-[14px] leading-snug text-[#2c4560]/80">{m.line}</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="!mt-6">Then there&apos;s you, the controller. Every approval, posting, and payment is yours.</p>
        </Section>

        <Section title="You make the calls">
          <p>
            The agents never approve, post, or pay anything on their own. When a decision needs a person, they stop and ask, on the canvas or in Slack. Say
            &ldquo;yes, but&rdquo; and they rework the plan.
          </p>
          <p>
            The limits are in the code, not the prompt. Every action goes through one gateway that checks the agent&apos;s permissions, does the money math,
            and confirms that any contract clause it cites exists.
          </p>
        </Section>

        <Section title="It talks to the vendor">
          <p>
            Once you approve, the Vendor Liaison emails the dispute with the clauses that back it, then reads the reply. It handles partial offers, follows up
            if the vendor goes quiet, and closes the case when a credit memo arrives.
          </p>
          <Shot src="/landing/about-dispute.jpg" alt="A dispute email sent to Lambda" caption="A dispute sent to Lambda, citing the contract's termination and billing clauses." />
        </Section>

        <Section title="Every step is on the record">
          <p>
            Each tool call, posting, and decision is written to a log that can only grow. Entries are chained by hash, so nothing can be quietly changed later.
            Months on, &ldquo;why did we pay this?&rdquo; is one lookup.
          </p>
          <Shot
            src="/landing/about-audit.jpg"
            width={1440}
            height={900}
            alt="The audit trail listing each agent action"
            caption="The audit trail: who did what, when, and which rule allowed it."
          />
        </Section>

        <Section title="Try it yourself">
          <p>
            The lab in the demo, xAnthropenAI, is made up, and so are its bills. Send it a billing event, from a plain overbilling case to a reservation two
            teams shared, or write your own invoice line and watch the team work it.
          </p>
          <Shot src="/landing/about-events.jpg" alt="The billing event picker" caption="Every billing event goes through the same checks and the same team." />
        </Section>
      </main>

      {/* Grows with the width so the sky stays in view on wide screens; the base colour matches the top of the sky. */}
      <footer className="relative h-[clamp(460px,48vw,720px)] overflow-hidden bg-[#45b4ee]">
        <div className="absolute bottom-0 left-1/2 aspect-video w-[max(100%,820px)] -translate-x-1/2">
          <MeadowScene />
        </div>
        <Roamers />
        <div className="pointer-events-none absolute inset-x-0 top-[16%] z-[200] flex flex-col items-center px-6 text-center">
          <p className="text-[28px] font-semibold tracking-[-0.03em] text-white sm:text-[34px]">
            See it work
          </p>
          <div className="pointer-events-auto mt-5 flex gap-3">
            <a
              href={DEMO_URL}
              className="flex items-center gap-2 rounded-xl bg-white px-6 py-3 text-[15px] font-semibold text-[#1f3b5a] shadow-[0_4px_0_rgb(31_59_90/0.18)] transition-transform hover:-translate-y-0.5"
            >
              <span className="h-0 w-0 border-y-[6px] border-l-[9px] border-y-transparent border-l-current" />
              Watch the demo
            </a>
            <a
              href={REPO_URL}
              className="flex items-center rounded-xl bg-[#1f3b5a] px-6 py-3 text-[15px] font-semibold text-white shadow-[0_4px_0_rgb(0_0_0/0.18)] transition-transform hover:-translate-y-0.5"
            >
              GitHub
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
