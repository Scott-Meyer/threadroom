import { registerNativeAsks } from '../extensions/native/index.ts';

// SDK consumer captures the public source binding. No host/private fields patched.
export default function(pi: any) {
  registerNativeAsks(pi, { presentation: { connect(binding) {
    (globalThis as any)[Symbol.for('threadroom.test.storage-binding')] = binding;
    return { replace() {}, reveal() {}, dispose() {} };
  } } });
}
