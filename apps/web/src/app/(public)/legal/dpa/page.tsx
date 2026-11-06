import type { Metadata } from 'next';
import Link from 'next/link';
import { DPA_VERSION, grievanceContact, LegalPage, OPERATOR, Section } from '@/components/legal';

export const metadata: Metadata = {
  title: 'Data processing agreement · Tiffin Bhubaneswar',
  description: 'How Tiffin Bhubaneswar processes kitchen customers’ personal data on behalf of each kitchen.',
  robots: { index: false, follow: true },
};

// DRAFT for a lawyer (D-142). Accepted with the vendor terms and recorded in consents
// (purpose data_processing, notice_version = DPA_VERSION = private.vendor_terms_versions()).
export default function DpaPage() {
  return (
    <LegalPage title="Data processing agreement" updated="12 November 2026"
      draftNote={`DRAFT ${DPA_VERSION}: not legal advice. A lawyer must review this agreement before any kitchen outside the pilot uploads customer data.`}>
      <Section id="roles" title="1. Roles">
        <p>
          The kitchen is the <strong>data fiduciary</strong> for its customers’ personal data. <strong>{OPERATOR.name}</strong> ({OPERATOR.brand})
          is its <strong>data processor</strong> and processes that data only to provide the software, on the kitchen’s instructions, as set out here.
          This agreement is part of the <Link href="/legal/vendor-terms" className="text-brand-700 underline">vendor terms</Link>.
        </p>
      </Section>

      <Section id="data" title="2. What data, and why">
        <ul>
          <li><strong>Customers:</strong> name, phone number (stored encrypted; staff and riders see the last 4 digits), delivery addresses and map pins, diet, optional health tags recorded with consent, plans, meals, payments, dues, refunds, complaints.</li>
          <li><strong>Team:</strong> phone numbers and roles of the kitchen’s staff and riders; riders’ delivery proofs (photos, times, locations at delivery).</li>
          <li><strong>Purpose:</strong> running the kitchen’s service only: counts, cooking, packing, delivery, billing and records.</li>
        </ul>
      </Section>

      <Section id="duties" title="3. What we do">
        <ul>
          <li>Process the data only for the kitchen and never sell it, use it for our own marketing, or share it with another kitchen.</li>
          <li>Keep it secure: encryption of phone numbers with keys held outside the code, access limited by role, an audit log of changes and of every phone-number reveal, backups.</li>
          <li>Make sure everyone at {OPERATOR.brand} who can access it is bound to confidentiality.</li>
          <li>Help the kitchen answer customers’ requests to access, correct or erase their data (the app’s Erase customer action removes name, phone and address from the records we keep).</li>
          <li>Tell the kitchen without undue delay, and within 72 hours of finding out, about a personal data breach affecting its customers, and help it notify the Data Protection Board and the people affected as the law requires.</li>
          <li>Delete or return the data when the kitchen leaves (30 days after leaving, except records the law requires us to keep), as described in the vendor terms.</li>
        </ul>
      </Section>

      <Section id="subprocessors" title="4. Sub-processors">
        <p>We use these service providers to run the software. We will tell kitchens before adding a new one.</p>
        <ul>
          <li><strong>Supabase</strong>: database, file storage and servers.</li>
          <li><strong>An SMS provider</strong> (login codes for the kitchen’s team): [name once chosen, D-004].</li>
          <li><strong>Cloudflare</strong>: website hosting and the anti-spam check (Turnstile) on public forms.</li>
          <li><strong>Sentry</strong> (error reports, without phone numbers), only if enabled.</li>
          <li><strong>Anthropic</strong>, only if the kitchen uses notebook-photo import: the photo of the register is sent to read it.</li>
          <li>Later phases, only when switched on and announced: Meta (WhatsApp), Razorpay (online payments), Google (ads conversions).</li>
        </ul>
      </Section>

      <Section id="kitchen" title="5. What the kitchen does">
        <ul>
          <li>Collects only what it needs and has a lawful basis for it (for most customers: their agreement to be contacted about their tiffin, recorded in the app).</li>
          <li>Records health information only with the customer’s explicit consent.</li>
          <li>Tells customers that the kitchen uses {OPERATOR.brand} software; our <Link href="/privacy" className="text-brand-700 underline">privacy policy</Link> explains the details.</li>
        </ul>
      </Section>

      <Section id="contact" title="6. Contact">
        <p>Questions, requests and breach reports: {grievanceContact()}.</p>
        <p>[Audit rights, liability and international transfer clauses: to be written by a lawyer.]</p>
      </Section>
    </LegalPage>
  );
}
