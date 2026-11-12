import { z } from 'zod';
import { decodeSigned, type PendingRequest, pendingSchema } from './pending';
import { signValue } from './signed';

/**
 * What the amount form carries between opening and submitting, in Slack's private_metadata. Signed
 * like a button value, because the submission comes back through the same webhook.
 */

/** Slack refuses private_metadata longer than this. */
export const MAX_MODAL_METADATA_LENGTH = 3000;

export const modalContextSchema = z.object({ pending: pendingSchema, threadId: z.string().max(80), messageId: z.string().max(40) });

export interface ModalContext {
  pending: PendingRequest;
  threadId: string;
  messageId: string;
}

export const encodeModalContext = (context: ModalContext, secret: string): string => signValue('modal', JSON.stringify(context), secret);

export const decodeModalContext = (value: string | undefined, secret: string): ModalContext | null =>
  decodeSigned('modal', value, secret, modalContextSchema, MAX_MODAL_METADATA_LENGTH);
