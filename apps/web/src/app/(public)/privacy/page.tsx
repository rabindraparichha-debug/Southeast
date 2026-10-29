import type { Metadata } from 'next';
import Link from 'next/link';
import { grievanceContact, LegalPage, OPERATOR, Section } from '@/components/legal';

export const metadata: Metadata = {
  title: 'Privacy policy · Tiffin Bhubaneswar',
  description: 'How Tiffin Bhubaneswar collects, uses and protects your personal data.',
};

// Draft written with India's Digital Personal Data Protection Act, 2023 (DPDP) in mind.
// It must be reviewed by a lawyer before launch (docs/SECURITY.md checklist, D-020).
export default function PrivacyPage() {
  const analytics = Boolean(process.env.NEXT_PUBLIC_POSTHOG_KEY);
  return (
    <LegalPage title="Privacy policy" updated="29 October 2026">
      <Section id="summary" title="The short version">
        <ul>
          <li>We run free software that tiffin kitchens in Bhubaneswar use to manage their customers, meals, payments and deliveries, and a website that helps people find a kitchen.</li>
          <li>Your phone number is stored encrypted. Kitchen staff and riders see only the last 4 digits.</li>
          <li>You pay your kitchen directly through Razorpay or in cash/UPI. <strong>We never hold your money.</strong></li>
          <li>We send WhatsApp messages only if you have agreed to receive them, and you can stop them at any time.</li>
          <li>We do not sell your data or show you ads.</li>
        </ul>
      </Section>

      <Section id="who" title="1. Who we are">
        <p>
          This website and the kitchen software are operated by <strong>{OPERATOR.name}</strong> (“we”, “us”), trading as {OPERATOR.brand},{' '}
          {OPERATOR.address}.
        </p>
        <p>
          When you are a customer of a kitchen, that kitchen decides why and how your details are used to serve you meals. Under the DPDP Act the
          kitchen is the <em>data fiduciary</em> for its own customers and we process the data on its behalf. When you use our website to find a
          kitchen or apply as a kitchen owner, we are the data fiduciary for that enquiry.
        </p>
      </Section>

      <Section id="data" title="2. What data we collect">
        <ul>
          <li><strong>Phone number.</strong> Used to identify you and to contact you. It is encrypted at rest and looked up only through a one-way code. Full numbers are visible only to the kitchen owner, to a rider for their current delivery, and to our support team when needed; every such view is logged.</li>
          <li><strong>Name</strong> and preferred language.</li>
          <li><strong>Delivery addresses and locations</strong>, including a map pin if you share one, and your area when you search for a kitchen.</li>
          <li><strong>Meal records:</strong> your plan, meals ordered, skipped and paused, menu choices, diet preference and complaints.</li>
          <li><strong>Payment records:</strong> amounts paid, meals bought, refunds and the payment reference from Razorpay. We never see or store your card, UPI PIN or bank login.</li>
          <li><strong>Delivery proof:</strong> the delivery code you give the rider, or a photo of the delivered tiffin, and the time and GPS location where the rider marked it delivered.</li>
          <li><strong>WhatsApp messages</strong> you send to our platform number or your kitchen through it (for example “skip tomorrow”), and the messages we send you.</li>
          <li><strong>Technical data:</strong> if enabled, crash and error reports (with phone numbers removed) and{analytics ? '' : ', only if we turn it on later,'} anonymous usage analytics such as which pages were visited. These never include your name or phone number.</li>
        </ul>
        <p>For kitchen owners and their team we also store the kitchen profile, FSSAI registration number, staff and rider phone numbers, and the payout account details needed by Razorpay.</p>
      </Section>

      <Section id="why" title="3. Why we use it">
        <ul>
          <li><strong>To run your subscription for your kitchen:</strong> counting meals, planning deliveries, keeping your meal balance and sending your customer page link.</li>
          <li><strong>To take payments:</strong> payments go through Razorpay and settle directly into the kitchen’s own account. We never hold customer money.</li>
          <li><strong>To send WhatsApp updates</strong> (delivery code, low balance, receipts, menu) <strong>only if you opted in.</strong> To stop them, reply <strong>STOP</strong> on WhatsApp (reply UPDATES to turn them back on), tell your kitchen, or write to our grievance officer.</li>
          <li><strong>To match you with a kitchen</strong> when you fill in the “Find a tiffin” form, and to follow up on that enquiry.</li>
          <li><strong>To keep the service safe and working:</strong> preventing misuse, fixing errors, and keeping an audit trail of changes to money and meal records.</li>
          <li><strong>To meet legal duties</strong>, such as tax or consumer-protection rules.</li>
        </ul>
        <p>We rely on your consent (which you give when you sign up or when the kitchen records that you agreed to be contacted) and, where the law allows, on legitimate uses such as completing a service you asked for.</p>
      </Section>

      <Section id="sharing" title="4. Who we share it with">
        <ul>
          <li><strong>Your kitchen</strong> and its team. Staff see names, addresses and diet notes needed for packing, but not phone numbers or payments. <strong>Riders</strong> see only today’s stops, with phone numbers masked; calling a customer from the app is logged.</li>
          <li><strong>Razorpay</strong>, to process payments and refunds.</li>
          <li><strong>Meta (WhatsApp Business Platform)</strong>, to deliver WhatsApp messages.</li>
          <li><strong>Supabase</strong>, which hosts our database, files and servers.</li>
          <li><strong>Sentry</strong> (error reports) and <strong>PostHog</strong> (anonymous analytics), only if enabled, and without phone numbers or names.</li>
          <li>Government or law-enforcement authorities when the law requires it.</li>
        </ul>
        <p>We do not sell or rent personal data. Kitchens cannot see customers of other kitchens.</p>
      </Section>

      <Section id="retention" title="5. How long we keep it">
        <ul>
          <li>Customer details are kept while you are a customer of the kitchen and for as long as the kitchen needs them afterwards for refunds and disputes, unless you ask for erasure.</li>
          <li>Payment, refund and audit records are kept for as long as tax and accounting laws require (generally up to 8 years). When a customer is erased these records stay, but without the name, phone number or address.</li>
          <li>Enquiries from the “Find a tiffin” form that do not become customers are deleted or anonymised after [12 months].</li>
          <li>Delivery photos are kept for [90 days] unless needed for a complaint.</li>
          <li>Backups are overwritten on a rolling basis.</li>
        </ul>
      </Section>

      <Section id="rights" title="6. Your rights">
        <p>Under the DPDP Act you can:</p>
        <ul>
          <li><strong>Access</strong> a summary of the personal data held about you.</li>
          <li><strong>Correct</strong> wrong or incomplete details (you can update your address on your customer page, or ask your kitchen).</li>
          <li><strong>Erase</strong> your data. Use “Ask to delete my data” on your customer page or ask your kitchen; the kitchen uses <em>Erase customer</em> after any active subscription is cancelled and unused meals are refunded.</li>
          <li><strong>Withdraw consent</strong> at any time, for example to WhatsApp updates, by telling your kitchen or our grievance officer. This does not affect what was done before.</li>
          <li><strong>Nominate</strong> someone to exercise these rights if you die or become unable to.</li>
          <li><strong>Complain</strong> to our grievance officer, and if you are not satisfied, to the Data Protection Board of India.</li>
        </ul>
        <p className="rounded-lg bg-ink-50 px-3 py-2 ring-1 ring-ink-100">
          <strong>Grievance officer:</strong> {grievanceContact()}. We acknowledge every request within <strong>48 hours</strong> and aim to resolve it within 30 days.
        </p>
      </Section>

      <Section id="security" title="7. How we protect it">
        <p>Phone numbers are encrypted with keys kept separately from the database. Each kitchen’s data is walled off from every other kitchen. Every change to money, meal counts and customer records is written to an audit log that cannot be edited. Access by our team is limited and logged.</p>
      </Section>

      <Section id="children" title="8. Children">
        <p>The service is meant for adults. If a meal plan is for a child, a parent or guardian should sign up and manage it. We do not knowingly collect data from children under 18 without a parent’s consent, and we do not track children or show them targeted content.</p>
      </Section>

      <Section id="changes" title="9. Changes to this policy">
        <p>If we make an important change, we will update this page and tell customers through their kitchen or on WhatsApp (if opted in) before it takes effect. The date at the top shows the latest version.</p>
      </Section>

      <p className="text-sm text-ink-500">
        Questions? Write to the grievance officer above, or read our <Link href="/terms" className="text-brand-700 underline">Terms of use</Link>.
      </p>
    </LegalPage>
  );
}
