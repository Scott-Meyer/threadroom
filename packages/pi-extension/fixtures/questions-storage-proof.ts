import { registerNativeAsks } from '../extensions/native/index.ts';
import { registerBlockingQuestions } from '../extensions/questions/tool.ts';

// SDK consumer captures the public source binding. No host/private fields patched.
export default function(pi: any) {
  const native = registerNativeAsks(pi, { presentation: { connect(binding) {
    (globalThis as any)[Symbol.for('threadroom.test.storage-binding')] = binding;
    return { replace() {}, reveal() {}, dispose() {} };
  } } });
  registerBlockingQuestions(pi, async () => new Promise(() => {}), native.waitForQuestion);
}
