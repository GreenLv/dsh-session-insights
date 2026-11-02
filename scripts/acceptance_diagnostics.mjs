// Bounded, non-secret classification. Never persist arbitrary exception text,
// stack traces, subprocess output or paths in transportable diagnostics.
export function classifyAcceptanceError(stage,error) {
  const field=(value,pattern,fallback)=>typeof value==='string'&&pattern.test(value)?value:fallback
  return {
    stage:field(stage,/^[a-z][a-z0-9_-]{0,63}$/,'unknown'),
    name:field(error?.name,/^[A-Za-z][A-Za-z0-9_]{0,79}$/,'Error'),
    code:field(error?.code,/^[A-Za-z0-9_]{1,64}$/,null),
  }
}
