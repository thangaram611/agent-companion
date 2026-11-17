// How every view names a job's model. No imports: the Claude Code mod
// (hooks/mod.ts), which has no Node, uses it as the live view and digest do.

// OpenCode reports models as { providerID, id, variant }; others as strings.
export const modelName = model => model && typeof model === 'object'
  ? [model.providerID, model.id].filter(Boolean).join('/') + (model.variant && model.variant !== 'default' ? `#${model.variant}` : '') || JSON.stringify(model)
  : model;

// The model and effort a job runs on: the result's, else the latest the
// companion reported, else the selection. Raw strings; the caller cleans them.
export function jobModel(execution, result = null) {
  const progress = execution.progress ?? {};
  return [modelName(result?.effectiveModel ?? progress.effectiveModel ?? execution.effectiveModel ?? execution.modelOverride),
    result?.effectiveEffort ?? progress.effectiveEffort ?? execution.effectiveEffort ?? execution.effortOverride].filter(Boolean).map(String);
}
