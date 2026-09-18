import main from '../extensions/index.ts';

/** Test-only consumer of the real package factory. SDK registrations still run. */
export default function(pi: any) {
  const registrations: string[] = [];
  const observer = new Proxy({}, { get(_target, property) {
    if (property === 'registerTool') return (definition: any) => { registrations.push(definition.name); pi.registerTool(definition); };
    const value = Reflect.get(pi, property, pi); return typeof value === 'function' ? value.bind(pi) : value;
  } });
  main(observer as any);
  (globalThis as any)[Symbol.for('threadroom.test.main-registration')] = registrations;
}
