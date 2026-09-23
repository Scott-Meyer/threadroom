import type { QuestionAnswer, QuestionResult } from './types.ts';

/**
 * Public, versioned description of what a person did with private questions.
 * Observers (advisors, hosts, history views) read this from tool-result or
 * feedback-message `details.humanResponse` instead of Threadroom's internal
 * answer records, which may change shape.
 *
 * `chose` holds AI-authored suggestion labels the person selected; `wrote` and
 * `notes` are text the person typed. `answeredBy` says the response was entered
 * through an interactive host UI; it is not identity verification.
 */
export type HumanResponseV1 = Readonly<{
  version: 1;
  outcome: 'answered' | 'partial' | 'cancelled';
  answeredBy: Readonly<{ kind: 'person'; via: string }>;
  answers: readonly Readonly<{ question: string; chose?: readonly string[]; wrote?: string; notes?: string }>[];
}>;

/** Known `via` values: `pi-tui`, `pi-rpc-dialog`, other `pi-<mode>-dialog`, and `presenter:<id>` (another extension's UI, self-named). */
export function dialogVia(mode: string): string {
  return `pi-${mode}-dialog`;
}

function describe(answer: QuestionAnswer): HumanResponseV1['answers'][number] {
  const chose = answer.selected ?? (!answer.wasCustom && answer.answer !== undefined ? [answer.answer] : undefined);
  return Object.freeze({
    question: answer.question,
    ...(chose?.length ? { chose: Object.freeze([...chose]) } : {}),
    ...(answer.wasCustom && answer.answer ? { wrote: answer.answer } : {}),
    ...(answer.notes ? { notes: answer.notes } : {}),
  });
}

export function humanResponse(result: QuestionResult, questionCount: number, via: string): HumanResponseV1 {
  return Object.freeze({
    version: 1,
    outcome: result.cancelled ? 'cancelled' : result.answers.length >= questionCount ? 'answered' : 'partial',
    answeredBy: Object.freeze({ kind: 'person', via }),
    answers: Object.freeze(result.answers.map(describe)),
  });
}
