export type QuestionOption = Readonly<{ label: string; description?: string; preview?: string }>;
export type QuestionSpec = Readonly<{
  id: string;
  header?: string;
  question: string;
  context?: string;
  options?: readonly QuestionOption[];
  multiSelect?: boolean;
  plainPreview?: boolean;
  /** Sources that cannot retain notes must not accept them in the presentation. */
  allowNotes?: boolean;
}>;
export type QuestionAnswer = Readonly<{
  questionIndex: number;
  question: string;
  answer?: string;
  selected?: readonly string[];
  optionIndex?: number;
  optionIndices?: readonly number[];
  notes?: string;
  preview?: string;
  /** Position-aligned with selected; null means the option has no preview. */
  previews?: readonly (string | null)[];
  wasCustom?: boolean;
}>;
export type QuestionResult = Readonly<{ answers: readonly QuestionAnswer[]; cancelled: boolean }>;
export type QuestionGroup = Readonly<{
  id: string;
  mode: 'blocking' | 'async';
  questions: readonly QuestionSpec[];
  /** Successful resolution means source persistence, not AI consumption. */
  commit?: (questionId: string, answer: QuestionAnswer) => void | Promise<void>;
  /** A person can release a temporary required lease without withdrawing the
   * original async question. The source settles the waiting consumer. */
  releaseRequirement?: (questionId: string) => void;
}>;

/** A native async question can temporarily become required while a tool waits
 * on the same saved identity. Persistence remains owned by its original source. */
export type AsyncQuestionRequirement = 'answered' | 'detached';
