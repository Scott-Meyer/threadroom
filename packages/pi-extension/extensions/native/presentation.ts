import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

export type NativeQuestion = Readonly<{ sessionId: string; id: string; toolCallId: string; prompt: Readonly<{ question: string; header?: string; context?: string; options?: readonly Readonly<{ label: string; description?: string; preview?: string }>[]; multiSelect?: boolean }> }>;
export type NativeSavedAnswer = Readonly<{ sessionId: string; questionId: string; answerId: string }>;
export interface NativeQuestionSource {
  /** Authoritative branch projection. Requiredness is a live wait lease, while
   * answered IDs distinguish successful persistence from source detachment. */
  replace(questions: readonly NativeQuestion[], state?: Readonly<{
    requiredQuestionIds?: readonly string[];
    answeredQuestionIds?: readonly string[];
  }>): void;
  /** Select/display a pending question. Only an explicit person action grants
   * focus intent; bind/navigation/recovery use passive reveal. */
  reveal(questionId?: string, options?: Readonly<{ focus?: boolean }>): boolean | void;
  dispose(): void;
}
export interface NativeQuestionPresentation {
  /** Optional pre-persistence admission for the presentation's public host
   * capabilities. A false result means no new question may be saved. */
  canPresent?(context: ExtensionContext): boolean;
  connect(binding: {
    context: ExtensionContext;
    sessionId: string;
    activation: number;
    /** Validates original activation/branch and acknowledges persistence only. */
    commit(reply: { questionId: string; text: string; optionIndex?: number; optionIndices?: readonly number[] }): NativeSavedAnswer;
    /** Releases only the live required wait; the saved async question remains. */
    cancelWait(questionId: string): void;
  }): NativeQuestionSource;
}
