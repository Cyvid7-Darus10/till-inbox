import { generateText, Output } from 'ai';
import type { InboundEmail } from '../email/provider';
import { type Extraction, extractionSchema } from '../requests/extraction';
import { extractInstructions } from './instructions';

/**
 * The model's only job: read one email into the extraction schema. It gets no tools, so whatever
 * the email says, the model has nothing to call; and its answer is validated again in code.
 */

export interface ExtractSettings {
  model: string;
  reasoningEffort: 'minimal' | 'low' | 'medium' | 'high';
  companyName: string;
}

export type Extractor = (email: InboundEmail) => Promise<Extraction>;

export function modelExtractor(settings: ExtractSettings): Extractor {
  return async (email) => {
    const { output } = await generateText({
      model: settings.model,
      providerOptions: { openai: { reasoningEffort: settings.reasoningEffort } },
      system: extractInstructions(settings.companyName, new Date().toISOString().slice(0, 10)),
      // JSON keeps the sender's words clearly apart from the instructions above.
      prompt: JSON.stringify({ from_name: email.from.name, subject: email.subject, body: email.text }),
      output: Output.object({ schema: extractionSchema, name: 'payment_request' }),
    });
    return extractionSchema.parse(output);
  };
}
