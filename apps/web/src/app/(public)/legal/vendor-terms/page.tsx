import type { Metadata } from 'next';
import Link from 'next/link';
import { grievanceContact, LegalPage, OPERATOR, Section, VENDOR_TERMS_VERSION } from '@/components/legal';

export const metadata: Metadata = {
  title: 'Vendor terms · Tiffin Bhubaneswar',
  description: 'Terms for tiffin kitchens that use the Tiffin Bhubaneswar software.',
  robots: { index: false, follow: true },
};

// DRAFT for a lawyer (D-142). Accepted by the kitchen owner at onboarding and recorded in consents
// (purpose vendor_terms, notice_version = VENDOR_TERMS_VERSION, which must match
// private.vendor_terms_versions() in the database).
export default function VendorTermsPage() {
  return (
    <LegalPage title="Vendor terms" updated="12 November 2026"
      draftNote={`DRAFT ${VENDOR_TERMS_VERSION}: not legal advice. A lawyer must review these terms before any kitchen outside the pilot uses the software.`}>
      <Section id="parties" title="1. Who these terms are between">
        <p>
          These terms are between <strong>{OPERATOR.name}</strong> ({OPERATOR.address}), trading as {OPERATOR.brand} (“we”), and the
          person who creates a kitchen in the software and every business they run through it (“you”, “the kitchen”).
          By ticking “I accept” when you set up your kitchen you agree to them for yourself and your kitchen.
        </p>
      </Section>

      <Section id="service" title="2. What we provide">
        <ul>
          <li>Software to run a tiffin service: customers and plans, daily counts and the kitchen sheet, payments and dues, delivery runs and the rider app, stock, printing.</li>
          <li>The software is free for kitchens during the pilot. We will give you at least 30 days’ notice before any fee starts, and you can leave before it does.</li>
          <li>We try to keep the service running every day, but we do not promise it will never be unavailable. Keep a way to reach your customers and riders without the app.</li>
        </ul>
      </Section>

      <Section id="your-customers" title="3. Your customers stay yours">
        <ul>
          <li>The customers you add or import are your customers. We do not contact them for our own purposes and we do not sell or share their data.</li>
          <li>You decide what you collect and why. You confirm that each customer agreed to be contacted about their tiffin service before you add them, and you record how (the app asks).</li>
          <li>For your customers’ personal data you are the <strong>data fiduciary</strong> under India’s Digital Personal Data Protection Act, 2023, and we act as your <strong>data processor</strong> under the <Link href="/legal/dpa" className="text-brand-700 underline">data processing agreement</Link>, which is part of these terms.</li>
        </ul>
      </Section>

      <Section id="your-duties" title="4. What you agree to do">
        <ul>
          <li>Hold a valid FSSAI registration or licence and keep the number in the app up to date. Our team may check the certificate; being checked does not make your kitchen public.</li>
          <li>Give your team only the roles they need (staff see no phone numbers or money; riders see only their own stops) and remove people who leave.</li>
          <li>Keep your login phone number in your own control. Tell us at once if you lose it.</li>
          <li>Charge your customers what you agreed with them, record payments honestly, and refund unused prepaid meals as your own terms say.</li>
          <li>Act on a customer’s request to correct or erase their data (the app has an Erase customer action).</li>
          <li>Not use the software for anything unlawful, to message people who have not agreed to it, or to try to reach another kitchen’s data.</li>
        </ul>
      </Section>

      <Section id="money" title="5. Money">
        <ul>
          <li>Cash, UPI and bank payments you record go straight to you; we never touch them.</li>
          <li>Online payments, platform customers and any commission are not part of the pilot. If they are switched on later, they will be described in a separate written addition you accept first.</li>
        </ul>
      </Section>

      <Section id="ending" title="6. Leaving and suspension">
        <ul>
          <li>You can stop using the software at any time. Ask us for an export of your data first; we keep it for 30 days after you leave and then delete or anonymise it, except records the law requires us to keep.</li>
          <li>We may suspend a kitchen that breaks these terms or the law, or puts customers at risk. Except in an emergency we tell you first and give you a chance to fix it.</li>
        </ul>
      </Section>

      <Section id="liability" title="7. Responsibility">
        <ul>
          <li>You are responsible for your food, its safety and delivery. We are responsible for the software.</li>
          <li>[Limitation of liability, indemnity and governing law: to be written by a lawyer. Courts at Bhubaneswar, Odisha are proposed.]</li>
        </ul>
      </Section>

      <Section id="changes" title="8. Changes and contact">
        <p>
          If we change these terms we show the new version in the app and ask you to accept it again before you continue. Questions or
          complaints: {grievanceContact()}.
        </p>
      </Section>
    </LegalPage>
  );
}
