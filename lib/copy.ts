/** Every sentence Till Inbox shows people, in one place. Names and details pass through plainText. */

import type { Warning } from './requests/understand';
import { plainText } from './slack/text';

export const WARNING_TEXT: Record<Warning, string> = {
  'amount-not-stated': 'The email does not state an amount. Set one before approving.',
  'amount-not-in-email': 'The amount the model read is not written in the email, so it was dropped. Set one before approving.',
  'currency-not-stated': 'The email does not make the currency clear. Set the amount and currency before approving.',
  'several-numbers': 'The email mentions more than one number, so a person types the amount.',
  'amount-not-plain': 'The amount reads as a rate, an estimate, or an old or corrected figure, so a person types the amount.',
  'parts-disagree':
    'The plain-text and formatted versions of this email show different numbers, so a person types the amount. Read the email itself.',
  'amount-over-limit': 'The amount is above the limit for a link. Set a smaller amount, or create the link in Airwallex yourself.',
  'instructions-in-email':
    'This email contains instructions aimed at an assistant. They were ignored, and the amount must be typed in by hand. Read the email itself before you approve.',
  'sender-not-verified': 'The email did not pass DMARC, so it may not come from the address it shows. Check the sender before you approve.',
  'email-clipped': 'The email was long, so only the start was read, and the amount must be typed in by hand.',
  'low-confidence': 'The model was not confident reading this email.',
};

export const COPY = {
  somethingWrong: 'Something went wrong on my side. Try again in a moment.',
  /** When an accepted email could not be processed. Only the time and the provider's id, nothing from the email. */
  unreadEmail: (arrivedAt: Date, emailId: string) =>
    `An email arrived at ${arrivedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC and could not be read. Check the inbox. (Email id: ${plainText(emailId)})`,
  card: {
    title: (who: string) => `Payment link for ${plainText(who)}`,
    from: 'From',
    request: 'For',
    amount: 'Amount',
    amountMissing: 'Not stated',
    mentioned: 'Amounts mentioned',
    due: 'Pay by',
    expiry: 'Link expires',
    expiryValue: (days: number) => `${days} days after approval`,
    senderCheck: 'Sender check',
    senderCheckValue: (verified: boolean) =>
      verified
        ? 'Passed DMARC'
        : 'NOT VERIFIED: did not pass DMARC, so the From address may be forged. Till Inbox will not email this sender.',
    note: (note: string) => `Model note: ${plainText(note)}`,
    draftReply: 'Draft reply (nothing is sent until you choose to)',
    approve: 'Approve',
    editAmount: 'Edit amount',
    setAmount: 'Set amount',
    reject: 'Reject',
    footer: 'Approving creates a single-use Airwallex payment link with your own Airwallex login.',
  },
  notice: {
    title: 'Email that is not a payment request',
    body: (who: string, subject: string, note: string) =>
      `${plainText(who)} wrote "${plainText(subject)}". It doesn't ask how to pay, so I did nothing.${note ? ` ${plainText(note)}` : ''}`,
  },
  modal: {
    title: 'Set the amount',
    submit: 'Save',
    amount: 'Amount',
    currency: 'Currency (three letters)',
    purpose: 'What it is for',
  },
  outcome: {
    approving: (admin: string) => `Approved by ${plainText(admin)}. Creating the payment link.`,
    rejected: (admin: string) => `Rejected by ${plainText(admin)}. Nothing was created.`,
    cancelledNotSent: 'Cancelled: not every admin received this request.',
  },
  thread: {
    amountUpdated: (admin: string, amount: string) => `${plainText(admin)} set the amount to ${amount}.`,
    amountProblem: (problem: string) => `I didn't change the amount. ${problem}`,
    overLimit: (maxAmount: number) =>
      `I didn't create a payment link. The amount is above the limit of ${maxAmount.toLocaleString('en-US')}. Edit the amount, or create the link in Airwallex yourself.`,
    connect: {
      title: 'Connect your Airwallex',
      body: 'Approving creates the payment link with your own Airwallex login. Sign in once, then press Approve again.',
    },
    created: (amount: string, reused: boolean) =>
      reused
        ? `This request already had a payment link for ${amount}, so I used that one instead of making another.`
        : `Created a single-use payment link for ${amount}.`,
    replyHeading: 'Reply to send to the customer. Copy it into your email, or press Send reply.',
    replyHeadingCopyOnly: 'Reply to send to the customer. Copy it into your email. Nothing was sent.',
    notCreated: (problem: string) => `I didn't create a payment link. ${plainText(problem)}`,
    checkPaid: 'Has it been paid?',
    sendReply: 'Send reply',
    sent: (to: string, admin: string) => `${plainText(admin)} sent the reply to ${plainText(to)}.`,
    sendFailed: "I couldn't send the reply. Copy it into your email instead.",
    status: (status: string, active: boolean | null, expiresAt: string | null) => {
      const paid = status === 'PAID' ? 'Paid.' : status === 'UNPAID' ? 'Not paid yet.' : `Status: ${plainText(status)}.`;
      const state = active === false ? ' The link is no longer active.' : '';
      const expiry = expiresAt && status !== 'PAID' ? ` It expires ${expiresAt.slice(0, 10)}.` : '';
      return `${paid}${state}${expiry} (checked in Airwallex just now)`;
    },
    statusNotFound: "I couldn't find this link in Airwallex. Check it in the Airwallex web app.",
  },
  page: {
    connected: 'Airwallex is connected. Go back to Slack and press Approve again.',
    notConnected: 'Airwallex is not connected yet. Try the button in Slack again.',
  },
} as const;
