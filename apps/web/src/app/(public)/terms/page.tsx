import type { Metadata } from 'next';
import Link from 'next/link';
import { grievanceContact, LegalPage, OPERATOR, Section } from '@/components/legal';

export const metadata: Metadata = {
  title: 'Terms of use · Tiffin Bhubaneswar',
  description: 'The terms for customers and kitchens using Tiffin Bhubaneswar.',
};

// Draft. Must be reviewed by a lawyer before launch (Consumer Protection Act 2019 and
// E-Commerce Rules 2020 apply to the marketplace side; FSSAI rules apply to the kitchens).
export default function TermsPage() {
  return (
    <LegalPage title="Terms of use" updated="29 October 2026">
      <Section id="summary" title="The short version">
        <ul>
          <li>We provide software. <strong>Your kitchen cooks and delivers your food</strong> and is responsible for it.</li>
          <li>Meals are prepaid with your kitchen and can be used only with that kitchen.</li>
          <li>If you stop, unused meals are refunded at the price you paid. No hidden charges.</li>
          <li>Problems with a meal go to your kitchen first; if they don’t reply within 2 hours, our team steps in.</li>
        </ul>
      </Section>

      <Section id="role" title="1. Who does what">
        <p>
          {OPERATOR.brand} is operated by {OPERATOR.name}, {OPERATOR.address}. We provide free software that independent tiffin kitchens use to run
          their business, and a website that helps customers find a kitchen. We do not cook, pack or deliver food, and we are not a party to the
          meal contract between you and your kitchen.
        </p>
        <p>
          <strong>Each kitchen is responsible</strong> for the food it serves: quality, hygiene, ingredients and allergens, delivery, and holding a
          valid <strong>FSSAI</strong> registration or licence. A kitchen is listed on our website only after its FSSAI number has been recorded,
          and the number is shown on its page. We may remove a kitchen that breaks these terms or the law.
        </p>
      </Section>

      <Section id="account" title="2. Using the service">
        <ul>
          <li>Give a correct phone number and delivery address, and keep your customer page link private: anyone with it can skip or pause your meals.</li>
          <li>Kitchen owners must have the right to contact the customers they add, and must keep their team’s access up to date.</li>
          <li>Don’t misuse the service: no spam, fake enquiries, attempts to access other people’s data, or abusive messages to kitchens or riders.</li>
        </ul>
      </Section>

      <Section id="prepaid" title="3. Prices and prepaid meals">
        <ul>
          <li>Your kitchen sets the price per meal and the plan. You see the price, the number of meals and the total before you pay.</li>
          <li>Payments made online go through Razorpay directly to the kitchen’s account. <strong>We never hold your money.</strong> You can also pay the kitchen in cash or UPI.</li>
          <li>Your prepaid meal balance belongs to your subscription with <strong>that kitchen only</strong>. It cannot be used at, or moved to, another kitchen, and it is not a wallet or stored value with us.</li>
          <li>One prepaid meal is used for each tiffin delivered. Meals you skip or pause <strong>before the kitchen’s cutoff time</strong> are not charged. Skips after the cutoff are charged because the food is already being prepared.</li>
          <li><strong>No hidden charges.</strong> There is no sign-up fee or platform fee for customers. If a kitchen charges for delivery or anything else, it must show it before you pay.</li>
        </ul>
      </Section>

      <Section id="cancel" title="4. Cancellations and refunds">
        <ul>
          <li>You can stop your tiffin at any time by messaging your kitchen. The cancellation takes effect after the kitchen’s notice period (usually 1 day), which is shown in your plan.</li>
          <li>When you cancel, <strong>unused meals are refunded pro-rata</strong>, at the price you actually paid for them. Meals already past their cutoff are charged, not refunded.</li>
          <li>Refunds of online payments go back to the original payment method through Razorpay where possible; otherwise the kitchen refunds you in cash or UPI.</li>
          <li>A trial is a short paid plan; any unused trial meals are refunded the same way.</li>
        </ul>
      </Section>

      <Section id="delivery" title="5. Delivery">
        <p>
          Meals are delivered by the kitchen’s own riders, to the address on your subscription, within the kitchen’s service area. The rider may ask for
          a 4-digit delivery code or take a photo of the delivered tiffin as proof. Reusable tiffin boxes remain the kitchen’s property; please return
          them as agreed with the kitchen.
        </p>
      </Section>

      <Section id="complaints" title="6. Complaints">
        <ul>
          <li>Report a problem (missing meal, quality, late delivery) on your customer page or on WhatsApp. It goes to your kitchen straight away.</li>
          <li>If the kitchen does not reply within <strong>2 hours</strong>, the complaint is escalated to our team.</li>
          <li>For anything else, or if you are not satisfied, contact our grievance officer: {grievanceContact()}. We acknowledge complaints within <strong>48 hours</strong> and aim to resolve them within 30 days.</li>
          <li>You can also approach the consumer commission under the Consumer Protection Act, 2019.</li>
        </ul>
      </Section>

      <Section id="liability" title="7. Our responsibility">
        <p>
          We work hard to keep the software running and your data safe, but we can’t promise it will always be available. We are not responsible for
          the food, its delivery, or the kitchen’s actions, but we will help you reach the kitchen and resolve a complaint. Nothing in these terms
          limits your rights under Indian consumer law.
        </p>
      </Section>

      <Section id="changes" title="8. Changes and law">
        <p>
          We may update these terms; important changes will be announced before they take effect. These terms are governed by the laws of India,
          and the courts at Bhubaneswar, Odisha have jurisdiction. See also our <Link href="/privacy" className="text-brand-700 underline">Privacy policy</Link>.
        </p>
      </Section>
    </LegalPage>
  );
}
