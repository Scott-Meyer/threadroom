import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

export type NativeQuestion = Readonly<{ sessionId: string; id: string; toolCallId: string; prompt: Readonly<{ question: string; context?: string; options?: readonly Readonly<{ label: string; preview?: string }>[] }> }>;
export type NativeSavedAnswer = Readonly<{ sessionId: string; questionId: string; answerId: string }>;
export interface NativeQuestionSource {
  /** Authoritative pending projection. Removal is not a consumption receipt. */
  replace(questions: readonly NativeQuestion[]): void;
  reveal(questionId?: string): void;
  dispose(): void;
}
export interface NativeQuestionPresentation {
  connect(binding: {
    context: ExtensionContext;
    sessionId: string;
    activation: number;
    /** Validates original activation/branch and acknowledges persistence only. */
    commit(reply: { questionId: string; text: string; optionIndex?: number }): NativeSavedAnswer;
  }): NativeQuestionSource;
}
